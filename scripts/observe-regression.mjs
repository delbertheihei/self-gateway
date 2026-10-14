#!/usr/bin/env node
/**
 * SGW 观测与记账回归（M2）。
 *
 * 与 passthrough-regression 的分工：
 *   - passthrough-regression 证明 **H1~H6 透传正确性**（字节不变）
 *   - 本脚本证明 **观测正确性**：usage 提取、契约校验、开关语义、宽限期排空、
 *     聚合恒写、清理策略
 *
 * 关键设计：**同步 recorder**（`quiet` 模式）让写入立即可读，避免定时器导致的时序不确定。
 *
 * 用法：
 *   node scripts/observe-regression.mjs
 *   node scripts/observe-regression.mjs --verbose
 *
 * 退出码：0 = 全绿；1 = 有断言失败
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { start } from '../apps/server/src/index.ts';
import { createLogger } from '../apps/server/src/config/logger.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const VERBOSE = process.argv.includes('--verbose');

const UP_PORT = 18889;
const GW_PORT = 18777;
const TOKEN = 'Bearer sk-observe-regression-0001';

const C = process.stdout.isTTY
  ? { r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', b: '\x1b[36m', d: '\x1b[2m', B: '\x1b[1m', x: '\x1b[0m' }
  : { r: '', g: '', y: '', b: '', d: '', B: '', x: '' };

let pass = 0; let fail = 0;
const failures = [];
const say = (l = '') => console.log(l);
const head = (t) => say(`\n${C.b}── ${t} ${'─'.repeat(Math.max(0, 70 - t.length))}${C.x}`);
function check(label, cond, detail = '') {
  if (cond) { pass++; say(`  ${C.g}✓${C.x} ${label}`); }
  else { fail++; failures.push(label); say(`  ${C.r}✗${C.x} ${label}`); if (detail) say(`      ${C.d}${detail}${C.x}`); }
}
/** 失败时把响应体也打出来，便于定位是 Host / Origin / Token 哪一层拒绝 */
function checkApi(label, res, cond, extra = '') {
  const body = (() => { try { return JSON.parse(res.body.toString('utf8')); } catch { return null; } })();
  const errCode = body?.error?.code ?? body?.notice?.code ?? '';
  if (cond) { pass++; say(`  ${C.g}✓${C.x} ${label}`); }
  else {
    fail++; failures.push(label);
    say(`  ${C.r}✗${C.x} ${label}`);
    say(`      ${C.d}status=${res.status}${errCode ? ` code=${errCode}` : ''} ${extra}${C.x}`);
    const msg = body?.error?.message ?? body?.message;
    if (msg) say(`      ${C.d}message=${msg}${C.x}`);
    if (!msg) say(`      ${C.d}body=${res.body.toString('utf8').slice(0, 200)}${C.x}`);
  }
  return body;
}

// ══════════════════════════ 可控上游 ══════════════════════════

/** 变体：complete / incomplete(缺 total_tokens) / no-usage / gzip-sse / abort-mid / delay-usage */
function createUpstream() {
  let mode = 'complete';
  /** 上游**实际收到**的请求体（用于证明观测没有改写请求字节） */
  const seenBodies = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      seenBodies.push({
        path: req.url,
        bytes: raw.length,
        sha: crypto.createHash('sha256').update(raw).digest('hex'),
      });
      const url = new URL(req.url, `http://127.0.0.1:${UP_PORT}`);
      const kind = mode;
      // 允许用 `?case=xxx` 指定用例 —— 这样测试既能用**真实端点路径**
      // （`/v1/responses`，端点归类为 responses），又能精确挑选响应形态。
      // 原因：本地估算只对 LLM 端点生效（见用例 20），合成路径 `/v1/sse-*` 归类是 other。
      const kase = url.searchParams.get('case');
      const hit = (name) => kase === name || url.pathname.endsWith(`/${name}`);

      const usageComplete = {
        input_tokens: 1234,
        input_tokens_details: { cached_tokens: 1000, cache_write_tokens: 0 },
        output_tokens: 56,
        output_tokens_details: { reasoning_tokens: 12 },
        total_tokens: 1290,
      };
      // ⚠️ 缺 total_tokens —— 这正是会让 Codex 整轮硬失败的结构
      const usageIncomplete = {
        input_tokens: 1234,
        input_tokens_details: { cached_tokens: 1000 },
        output_tokens: 56,
        output_tokens_details: { reasoning_tokens: 12 },
      };

      const respId = `resp_obs_${kind}`;
      const frames = (usage) => [
        `event: response.created\ndata: ${JSON.stringify({ type: 'response.created', sequence_number: 0, response: { id: respId, model: 'gpt-6-luna', status: 'in_progress', usage: null } })}\n\n`,
        `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', sequence_number: 1, delta: '你好 pong' })}\n\n`,
        `event: response.completed\ndata: ${JSON.stringify({
          type: 'response.completed', sequence_number: 2,
          response: {
            id: respId, model: 'gpt-6-luna', status: 'completed',
            output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '你好 pong' }] }],
            ...(usage ? { usage } : {}),
          },
        })}\n\n`,
      ];

      if (hit('sse-complete')) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'rid-complete', 'openai-model': 'gpt-6-luna' });
        res.end(frames(usageComplete).join(''));
        return;
      }
      // ★ 超长 SSE：正文 > 观测上限（512KB），而 usage **只在流末尾的终止事件里**。
      //   旧实现只保留开头 N 字节 → 必然丢掉 usage（实测线上 9/9 条如此）。
      if (hit('sse-huge')) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'rid-huge' });
        res.write(frames(null)[0]);              // response.created（含 model / response.id）
        res.write(frames(null)[1]);              // 第一个 delta
        const filler = `${'填充文本'.repeat(60)}\n`;   // ≈ 720 字节/帧
        for (let i = 0; i < 900; i++) {          // ≈ 760KB，稳稳超过 512KB
          res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', sequence_number: 10 + i, delta: filler })}\n\n`);
        }
        res.write(frames(usageComplete)[2]);      // ★ 终止事件（usage 在这里）
        res.end();
        return;
      }
      if (hit('sse-incomplete-usage')) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'rid-incomplete' });
        res.end(frames(usageIncomplete).join(''));
        return;
      }
      if (hit('sse-no-usage')) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'rid-nousage' });
        res.end(frames(null).join(''));
        return;
      }
      // ★ 超长 SSE 的 gzip 版本：**原始字节小于上限、解压后远大于上限**。
      //   旧实现按解压后的长度截断开头 → 同样必然丢 usage（终止事件在末尾）。
      if (hit('sse-gzip-huge')) {
        const body = [
          frames(null)[0], frames(null)[1],
          ...Array.from({ length: 900 }, (_, i) =>
            `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', sequence_number: 10 + i, delta: `${'填充文本'.repeat(60)}\n` })}\n\n`),
          frames(usageComplete)[2],
        ].join('');
        const gz = zlib.gzipSync(Buffer.from(body, 'utf8'));
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'content-encoding': 'gzip',
          'content-length': String(gz.length),
          'x-request-id': 'rid-gzip-huge',
        });
        res.end(gz);
        return;
      }
      if (hit('sse-gzip')) {
        const gz = zlib.gzipSync(Buffer.from(frames(usageComplete).join(''), 'utf8'));
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'content-encoding': 'gzip',
          'content-length': String(gz.length),
          'x-request-id': 'rid-gzip',
        });
        res.end(gz);
        return;
      }
      if (hit('json-complete')) {
        const payload = JSON.stringify({
          id: 'resp_json_1', model: 'gpt-6-luna',
          usage: usageComplete,
        });
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': String(Buffer.byteLength(payload)),
          'x-request-id': 'rid-json',
        });
        res.end(payload);
        return;
      }
      // 非 LLM 端点（模拟线上真实存在的 /v1/alpha/search）：200 + JSON，**永远没有 usage**
      if (url.pathname === '/v1/alpha/search') {
        const payload = JSON.stringify({ status: 'ok', results: [{ title: 'x', url: 'https://example.com' }] });
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': String(Buffer.byteLength(payload)),
          'x-request-id': 'rid-alpha',
        });
        res.end(payload);
        return;
      }
      // 200 JSON 但**没有 usage**（非流式）：用于验证"成功请求仍可估算兜底"
      if (hit('json-no-usage')) {
        const payload = JSON.stringify({ id: 'resp_json_2', model: 'gpt-6-luna', output: [] });
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': String(Buffer.byteLength(payload)),
          'x-request-id': 'rid-json-nousage',
        });
        res.end(payload);
        return;
      }
      // 慢速：先 delta，再等 delayMs 才发 completed —— 用于宽限期排空测试
      if (hit('sse-slow-usage')) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'rid-slow' });
        res.write(frames(null)[0]);
        res.write(frames(null)[1]);
        setTimeout(() => {
          if (!res.writableEnded) res.end(frames(usageComplete)[2]);
        }, 600);
        return;
      }
      res.writeHead(404); res.end('unknown');
    });
  });
  return {
    server,
    seenBodies,
    setMode(m) { mode = m; },
    getMode() { return mode; },
  };
}

// ══════════════════════════ HTTP 助手 ══════════════════════════

function request({ port, method = 'GET', path: p, headers = {}, body, timeoutMs = 20_000 }) {
  return new Promise((resolve, reject) => {
    // ★ 必须显式给出 content-length。
    //   否则 Node 会对带 body 的请求使用 `Transfer-Encoding: chunked`，
    //   而这个"非浏览器式"的请求形态会被服务端拒掉 —— 表现为 400 且响应体被截断，
    //   极易误判成服务端 bug（本脚本曾经踩到）。
    //   真实客户端（浏览器 fetch / Codex）都会带 content-length 或合法的 chunked 头。
    const finalHeaders = { ...headers };
    if (body && finalHeaders['content-length'] === undefined && finalHeaders['transfer-encoding'] === undefined) {
      finalHeaders['content-length'] = String(Buffer.byteLength(body));
    }
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: finalHeaders }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, rawHeaders: res.rawHeaders, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('client timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

const json = (r) => { try { return JSON.parse(r.body.toString('utf8')); } catch { return null; } };

// ══════════════════════════ 启动 ══════════════════════════

say(`${C.B}${'═'.repeat(74)}${C.x}`);
say(`${C.B} SGW 观测与记账回归（M2）${C.x}`);
say(`${C.B}${'═'.repeat(74)}${C.x}`);

const upstream = createUpstream();
await new Promise((r) => upstream.server.listen(UP_PORT, '127.0.0.1', r));

const tmpFiles = [];
function writeConfig(name, content) {
  const p = path.join(REPO_ROOT, name);
  fs.writeFileSync(p, content, 'utf8');
  tmpFiles.push(p);
  return p;
}
const dataDir = './.sgw-obs-data';
const cfgFile = writeConfig('.sgw.config.obs.ts', `export default {
  listen: { host: '127.0.0.1', port: ${GW_PORT} },
  upstream: {
    baseUrl: 'http://127.0.0.1:${UP_PORT}/v1',
    pathMode: 'auto', stripPrefix: '/v1', replaceAuth: false, strictSsl: true,
    // ★ 刻意**不**配置 probeModel / probeAuth：上游地址、探针模型、鉴权现在都是
    //   "运行期手动填写"的项，没有内置默认值。用例 15 正是从"还没填"这个真实状态开始测。
    headersTimeoutMs: 10000, keepAlive: true, probeOnStart: false,
  },
  edge: { graceDrainMs: 1500, observeMaxBytes: 524288 },
  security: { requireToken: true },
  logging: { level: '${VERBOSE ? 'debug' : 'fatal'}' },
  dataDir: '${dataDir}',
};
`);

const gw = await start({
  cwd: REPO_ROOT,
  configFile: cfgFile,
  logger: createLogger({ level: VERBOSE ? 'debug' : 'fatal', silent: !VERBOSE }),
  inMemoryDb: true,
  quiet: true,          // 同步 recorder + 关闭后台探针
});

// ★ 控制面（/_sgw/**）需要本地访问令牌；代理面（/v1/**）不需要（ADR-20 作用域铁律）。
const API_TOKEN = gw.tokenGuard.token();
if (!API_TOKEN) {
  console.error('未能取得本地访问令牌，无法测试控制面');
  process.exit(1);
}

// ★ 观测的行为取决于开关。测试要显式建立前置状态，而不是依赖默认值
//   （默认 detailEnabled=false 是**产品设计**：默认不落明细）。
//   默认值本身由"用例 7"单独验证，这里先把明细打开，让其余用例聚焦观测正确性。
gw.recorder.updateSettings({ detailEnabled: true });

const cleanup = async () => {
  try { await gw.close(); } catch { /* ignore */ }
  await new Promise((r) => upstream.server.close(() => r(undefined)));
  for (const f of tmpFiles) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }
  try { fs.rmSync(path.join(REPO_ROOT, dataDir), { recursive: true, force: true }); } catch { /* ignore */ }
};
process.on('SIGINT', () => { void cleanup().then(() => process.exit(1)); });

/** 打向 /v1/** 的请求：刻意**不带**网关令牌，以顺带验证作用域铁律 */
const gwReq = (p, opts = {}) => request({
  port: gw.port,
  path: p,
  ...opts,
  headers: { authorization: TOKEN, 'content-type': 'application/json', originator: 'codex_cli_rs', ...(opts.headers ?? {}) },
});

/** 打向 /_sgw/** 的请求：必须带令牌 + 合法 Host */
const api = (p, opts = {}) => request({
  port: gw.port,
  path: p,
  ...opts,
  headers: {
    host: `127.0.0.1:${gw.port}`,
    'x-gateway-token': API_TOKEN,
    // 浏览器**一定**会为非 GET 请求带上 Origin，因此测试也带上，才与真实路径一致。
    // （Origin 校验是 fail-closed 的：无 Origin 时只放行 GET/HEAD）
    origin: `http://127.0.0.1:${gw.port}`,
    ...(opts.body ? { 'content-type': 'application/json' } : {}),
    ...(opts.headers ?? {}),
  },
});

const events = () => gw.db.all('SELECT * FROM request_event ORDER BY started_at ASC');
const lastEvent = () => { const all = events(); return all[all.length - 1] ?? null; };
const clearEvents = () => {
  gw.db.run('DELETE FROM request_event');
  gw.db.run('DELETE FROM rollup_hourly');
  gw.db.run('DELETE FROM daily_model');
  gw.db.run('DELETE FROM daily_session');
  gw.db.run('DELETE FROM session');
};

const reqBody = JSON.stringify({ model: 'gpt-6-luna', input: [], stream: true });
// 真实 LLM 端点路径（端点归类=responses）：本地估算只对 LLM 端点生效（用例 20）
const EST_PATH = '/v1/responses?case=sse-no-usage';

// ══════════════════════════ 用例 1：usage 提取 ══════════════════════════

head('用例 1 · SSE usage 精确提取 → 落库');

await gwReq('/v1/sse-complete', { method: 'POST', body: reqBody });
let ev = lastEvent();
check('记录了 1 条明细', events().length === 1, `实际 ${events().length} 条`);
// 说明：本脚本用 /sse-complete 这类合成路径，因此端点归类应为 'other'。
//     真实的 /v1/responses 归类在 passthrough-regression 与自检里覆盖。
check('endpoint 归类正确（合成路径 → other）', ev && ev.endpoint === 'other', `实际 ${ev?.endpoint}`);
check('model 从响应中提取', ev && ev.model === 'gpt-6-luna', `实际 ${ev?.model}`);
check('response_id 提取正确', ev && ev.response_id === 'resp_obs_complete', `实际 ${ev?.response_id}`);
check('x-request-id 提取正确（Codex 唯一关联 ID）', ev && ev.upstream_request_id === 'rid-complete', `实际 ${ev?.upstream_request_id}`);
check('usage_source = upstream（精确）', ev && ev.usage_source === 'upstream', `实际 ${ev?.usage_source}`);
check('input_tokens 精确', ev && Number(ev.input_tokens) === 1234, `实际 ${ev?.input_tokens}`);
check('output_tokens 精确', ev && Number(ev.output_tokens) === 56, `实际 ${ev?.output_tokens}`);
check('total_tokens 精确', ev && Number(ev.total_tokens) === 1290, `实际 ${ev?.total_tokens}`);
check('cached_tokens 精确', ev && Number(ev.cached_tokens) === 1000, `实际 ${ev?.cached_tokens}`);
check('reasoning_tokens 精确', ev && Number(ev.reasoning_tokens) === 12, `实际 ${ev?.reasoning_tokens}`);
check('usage_complete = 1（字段齐全 → Codex 不会失败）', ev && Number(ev.usage_complete) === 1);
check('记录了 Codex 身份头 originator', ev && ev.codex_originator === 'codex_cli_rs', `实际 ${ev?.codex_originator}`);
check('记录了 key 指纹（不存明文 Authorization）',
  ev && typeof ev.key_fingerprint === 'string' && ev.key_fingerprint.length === 8,
  `实际 ${ev?.key_fingerprint}`);
check('响应体字节数 > 0', ev && Number(ev.bytes_out) > 0, `实际 ${ev?.bytes_out}`);
check('TTFB 已记录', ev && ev.t_upstream_headers !== null, `实际 ${ev?.t_upstream_headers}`);

// ══════════════════════════ 用例 2：契约告警 ══════════════════════════

head('用例 2 · 上游 usage 缺 total_tokens → 必须标记不完整（但字节原样转发）');

clearEvents();
const incRes = await gwReq('/v1/sse-incomplete-usage', { method: 'POST', body: reqBody });
ev = lastEvent();
check('响应仍为 200（网关不因上游结构问题而失败）', incRes.status === 200, `实际 ${incRes.status}`);
check('响应体包含原本的 usage（未被网关改动）',
  incRes.body.toString('utf8').includes('"input_tokens":1234'));
check('usage_complete = 0（标记为不完整）', ev && Number(ev.usage_complete) === 0, `实际 ${ev?.usage_complete}`);
check('usage_source 仍为 upstream', ev && ev.usage_source === 'upstream', `实际 ${ev?.usage_source}`);
// health 的 usageContract 由运行期告警回调填充
const hres = await api('/_sgw/api/health');
const h = json(hres)?.usageContract;
check('health 暴露了 usageContract 不完整状态',
  h?.complete === false && Array.isArray(h?.missingFields) && h.missingFields.length > 0,
  `complete=${h?.complete} missing=[${(h?.missingFields ?? []).join(',')}]`);
check('告警精确指出缺失字段（用户要拿它去问中继管理员）',
  (h?.missingFields ?? []).some((f) => f.includes('total_tokens')),
  `missing=[${(h?.missingFields ?? []).join(', ')}]`);

// ══════════════════════════ 用例 3：无 usage → 估算 ══════════════════════════

head('用例 3 · 上游不返回 usage → 本地估算并标记 source=estimated');

clearEvents();
await gwReq(EST_PATH, { method: 'POST', body: reqBody });
ev = lastEvent();
check('usage_source = estimated', ev && ev.usage_source === 'estimated', `实际 ${ev?.usage_source}`);
check('estimator = heuristic', ev && ev.estimator === 'heuristic', `实际 ${ev?.estimator}`);
check('估算出非零 total_tokens', ev && Number(ev.total_tokens) > 0, `实际 ${ev?.total_tokens}`);
check('估算值来自请求体+响应文本（合理区间 5~200）',
  ev && Number(ev.total_tokens) >= 5 && Number(ev.total_tokens) <= 200,
  `实际 ${ev?.total_tokens}`);

// ══════════════════════════ 用例 4：gzip 观测 ══════════════════════════

head('用例 4 · 上游 gzip 压缩 SSE → 转发原样、旁路解压后仍能取 usage');

clearEvents();
const gzRes = await gwReq('/v1/sse-gzip', { method: 'POST', body: reqBody });
ev = lastEvent();
let canGunzip = false;
try { zlib.gunzipSync(gzRes.body); canGunzip = true; } catch { /* ignore */ }
check('客户端收到的是原始压缩字节（可 gunzip）', canGunzip);
check('未解压转发（body 不含明文 event:）', !gzRes.body.toString('utf8').includes('event:'));
check('旁路解压后仍提取到精确 usage', ev && Number(ev.total_tokens) === 1290,
  `实际 total=${ev?.total_tokens} source=${ev?.usage_source}`);
check('usage_source = upstream', ev && ev.usage_source === 'upstream', `实际 ${ev?.usage_source}`);

// ══════════════════════════ 用例 5：非流式 JSON ══════════════════════════

head('用例 5 · 非流式 JSON 响应 → usage 提取');

clearEvents();
await gwReq('/v1/json-complete', { method: 'POST', body: reqBody });
ev = lastEvent();
check('usage_source = upstream', ev && ev.usage_source === 'upstream', `实际 ${ev?.usage_source}`);
check('total_tokens = 1290', ev && Number(ev.total_tokens) === 1290, `实际 ${ev?.total_tokens}`);
check('response_id 从 JSON 提取', ev && ev.response_id === 'resp_json_1', `实际 ${ev?.response_id}`);
check('streamed = 0（非 SSE）', ev && Number(ev.streamed) === 0, `实际 ${ev?.streamed}`);

// ══════════════════════════ 用例 6：宽限期排空 ══════════════════════════

head('用例 6 · 客户端中断后宽限期排空 → 仍能记到 usage（ADR-15）');

clearEvents();
let abortedAt = 0;
await new Promise((resolve) => {
  const req = http.request({
    host: '127.0.0.1', port: gw.port, method: 'POST', path: '/v1/sse-slow-usage',
    headers: { authorization: TOKEN, 'content-type': 'application/json', originator: 'codex_cli_rs' },
  }, (res) => {
    res.once('data', () => {
      // 收到第一个 delta 后立刻断开 —— 模拟用户按 Esc
      abortedAt = Date.now();
      req.destroy();
      resolve(undefined);
    });
    res.on('error', () => resolve(undefined));
  });
  req.on('error', () => resolve(undefined));
  req.write(reqBody);
  req.end();
});

// 上游在断开后 600ms 才发终止事件；等待它 + 留足余量（宽限期 1500ms）
await new Promise((r) => setTimeout(r, 2_500));
const waitedMs = Date.now() - abortedAt;
ev = lastEvent();
check('中断的请求仍然产生了明细记录', ev !== null, `实际 ${events().length} 条`);
check('★ 中断后仍记到了精确 usage（total=1290）', ev && Number(ev.total_tokens) === 1290,
  `实际 total=${ev?.total_tokens} source=${ev?.usage_source}（等待了 ${waitedMs}ms）`);
check('usage_source = upstream（说明等到了终止事件，而不是退化成估算）',
  ev && ev.usage_source === 'upstream', `实际 ${ev?.usage_source}`);
check('记录耗时 ≥ 上游的 600ms 延迟（证明真的等待了，而非提前结束）',
  ev && Number(ev.t_total) >= 500, `实际 t_total=${ev?.t_total}ms`);

// ══════════════════════════ 用例 7：开关语义 ══════════════════════════

head('用例 7 · Detail/Body 开关语义（关明细仍留聚合 —— 核心设计）');

// 说明：默认值（false）是产品设计，但前面的用例已把明细打开。
// 这里显式复位，再验证"关明细不掉聚合"这一核心行为。
gw.recorder.updateSettings({ detailEnabled: false, bodyEnabled: false });
check('可热关明细（无需重启）', gw.recorder.settings().detailEnabled === false);

clearEvents();
const before = events().length;
await gwReq('/v1/sse-complete', { method: 'POST', body: reqBody });
check('关明细时不写 request_event', events().length === before, `实际 ${events().length} 条`);

// 聚合表必须仍在增长（这是本方案的关键：关明细不掉 KPI）
const rollup = gw.db.all('SELECT * FROM rollup_hourly');
const dailyModel = gw.db.all('SELECT * FROM daily_model');
check('★ 关明细时 rollup_hourly 仍在写入（KPI 不会归零）', rollup.length > 0, `行数 ${rollup.length}`);
check('★ 关明细时 daily_model 仍在写入', dailyModel.length > 0, `行数 ${dailyModel.length}`);
const totalTokensInRollup = rollup.reduce((n, r) => n + Number(r.total_tokens), 0);
check('聚合里的 token 数与请求一致（1290）', totalTokensInRollup >= 1290, `实际 ${totalTokensInRollup}`);

// 打开明细
gw.recorder.updateSettings({ detailEnabled: true });
check('可热开明细（无需重启）', gw.recorder.settings().detailEnabled === true);
clearEvents();
await gwReq('/v1/sse-complete', { method: 'POST', body: reqBody });
check('开明细后写入 request_event', events().length === 1, `实际 ${events().length} 条`);

// 正文开关依赖明细：关明细时开正文必须被拒绝（否则正文无处关联）
clearEvents();
gw.recorder.updateSettings({ detailEnabled: false, bodyEnabled: false });
check('前置：已关闭明细', gw.recorder.settings().detailEnabled === false);
const patchRes = await api('/_sgw/api/settings', {
  method: 'PATCH',
  body: JSON.stringify({ logging: { bodyEnabled: true } }),
});
const patchBody = (() => { try { return JSON.parse(patchRes.body.toString('utf8')); } catch { return null; } })();
checkApi('正文开关依赖明细：单独开正文应被明确拒绝（400）', patchRes, patchRes.status === 400,
  `body=${JSON.stringify(patchBody)?.slice(0, 160)}`);
check('拒绝后 bodyEnabled 仍为 false（未产生矛盾状态）',
  gw.recorder.settings().bodyEnabled === false, `实际 ${gw.recorder.settings().bodyEnabled}`);
check('错误信息可读（告诉用户该怎么做）',
  typeof patchBody?.error?.message === 'string' && patchBody.error.message.length > 0,
  `message=${patchBody?.error?.message}`);

// 明细与正文同时开启应当成功
const okPatch = await api('/_sgw/api/settings', {
  method: 'PATCH',
  body: JSON.stringify({ logging: { detailEnabled: true, bodyEnabled: true } }),
});
check('同时开启明细与正文应当成功', okPatch.status === 200, `实际 ${okPatch.status}`);
check('开关状态已生效', gw.recorder.settings().detailEnabled && gw.recorder.settings().bodyEnabled);
// 复位到"仅明细"以便后续用例
gw.recorder.updateSettings({ detailEnabled: true, bodyEnabled: false });

// ══════════════════════════ 用例 8：统计 API ══════════════════════════

head('用例 8 · 统计 API 与聚合正确性');

clearEvents();
gw.recorder.updateSettings({ detailEnabled: true });
for (let i = 0; i < 3; i++) await gwReq('/v1/sse-complete', { method: 'POST', body: reqBody });

const hdrs = { host: `127.0.0.1:${gw.port}` };
const sres = await api('/_sgw/api/stats/summary?range=24h');
const summary = json(sres)?.data;
check('summary 返回 200', sres.status === 200, `实际 ${sres.status}`);
check('requestCount = 3', summary?.requestCount === 3, `实际 ${summary?.requestCount}`);
check('totalTokens = 3×1290 = 3870', summary?.totalTokens === 3870, `实际 ${summary?.totalTokens}`);
check('latency.p50 有值（直方图分位可用）', typeof summary?.latency?.p50 === 'number' && summary.latency.p50 >= 0,
  `p50=${summary?.latency?.p50} sampleCount=${summary?.latency?.sampleCount}`);
check('latency.buckets 非空', Array.isArray(summary?.latency?.buckets) && summary.latency.buckets.length === 24,
  `桶数 ${summary?.latency?.buckets?.length}`);
check('cacheHitRate 计算正确（1000/1234）',
  summary && Math.abs(summary.cacheHitRate - 1000 / 1234) < 0.001, `实际 ${summary?.cacheHitRate}`);

const mres = await api('/_sgw/api/stats/by-model?range=24h');
const models = json(mres)?.data;
check('by-model 返回 gpt-6-luna', Array.isArray(models) && models.some((m) => m.model === 'gpt-6-luna'),
  `实际 ${JSON.stringify(models?.map((m) => m.model))}`);
check('by-model 的 share 合计约为 1',
  Array.isArray(models) && Math.abs(models.reduce((n, m) => n + m.share, 0) - 1) < 0.01,
  `合计 ${models?.reduce((n, m) => n + m.share, 0)}`);

const tres = await api('/_sgw/api/stats/timeseries?range=24h&bucket=hour');
const series = json(tres)?.data;
check('timeseries 返回数组', Array.isArray(series), `实际类型 ${typeof series}`);
check('timeseries 桶已补齐（24 小时）', Array.isArray(series) && series.length >= 24, `长度 ${series?.length}`);
const seriesTotal = Array.isArray(series) ? series.reduce((n, p) => n + p.totalTokens, 0) : 0;
check('timeseries 的 token 合计与 summary 一致', seriesTotal === 3870, `实际 ${seriesTotal}`);

const rres = await api('/_sgw/api/requests?range=24h&limit=10');
const page = json(rres);
check('requests 返回 3 条', page?.data?.length === 3, `实际 ${page?.data?.length}`);
check('requests 分页 meta 完整', page?.meta && 'nextCursor' in page.meta && 'hasMore' in page.meta);

const one = page?.data?.[0];
const dres = await api(`/_sgw/api/requests/${one?.id}`);
check('单条详情返回 200', dres.status === 200, `实际 ${dres.status}`);

// ══════════════════════════ 用例 9：安全与作用域 ══════════════════════════

head('用例 9 · 安全：Host 校验、Token、/v1 作用域隔离');

const noToken = await api('/_sgw/api/meta', { headers: { 'x-gateway-token': '' } });
check('缺 Token 时管理 API 返回 401', noToken.status === 401, `实际 ${noToken.status}`);

const badHost = await request({ port: gw.port, path: '/_sgw/api/meta', headers: { host: 'evil.example.com' } });
check('恶意 Host 返回 403（反 DNS Rebinding）', badHost.status === 403, `实际 ${badHost.status}`);

// ★ /v1/** 绝不受这些校验影响
const proxyRes = await gwReq('/v1/sse-complete', {
  method: 'POST', body: reqBody, headers: { host: 'evil.example.com' },
});
check('★ /v1/** 用恶意 Host 仍可正常代理（作用域铁律 / ADR-20）',
  proxyRes.status === 200, `实际 ${proxyRes.status}`);

const proxyNoToken = await request({
  port: gw.port, method: 'POST', path: '/v1/sse-complete',
  headers: { authorization: 'Bearer anything', 'content-type': 'application/json' },
  body: reqBody,
});
check('★ /v1/** 不需要网关 Token', proxyNoToken.status === 200, `实际 ${proxyNoToken.status}`);

// ══════════════════════════ 用例 10：清理与保留 ══════════════════════════

head('用例 10 · 保留策略与清理（聚合必须保留）');

clearEvents();
for (let i = 0; i < 2; i++) await gwReq('/v1/sse-complete', { method: 'POST', body: reqBody });
const beforeCleanup = events().length;
check('清理前有明细', beforeCleanup === 2, `实际 ${beforeCleanup}`);

const rollupBefore = gw.db.all('SELECT * FROM daily_model').reduce((n, r) => n + Number(r.total_tokens), 0);
const report = gw.recorder.cleanup();
check('cleanup 返回报告', typeof report?.ranAt === 'number');
check('cleanup 后明细仍在（未超过保留天数）', events().length === 2, `实际 ${events().length}`);
const rollupAfter = gw.db.all('SELECT * FROM daily_model').reduce((n, r) => n + Number(r.total_tokens), 0);
check('★ 清理不影响聚合（KPI 不归零）', rollupAfter >= rollupBefore, `${rollupBefore} → ${rollupAfter}`);

// 手动清空明细 → 聚合仍在
const purge = await api('/_sgw/api/data', {
  method: 'DELETE',
  body: JSON.stringify({ scope: 'detail' }),
});
checkApi('DELETE /data 返回 200', purge, purge.status === 200);
check('清空明细后 request_event 为空', events().length === 0, `实际 ${events().length}`);
const rollupAfterPurge = gw.db.all('SELECT * FROM daily_model').reduce((n, r) => n + Number(r.total_tokens), 0);
check('★ 清空明细后聚合仍在（这是"关明细不掉 KPI"的强验证）', rollupAfterPurge > 0, `实际 ${rollupAfterPurge}`);

// ══════════════════════════ 用例 11：自检端点 ══════════════════════════

head('用例 11 · 透传自检端点（POST /_sgw/api/selftest）');

const stRes = await api('/_sgw/api/selftest', { method: 'POST', body: '{}' });
checkApi('自检返回 200', stRes, stRes.status === 200);
const st = json(stRes)?.data;
check('自检无失败项', st?.failed === 0, `failed=${st?.failed}：${st?.checks?.filter((c) => !c.ok).map((c) => c.name).join('；')}`);
check('自检覆盖 ≥ 15 项', (st?.passed ?? 0) + (st?.failed ?? 0) >= 15, `实际 ${(st?.passed ?? 0) + (st?.failed ?? 0)} 项`);
if (VERBOSE && st?.checks) {
  for (const c of st.checks) say(`      ${c.ok ? C.g + '✓' : C.r + '✗'}${C.x} [${c.group}] ${c.name} — ${C.d}${c.detail}${C.x}`);
}

// ══════════════════════════ 用例 12：透传仍未被破坏 ══════════════════════════

head('用例 12 · 关键回归：观测不得改变转发字节');

clearEvents();
const upRes = await gwReq('/v1/sse-gzip', { method: 'POST', body: reqBody });
const directGz = await new Promise((resolve, reject) => {
  const req = http.request({
    host: '127.0.0.1', port: UP_PORT, method: 'POST', path: '/v1/sse-gzip',
    headers: { authorization: TOKEN, 'content-type': 'application/json' },
  }, (res) => {
    const cs = []; res.on('data', (c) => cs.push(c));
    res.on('end', () => resolve(Buffer.concat(cs)));
  });
  req.on('error', reject); req.write(reqBody); req.end();
});
// gzip 含时间戳，两次压缩字节可能不同；因此比对**解压后的明文**
const a = zlib.gunzipSync(upRes.body).toString('utf8');
const b = zlib.gunzipSync(directGz).toString('utf8');
check('★ 解压后明文与直连一致（观测未改写响应）', a === b,
  `经网关 ${a.length} 字节 / 直连 ${b.length} 字节`);

// ══════════════════════════ 用例 13：压缩请求体 ══════════════════════════

head('用例 13 · zstd 压缩请求体 —— 落盘必须是明文、估算不得把二进制当文本');

// 真实场景：Codex 用 `Content-Encoding: zstd` 压缩 /responses 的请求体。
// 曾经的症状：详情抽屉里"请求正文"是乱码（落盘存了压缩字节），
// 而返回值正常（上游返回的是明文 SSE）—— 于是被误判成"请求侧编码问题"。
clearEvents();
gw.recorder.updateSettings({ detailEnabled: true, bodyEnabled: true });
check('前置：明细与正文都已开启',
  gw.recorder.settings().detailEnabled && gw.recorder.settings().bodyEnabled);

const zstdObj = {
  model: 'gpt-6-zstd',
  stream: true,
  input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '观测网关'.repeat(40) }] }],
};
const zstdPlain = Buffer.from(JSON.stringify(zstdObj), 'utf8');
const zstdPacked = zlib.zstdCompressSync(zstdPlain);
const zstdSha = crypto.createHash('sha256').update(zstdPacked).digest('hex');

await gwReq('/v1/sse-complete', {
  method: 'POST',
  body: zstdPacked,
  headers: { 'content-encoding': 'zstd' },
});
ev = lastEvent();
check('压缩请求体照常记账', ev !== null && String(ev.path).endsWith('/sse-complete'));
check('usage 仍取上游精确值（1290）', ev && Number(ev.total_tokens) === 1290, `实际 ${ev?.total_tokens}`);
check('未误标为截断（truncated_request = 0）', ev && Number(ev.truncated_request) === 0,
  `实际 ${ev?.truncated_request}（观察说明=${ev?.observe_note}）`);
check('bytes_in 仍是**上线字节数**（压缩态）',
  ev && Number(ev.bytes_in) === zstdPacked.length, `实际 ${ev?.bytes_in} vs ${zstdPacked.length}`);
const seenZstd = upstream.seenBodies.find((s) => s.path.includes('/sse-complete') && s.bytes === zstdPacked.length);
check('★ 上游收到的就是原始压缩字节（观测未改写请求体，H1）',
  seenZstd?.sha === zstdSha, `上游=${seenZstd?.sha?.slice(0, 12)} 发出=${zstdSha.slice(0, 12)}`);

// 落盘副本必须是**解码后的明文** —— 控制面 JSON.parse 能成功，界面才不会显示乱码
const bodyRef = ev?.body_ref;
check('请求正文已落盘（body_ref 非空）', typeof bodyRef === 'string' && bodyRef.length > 0,
  `实际 ${bodyRef}`);
const storedPath = path.join(REPO_ROOT, dataDir, 'bodies', `${bodyRef}.req.json`);
check('落盘文件存在', fs.existsSync(storedPath), storedPath);
const storedRaw = fs.existsSync(storedPath) ? fs.readFileSync(storedPath) : Buffer.alloc(0);
let storedJson = null;
try { storedJson = JSON.parse(storedRaw.toString('utf8')); } catch { /* 保持 null */ }
check('★ 落盘请求正文是可解析的 JSON（不是压缩字节 → 不再是乱码）',
  storedJson !== null, `前 16 字节=${storedRaw.subarray(0, 16).toString('hex')}`);
check('★ 落盘内容与原始请求体一致',
  storedJson !== null && JSON.stringify(storedJson) === JSON.stringify(zstdObj));

// 非法压缩体：观测必须**降级**而不是崩，也不能默默存下一份没人看得懂的字节
clearEvents();
const bogusZstd = Buffer.from('这不是 zstd，只是一段普通文本', 'utf8');
const badRes = await gwReq('/v1/sse-complete', {
  method: 'POST', body: bogusZstd, headers: { 'content-encoding': 'zstd' },
});
const badEv = lastEvent();
check('非法 zstd 请求体仍原样转发（H1/H6：观测失败不影响主链路）',
  badRes.status === 200, `实际 ${badRes.status}`);
check('usage 仍取上游精确值（降级只影响正文）',
  badEv && Number(badEv.total_tokens) === 1290, `实际 ${badEv?.total_tokens}`);
check('★ 解码失败被标记（正文副本不可用，不是"看起来正常其实乱码"）',
  badEv && Number(badEv.truncated_request) === 1, `实际 ${badEv?.truncated_request}`);
check('★ 解码失败写进观测说明（用户能知道为什么正文看不懂）',
  typeof badEv?.observe_note === 'string' && badEv.observe_note.includes('解码失败'),
  `实际 ${badEv?.observe_note}`);

// 估算器：同一份 JSON，明文与 zstd 的估算结果必须完全一致
const noUsageHeaders = { 'content-type': 'application/json' };
clearEvents();
await gwReq(EST_PATH, { method: 'POST', body: zstdPlain, headers: noUsageHeaders });
const estPlain = lastEvent();
await gwReq(EST_PATH, { method: 'POST', body: zstdPacked, headers: { 'content-encoding': 'zstd' } });
const estPacked = lastEvent();
check('两次估算都生效（usage_source = estimated）',
  estPlain?.usage_source === 'estimated' && estPacked?.usage_source === 'estimated',
  `${estPlain?.usage_source} / ${estPacked?.usage_source}`);
check('★ 压缩请求体的估算与明文完全一致（不再把二进制噪声当文本计数）',
  estPlain && estPacked && Number(estPlain.total_tokens) === Number(estPacked.total_tokens)
  && Number(estPacked.total_tokens) > 100,
  `明文=${estPlain?.total_tokens} / zstd=${estPacked?.total_tokens}`);

// 模型名兜底：上游失败且不报模型名时，从**解码后**的请求体里取
clearEvents();
const packedFallback = zlib.zstdCompressSync(
  Buffer.from(JSON.stringify({ model: 'gpt-6-zstd-fallback', input: [] }), 'utf8'),
);
const fbRes = await gwReq('/v1/no-such-endpoint', {
  method: 'POST', body: packedFallback, headers: { 'content-encoding': 'zstd' },
});
const fbEv = lastEvent();
check('上游 404 原样透传（网关不包装）', fbRes.status === 404, `实际 ${fbRes.status}`);
check('★ 失败请求也能从压缩请求体里取到模型名（不再落回 unknown）',
  fbEv?.model === 'gpt-6-zstd-fallback', `实际 ${fbEv?.model}`);

gw.recorder.updateSettings({ detailEnabled: true, bodyEnabled: false });

// ══════════════════════════ 用例 14：会话标签 ══════════════════════════

head('用例 14 · 会话标签：不重名、不拿模型名当标题、关明细也要有会话行');

clearEvents();

// 两个 Codex session-id，前 10 字符**完全相同** —— 这正是真实踩到的歧义场景：
// ULID 前 10 字符只覆盖 48 位毫秒时间戳 + 2 位随机，同一毫秒建立的会话前缀相同。
const SID_A = '01a13882-3c38-7821-8b16-84bbf2e45018';
const SID_B = '01a13882-3f37-7b53-98b9-4cd02b7ff936';
check('前置：两个会话 ID 的前 10 字符相同（歧义场景可复现）',
  SID_A.slice(0, 10) === SID_B.slice(0, 10), `${SID_A.slice(0, 10)} / ${SID_B.slice(0, 10)}`);

await gwReq('/v1/sse-complete', { method: 'POST', body: reqBody, headers: { 'session-id': SID_A } });
await gwReq('/v1/sse-complete', { method: 'POST', body: reqBody, headers: { 'session-id': SID_B } });

const sessRows = gw.db.all('SELECT * FROM session ORDER BY id');
check('两个会话都写进了 session 表', sessRows.length === 2, `实际 ${sessRows.length} 行`);
check('external_id = Codex 的 session-id',
  sessRows.length === 2 && sessRows.every((r) => r.external_id === r.id),
  `实际 ${JSON.stringify(sessRows.map((r) => [r.id, r.external_id]))}`);
check('★ title 不再被写成模型名（模型名不是会话标题）',
  sessRows.every((r) => r.title === null),
  `实际 title=${JSON.stringify(sessRows.map((r) => r.title))}`);

const bsRes = await api('/_sgw/api/stats/by-session?range=24h');
checkApi('by-session 返回 200', bsRes, bsRes.status === 200);
const bySession = json(bsRes)?.data ?? [];
check('by-session 返回两个会话', bySession.length === 2, `实际 ${bySession.length}`);
const labels = bySession.map((s) => s.label);
check('★ 两个会话标签互不相同（不再都叫「未命名会话 · 01a13882-3」）',
  new Set(labels).size === 2, `labels=${JSON.stringify(labels)}`);
check('★ 标签不是模型名', labels.every((l) => !String(l).includes('gpt-6')),
  `labels=${JSON.stringify(labels)}`);
check('标签即 Codex session-id（可直接对着 Codex 日志核对）',
  labels.length === 2 && labels.every((l) => l === SID_A || l === SID_B),
  `labels=${JSON.stringify(labels)}`);

// ★ 关明细后新会话仍必须出现在 session 表 —— 否则标签只能回落到 ID 前缀
gw.recorder.updateSettings({ detailEnabled: false });
const detailRowsBefore = gw.db.all('SELECT id FROM request_event').length;
const SID_C = '01a13899-aaaa-7bbb-8ccc-ddddeeeeffff';
await gwReq('/v1/sse-complete', { method: 'POST', body: reqBody, headers: { 'session-id': SID_C } });
check('关明细时不写新明细（前置成立）',
  gw.db.all('SELECT id FROM request_event').length === detailRowsBefore,
  `前 ${detailRowsBefore} → 后 ${gw.db.all('SELECT id FROM request_event').length}`);
const rowC = gw.db.get('SELECT * FROM session WHERE id = ?', [SID_C]);
check('★ 关明细时聚合仍落 session 行（标签不再退化成 ID 前缀）', rowC !== undefined,
  `session 行数=${gw.db.all('SELECT id FROM session').length}`);
check('关明细时会话计数与 token 正确',
  rowC && Number(rowC.request_count) === 1 && Number(rowC.total_tokens) === 1290,
  `实际 requests=${rowC?.request_count} tokens=${rowC?.total_tokens}`);
const dsRow = gw.db.get('SELECT * FROM daily_session WHERE session_id = ?', [SID_C]);
check('daily_session 与 session 口径一致',
  dsRow && Number(dsRow.request_count) === Number(rowC?.request_count),
  `daily=${dsRow?.request_count} session=${rowC?.request_count}`);
gw.recorder.updateSettings({ detailEnabled: true });

// ══════════════════════════ 用例 15：上游连通性探针 ══════════════════════════

head('用例 15 · POST /api/upstream/test —— 必须给出结果（曾经永久悬挂）');

// 曾经：ControlContext 漏传 agents，探针在 `opts.agents.https` 抛 TypeError，
// 请求永久悬挂、客户端拿不到任何响应，日志里只有一行 unhandledRejection。
const upTest = await api('/_sgw/api/upstream/test', { method: 'POST', body: '{}' });
checkApi('探针端点返回 200（而不是悬挂到超时）', upTest, upTest.status === 200);
const probe = json(upTest)?.data;
check('探针返回结构化结果', typeof probe?.checked === 'boolean' && 'missingFields' in (probe ?? {}),
  `body=${upTest.body.toString('utf8').slice(0, 200)}`);

// ★ 新增（上游设置改为"运行期手动填写"之后）：**没填探针模型就不要瞎发请求**。
//   以前 probeModel 有内置默认值 'gpt-4o-mini'，会拿一个上游可能根本不存在的模型去打中继，
//   返回的 400 会被误读成"中继不支持 usage 契约"。本实例的 sgw.config.ts 刻意不写模型，
//   因此"还没填"就是一个真实可达的状态。
check('未配置探针模型 → 跳过并说明原因（不空跑一次假请求）',
  probe?.checked === false && /未配置探针模型/.test(String(probe?.note)),
  `checked=${probe?.checked} note=${probe?.note}`);

// 从设置页填上模型与鉴权（这就是用户的真实操作路径）→ 探针必须立刻能跑
await api('/_sgw/api/settings', {
  method: 'PATCH',
  body: JSON.stringify({ upstream: { probeModel: 'gpt-6-luna', probeAuth: 'Bearer sk-observe-probe' } }),
});
const upTest2 = await api('/_sgw/api/upstream/test', { method: 'POST', body: '{}' });
const probe2 = json(upTest2)?.data;
check('填上探针模型/鉴权后立即可用（热改）', probe2?.checked === true,
  `checked=${probe2?.checked} note=${probe2?.note}`);
check('探针如实报告上游形态（假上游只返回 404 非 SSE）',
  probe2?.complete === null, `complete=${probe2?.complete} note=${probe2?.note}`);

// 清除 = 回落到配置文件（本实例没写模型）→ 又回到"跳过"
await api('/_sgw/api/settings', { method: 'PATCH', body: JSON.stringify({ upstream: { probeModel: null } }) });
const probe3 = json(await api('/_sgw/api/upstream/test', { method: 'POST', body: '{}' }))?.data;
check('清除探针模型后又回到"跳过"（清除 = 回落配置文件，不是变空值）',
  probe3?.checked === false && /未配置探针模型/.test(String(probe3?.note)),
  `checked=${probe3?.checked} note=${probe3?.note}`);

// 运行期地址优先级：清除后回落到 sgw.config.ts 里的值（本实例给了地址）
await api('/_sgw/api/settings', { method: 'PATCH', body: JSON.stringify({ upstream: { baseUrl: '' } }) });
const settingsFellBack = json(await api('/_sgw/api/settings'))?.data?.upstream;
check('清除运行期地址 = 回落到 sgw.config.ts 的值（不是变空）',
  settingsFellBack?.baseUrl === `http://127.0.0.1:${UP_PORT}/v1`
  && !(settingsFellBack?.overrides ?? []).includes('baseUrl'),
  `baseUrl=${settingsFellBack?.baseUrl} overrides=${JSON.stringify(settingsFellBack?.overrides)}`);
check('配置文件里的值单独可见（configuredBaseUrl 不被热改覆盖）',
  settingsFellBack?.configuredBaseUrl === `http://127.0.0.1:${UP_PORT}/v1`,
  String(settingsFellBack?.configuredBaseUrl));
check('settings 接口不回传密钥明文', !/sk-observe-probe/.test(JSON.stringify(settingsFellBack)));

// ══════════════════════════ 用例 16：失败请求不得产生用量 ══════════════════════════

head('用例 16 · 失败请求（HTTP ≥ 400）不得把请求体估算成 token');

// 真实缺陷复现：Codex 撞上 404 后立刻重试，每次重试的请求体都有 40KB，
// 估算器把它算成 33k input token 写进账本 —— 但模型从未被调用。
// 30 次重试累计 120 万虚假 input（cached 恒为 0），把缓存命中率从 89% 拖到 61%。
clearEvents();
const bigBody = JSON.stringify({
  model: 'gpt-6-luna',
  instructions: 'x'.repeat(20000),
  input: [{ role: 'user', content: '请继续' }],
});
const failRes = await gwReq('/v1/does-not-exist', { method: 'POST', body: bigBody });
check('上游 404 原样透传（网关不包装）', failRes.status === 404, `实际 ${failRes.status}`);
ev = lastEvent();
check('失败请求仍然落明细（请求本身是事实）', ev !== undefined);
check('★ 失败请求不估算 token（usage_source = none）', ev && ev.usage_source === 'none',
  `实际 ${ev?.usage_source}`);
check('★ 失败请求 input_tokens = 0（不再把请求体算成用量）',
  ev && Number(ev.input_tokens) === 0, `实际 ${ev?.input_tokens}`);
check('★ 失败请求 total_tokens = 0', ev && Number(ev.total_tokens) === 0, `实际 ${ev?.total_tokens}`);
check('★ 失败请求成本为 null（没有用量就没有成本）', ev && ev.cost_usd === null, `实际 ${ev?.cost_usd}`);
check('★ 观测说明解释了"为什么是 0"（否则用户以为网关坏了）',
  typeof ev?.observe_note === 'string' && ev.observe_note.includes('失败'),
  `note=${ev?.observe_note}`);
check('请求体字节数仍如实记录（失败请求的体量不是无意义的）',
  ev && Number(ev.bytes_in) > 20000, `实际 ${ev?.bytes_in}`);

// 聚合侧也必须干净：失败请求不能抬高 rollup 的 token
const rollupAfterFail = gw.db.get('SELECT SUM(input_tokens) AS inp FROM rollup_hourly');
check('★ 失败请求不污染小时聚合的 token', Number(rollupAfterFail?.inp ?? 0) === 0,
  `实际 ${rollupAfterFail?.inp}`);

// 成功但上游没给 usage → 仍然允许估算（这是"兜底"，与失败请求有本质区别）
await gwReq(EST_PATH, { method: 'POST', body: reqBody });
ev = lastEvent();
check('成功请求仍允许本地估算兜底（usage_source = estimated）',
  ev && ev.usage_source === 'estimated' && Number(ev.total_tokens) > 0,
  `source=${ev?.usage_source} total=${ev?.total_tokens}`);

// ══════════════════════════ 用例 17：缓存命中率口径 ══════════════════════════

head('用例 17 · 缓存命中率：分母只含"缓存信息可信"的 input');

clearEvents();
// ① 上游给精确 usage（input 1234 / cached 1000）
await gwReq('/v1/sse-complete', { method: 'POST', body: reqBody });
// ② 同一小时内再来一次"无 usage → 本地估算"（cached 未知，不是 0）
await gwReq(EST_PATH, { method: 'POST', body: reqBody });

// 说明：两条请求落在**不同的端点维度**上（other / responses），因此聚合成两行 —— 必须求和
const rollupRow = gw.db.get(`SELECT SUM(input_tokens) AS input_tokens,
    SUM(cache_known_input_tokens) AS cache_known_input_tokens FROM rollup_hourly`);
check('★ 聚合表记录了"缓存信息可信"的 input（cache_known_input_tokens）',
  Number(rollupRow?.cache_known_input_tokens) === 1234,
  `实际 cki=${rollupRow?.cache_known_input_tokens} input=${rollupRow?.input_tokens}`);
check('估算请求的 token 仍计入 input_tokens（token 统计不受影响）',
  Number(rollupRow?.input_tokens) > 1234, `实际 ${rollupRow?.input_tokens}`);

const sres17 = await api('/_sgw/api/stats/summary?range=24h');
const s17 = json(sres17)?.data;
check('★ 命中率 = cached / 可信 input（= 1000/1234，而不是被估算请求拉低）',
  s17 && Math.abs(s17.cacheHitRate - 1000 / 1234) < 0.001,
  `实际 ${s17?.cacheHitRate}（可信分母 ${s17?.cacheKnownInput} / 全部 input ${s17?.inputTokens}）`);
check('summary 暴露了可信分母（界面据此解释口径）', Number(s17?.cacheKnownInput) === 1234,
  `实际 ${s17?.cacheKnownInput}`);

// ══════════════════════════ 用例 18：价格表与成本 ══════════════════════════

head('用例 18 · 默认价格表 + 成本读时计算（改价立刻生效，含历史）');

const seeded = gw.db.all('SELECT * FROM model_price');
check('★ 启动即播种官方默认价格（用户不必从零手填）', seeded.length >= 50, `实际 ${seeded.length} 条`);
const luna = gw.db.get("SELECT * FROM model_price WHERE model = 'gpt-6-luna'");
check('默认表含 gpt-6-luna（1.25/10/0.125 之外的实测值：0.1/0.5/0.01）',
  luna && Number(luna.input_per_mtok) === 0.1 && Number(luna.output_per_mtok) === 0.5
    && Number(luna.cached_per_mtok) === 0.01,
  `实际 ${JSON.stringify(luna)}`);

const metaRes = await api('/_sgw/api/meta');
const metaBody = json(metaRes)?.data;
check('meta 暴露价格来源（界面展示"默认值从哪来"）',
  typeof metaBody?.priceSource?.url === 'string' && metaBody.priceSource.url.includes('openai'),
  `实际 ${JSON.stringify(metaBody?.priceSource)}`);
check('meta 列出"本机出现过但未定价"的模型（界面据此提示补价格）',
  Array.isArray(metaBody?.unpricedModels), `实际 ${JSON.stringify(metaBody?.unpricedModels)}`);

// 成本按当前价格表**读时**算：先算出基准，再改价，历史区间必须跟着变
clearEvents();
await gwReq('/v1/sse-complete', { method: 'POST', body: reqBody });   // input 1234 / cached 1000 / output 56
const sumA = json(await api('/_sgw/api/stats/summary?range=24h'))?.data;
check('有价格时成本为正值（不再是 $0.0000?）', Number(sumA?.costUsd) > 0, `实际 ${sumA?.costUsd}`);
check('costKnown = true（区间内模型全都有价格）', sumA?.costKnown === true, `实际 ${sumA?.costKnown}`);
check('unpricedModels 为空', Array.isArray(sumA?.unpricedModels) && sumA.unpricedModels.length === 0,
  `实际 ${JSON.stringify(sumA?.unpricedModels)}`);
// 期望值：未缓存 234 × 0.1/1M + 缓存 1000 × 0.01/1M + 输出 56 × 0.5/1M
const expectA = (234 * 0.1 + 1000 * 0.01 + 56 * 0.5) / 1e6;
check('成本按 token 分项精确计算（未缓存/缓存/输出 分别计价）',
  Math.abs(Number(sumA?.costUsd) - expectA) < 1e-6, `实际 ${sumA?.costUsd} 期望 ${expectA}`);

// 改价 → 历史区间成本立即变化（证明是读时计算，而不是写入时固化）
await api('/_sgw/api/prices', {
  method: 'PUT',
  body: JSON.stringify({ prices: [{ model: 'gpt-6-luna', inputPerMtok: 100, outputPerMtok: 200, cachedPerMtok: 10 }] }),
});
const sumB = json(await api('/_sgw/api/stats/summary?range=24h'))?.data;
check('★ 改价格后历史区间成本立即更新（读时计算，不是写入时固化）',
  Math.abs(Number(sumB?.costUsd) - (234 * 100 + 1000 * 10 + 56 * 200) / 1e6) < 1e-6,
  `改价前 ${sumA?.costUsd} → 改价后 ${sumB?.costUsd}`);

// 缺价格的模型 → 成本"部分已知"，而不是假装 0
await api('/_sgw/api/prices?model=gpt-6-luna', { method: 'DELETE' });
const sumC = json(await api('/_sgw/api/stats/summary?range=24h'))?.data;
check('缺价格时该行确实已被删除',
  gw.db.get("SELECT model FROM model_price WHERE model = 'gpt-6-luna'") === undefined);
check('★ 缺价格时 costKnown = false 且列出缺价模型（不再显示 $0.0000?）',
  sumC?.costKnown === false && (sumC?.unpricedModels ?? []).includes('gpt-6-luna'),
  `costKnown=${sumC?.costKnown} unpriced=${JSON.stringify(sumC?.unpricedModels)}`);
check('缺价格时金额为 0 但 costKnown=false（前端据此显示「—」而不是假数字）',
  Number(sumC?.costUsd) === 0 && sumC?.costKnown === false,
  `cost=${sumC?.costUsd} known=${sumC?.costKnown}`);

// 恢复默认按钮（POST /prices/defaults）只补不覆盖
const restore = await api('/_sgw/api/prices/defaults', { method: 'POST', body: JSON.stringify({ overwrite: false }) });
const restoreBody = json(restore)?.data;
check('POST /prices/defaults 补齐缺失模型（只插不覆盖）',
  restore.status === 200 && Number(restoreBody?.inserted) >= 1,
  `status=${restore.status} inserted=${restoreBody?.inserted}`);
const lunaBack = gw.db.get("SELECT * FROM model_price WHERE model = 'gpt-6-luna'");
check('恢复后 gpt-6-luna 回到官方默认价（0.1/0.5/0.01）',
  lunaBack && Number(lunaBack.input_per_mtok) === 0.1 && Number(lunaBack.cached_per_mtok) === 0.01,
  `实际 ${JSON.stringify(lunaBack)}`);

// 通配与前缀匹配：gpt-6-* 必须能命中 gpt-6-luna
await api('/_sgw/api/prices', {
  method: 'PUT',
  body: JSON.stringify({ prices: [{ model: 'gpt-6-*', inputPerMtok: 7, outputPerMtok: 7, cachedPerMtok: null }] }),
});
await api('/_sgw/api/prices?model=gpt-6-luna', { method: 'DELETE' });
const sumD = json(await api('/_sgw/api/stats/summary?range=24h'))?.data;
check('前缀通配 gpt-6-* 能命中具体模型（自建中继改名场景）',
  Number(sumD?.costUsd) > 0 && sumD?.costKnown === true,
  `cost=${sumD?.costUsd} known=${sumD?.costKnown} unpriced=${JSON.stringify(sumD?.unpricedModels)}`);

// 会话成本也要按模型算（daily_session 有 model 维度）
gw.db.run('DELETE FROM daily_session');
gw.recorder.flush();
await gwReq('/v1/sse-complete', { method: 'POST', body: reqBody, headers: { 'session-id': 'sess-cost-1' } });
const dsRows = gw.db.all('SELECT * FROM daily_session');
check('★ daily_session 按模型细分（会话成本才能读时算准）',
  dsRows.length >= 1 && dsRows.every((r) => typeof r.model === 'string' && r.model !== ''),
  `实际 ${JSON.stringify(dsRows.map((r) => [r.model, r.total_tokens]))}`);
const bsRes18 = await api('/_sgw/api/stats/by-session?range=24h');
const sess18 = (json(bsRes18)?.data ?? [])[0];
check('by-session 返回可判定的成本（costKnown = true）', sess18?.costKnown === true,
  `实际 ${JSON.stringify(sess18 && { cost: sess18.costUsd, known: sess18.costKnown })}`);

// ══════════════════════════ 用例 19：超长响应 ══════════════════════════

head('用例 19 · 超长响应（> 观测上限 512KB）仍必须拿到流末尾的 usage');

// 真实缺陷复现：Responses 的 usage **只存在于流末尾的终止事件**
// （response.completed / response.incomplete），其它事件的 usage 恒为 null。
// 旧实现只保留响应**开头**的 maxBytes 字节 → 超过上限的响应**必然**丢 usage，
// 退化成估算。线上实测：9 条 >512KB 的响应全部是"来源=估算"，
// 而 102 条 ≤462KB 的全部精确 —— 两个集合完全不重叠。
clearEvents();
const hugeRes = await gwReq('/v1/responses?case=sse-huge', { method: 'POST', body: reqBody });
ev = lastEvent();
check('客户端收到完整响应体（>512KB，转发不受观测缓冲影响）',
  hugeRes.body.length > 512 * 1024, `实际 ${hugeRes.body.length} 字节`);
check('端点归类正确（真实 LLM 路径 → responses）', ev && ev.endpoint === 'responses', `实际 ${ev?.endpoint}`);
check('★ 超长响应仍取到上游**精确** usage（尾部缓冲起作用）',
  ev && ev.usage_source === 'upstream', `实际 ${ev?.usage_source}`);
check('★ total_tokens = 1290（精确值，而不是估算）',
  ev && Number(ev.total_tokens) === 1290, `实际 ${ev?.total_tokens}`);
check('★ 缓存分项也保住了（cached_tokens = 1000）',
  ev && Number(ev.cached_tokens) === 1000, `实际 ${ev?.cached_tokens}`);
check('★ 缓存口径照常只认上游（cache_known_input_tokens = 1234）',
  Number(gw.db.get('SELECT SUM(cache_known_input_tokens) AS n FROM rollup_hourly')?.n) === 1234,
  `实际 ${gw.db.get('SELECT SUM(cache_known_input_tokens) AS n FROM rollup_hourly')?.n}`);
check('头部信息仍可用（model / response.id 来自 response.created）',
  ev && ev.model === 'gpt-6-luna' && ev.response_id === 'resp_obs_complete',
  `model=${ev?.model} id=${ev?.response_id}`);
check('如实标记"观测被截断"（truncated_response = 1，不假装观测完整）',
  ev && Number(ev.truncated_response) === 1, `实际 ${ev?.truncated_response}`);
check('★ 观测说明写明了原因（超过上限 + 已分别解析头尾）',
  typeof ev?.observe_note === 'string' && ev.observe_note.includes('超过观测上限'),
  `实际 ${ev?.observe_note}`);
check('bytes_out 如实记录（>512KB）', ev && Number(ev.bytes_out) > 512 * 1024, `实际 ${ev?.bytes_out}`);

// ③ 压缩后解压超限：原始字节 < 512KB（能完整解压），但明文 > 512KB
clearEvents();
const gzHugeRes = await gwReq('/v1/responses?case=sse-gzip-huge', { method: 'POST', body: reqBody });
ev = lastEvent();
check('gzip 超长响应：客户端收到的是原始压缩字节（未解压转发，H3）',
  gzHugeRes.body.subarray(0, 2).toString('hex') === '1f8b', gzHugeRes.body.subarray(0, 2).toString('hex'));
check('gzip 超长响应：原始字节 < 512KB（走的是"解压后超限"分支）',
  ev && Number(ev.bytes_out) < 512 * 1024, `实际 bytes_out=${ev?.bytes_out}`);
check('★ gzip 超长响应仍取到精确 usage（解压后按头/尾切分）',
  ev && ev.usage_source === 'upstream' && Number(ev.total_tokens) === 1290,
  `source=${ev?.usage_source} total=${ev?.total_tokens}`);
check('gzip 超长响应的说明写明"解压后"超限',
  typeof ev?.observe_note === 'string' && ev.observe_note.includes('解压后'),
  `实际 ${ev?.observe_note}`);

// ══════════════════════════ 用例 20：非 LLM 端点 ══════════════════════════

head('用例 20 · 非 LLM 端点不做本地 token 估算（不凭空产生 token）');

// 真实缺陷：中继上的 `/v1/alpha/search` 不是 LLM 调用，响应里也永远没有 usage，
// 但估算器把请求体数成 170~248 个 "input token" 混进了 Token 统计与成本。
clearEvents();
const alphaRes = await gwReq('/v1/alpha/search', { method: 'POST', body: JSON.stringify({ q: '本地搜索请求体' }) });
ev = lastEvent();
check('非 LLM 端点照常转发（200）', alphaRes.status === 200, `实际 ${alphaRes.status}`);
check('端点归类为 other', ev && ev.endpoint === 'other', `实际 ${ev?.endpoint}`);
check('★ 非 LLM 端点不估算 token（usage_source = none）', ev && ev.usage_source === 'none',
  `实际 ${ev?.usage_source}`);
check('★ input / total 均为 0（不再凭空产生 token）',
  ev && Number(ev.input_tokens) === 0 && Number(ev.total_tokens) === 0,
  `实际 in=${ev?.input_tokens} total=${ev?.total_tokens}`);
check('★ 观测说明写明"非 LLM 端点"',
  typeof ev?.observe_note === 'string' && ev.observe_note.includes('非 LLM 端点'),
  `实际 ${ev?.observe_note}`);
check('非 LLM 端点不进入 estimated 计数（聚合保持干净）',
  Number(gw.db.get('SELECT SUM(estimated_count) AS n FROM rollup_hourly')?.n) === 0,
  `实际 ${gw.db.get('SELECT SUM(estimated_count) AS n FROM rollup_hourly')?.n}`);

// 对照：LLM 端点（无 usage 的 200）仍必须估算兜底 —— 这是 ADR-6 的兜底能力，不能一起被砍掉
await gwReq(EST_PATH, { method: 'POST', body: reqBody });
ev = lastEvent();
check('对照：LLM 端点无 usage 时仍估算兜底（usage_source = estimated）',
  ev && ev.usage_source === 'estimated' && Number(ev.total_tokens) > 0,
  `source=${ev?.usage_source} total=${ev?.total_tokens}`);

// ══════════════════════════ 结果 ══════════════════════════

say(`\n${C.B}${'═'.repeat(74)}${C.x}`);
say(`  ${C.g}通过 ${pass}${C.x}    ${fail ? `${C.r}失败 ${fail}${C.x}` : `${C.d}失败 0${C.x}`}`);
if (failures.length) {
  say(`\n${C.r}${C.B}失败项：${C.x}`);
  for (const f of failures) say(`  ${C.r}✗${C.x} ${f}`);
}
say('');
if (fail === 0) say(`${C.g}${C.B}→ M2 观测与记账全部通过。${C.x}`);
else say(`${C.r}${C.B}→ 存在失败项。${C.x}`);

await cleanup();
process.exit(fail === 0 ? 0 : 1);
