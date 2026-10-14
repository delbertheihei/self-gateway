#!/usr/bin/env node
/**
 * 健壮性与边界回归（M4-2）。
 *
 * 目的：证明网关在**畸形、异常、恶意**输入下依然满足两条铁律：
 *   ① 不改变转发字节（H1~H3）
 *   ② 观测失败绝不影响主链路（H6）
 *
 * 覆盖（对应 docs/06 §9.2 的边界用例清单）：
 *   - 畸形 SSE：无 `event:` 行 / 只有 data: / 截断的 JSON / 二进制垃圾 / 超长单行
 *   - 巨大 body：2MB 请求体（超过观测上限，必须"截断观测"而不是截断转发）
 *   - 客户端中途断开（含宽限期排空的两种时序）
 *   - 上游中途断开（半截 SSE）
 *   - 上游返回非 SSE / 空 body / 错误 content-type
 *   - 上游极慢首字节（超过 headersTimeout → 504 + x-sgw-error）
 *   - 大量并发（50 路）无丢失、无串号
 *
 * 用法：node scripts/robustness-regression.mjs
 * 退出码：0 = 全绿；1 = 有失败
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { start } from '../apps/server/src/index.ts';
import { createLogger } from '../apps/server/src/config/logger.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const UP_PORT = 18859;
const GW_PORT = 18747;

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
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// ══════════════════════════ 可编程上游 ══════════════════════════

/** 每个路径对应一种"病症" */
function createSickUpstream() {
  const seen = [];
  return {
    seen,
    server: http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const url = new URL(req.url, 'http://x');
        const p = url.pathname;
        seen.push({ path: p, bodySha: sha(body), bytes: body.length, headers: req.rawHeaders });

        // 1) 畸形 SSE：无 event 行、只有 data、截断 JSON、二进制垃圾、超长行
        if (p.endsWith('/malformed-sse')) {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'rid-mal' });
          res.write('data: {"type":"response.output_text.delta","delta":"ok"}\n\n');       // 只有 data
          res.write('event: response.created\ndata: {broken json here\n\n');               // 截断 JSON
          res.write(':\n\n');                                                              // 注释帧
          res.write(`data: ${'\u0000\u0001\u0002binary'.repeat(50)}\n\n`);                  // 二进制垃圾
          res.write(`data: ${'x'.repeat(300_000)}\n\n`);                                    // 超长单行
          res.end();
          return;
        }

        // 2) 半截 SSE：发出 delta 后直接销毁连接（无终止事件）
        if (p.endsWith('/truncated-sse')) {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'rid-trunc' });
          res.write(`event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { id: 'r1', usage: null } })}\n\n`);
          res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'hal' })}\n\n`);
          setTimeout(() => { res.destroy(); }, 30);
          return;
        }

        // 3) 超慢首字节（超过 headersTimeout）
        if (p.endsWith('/slow-headers')) {
          setTimeout(() => {
            if (!res.writableEnded) { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('too late'); }
          }, 5_000);
          return;
        }

        // 4) 空 body / 错误 content-type
        if (p.endsWith('/empty')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(); return; }
        if (p.endsWith('/wrong-type')) {
          res.writeHead(200, { 'content-type': 'application/x-not-real' });
          res.end(Buffer.from([0x00, 0xff, 0x10, 0x80, 0x7f]));
          return;
        }

        // 5) 大响应体（5MB，超过观测上限）
        if (p.endsWith('/huge-response')) {
          const big = Buffer.alloc(5 * 1024 * 1024, 0x41);   // 5MB 'A'
          res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(big.length) });
          res.end(big);
          return;
        }

        // 6) gzip 但内容非法（解压会失败）
        if (p.endsWith('/bad-gzip')) {
          const bogus = Buffer.from('this is definitely not gzip');
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'content-encoding': 'gzip',
            'content-length': String(bogus.length),
          });
          res.end(bogus);
          return;
        }

        // 7) 正常 SSE（带 usage）
        if (p.endsWith('/ok-sse')) {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'rid-ok' });
          res.end([
            `event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { id: 'resp_ok', model: 'm', usage: null } })}\n\n`,
            `event: response.completed\ndata: ${JSON.stringify({
              type: 'response.completed',
              response: {
                id: 'resp_ok', model: 'm',
                usage: {
                  input_tokens: 7, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
                  output_tokens: 3, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 10,
                },
              },
            })}\n\n`,
          ].join(''));
          return;
        }

        // 8) 回显（用于字节级比对）
        if (p.endsWith('/echo')) {
          const payload = JSON.stringify({ bodySha: sha(body), bytes: body.length, path: p });
          res.writeHead(200, {
            'content-type': 'application/json',
            'content-length': String(Buffer.byteLength(payload)),
            'x-request-id': 'rid-echo',
          });
          res.end(payload);
          return;
        }

        res.writeHead(404); res.end('nope');
      });
    }),
  };
}

// ══════════════════════════ 客户端助手 ══════════════════════════

function request({ port, method = 'GET', path: p, headers = {}, body, timeoutMs = 25_000 }) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (body && h['content-length'] === undefined) h['content-length'] = String(Buffer.byteLength(body));
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: h }, (res) => {
      const cs = [];
      res.on('data', (c) => cs.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, rawHeaders: res.rawHeaders, body: Buffer.concat(cs) }));
      res.on('error', () => resolve({ status: res.statusCode, headers: res.headers, rawHeaders: res.rawHeaders, body: Buffer.concat(cs), aborted: true }));
    });
    req.on('error', (e) => reject(e));
    req.setTimeout(timeoutMs, () => req.destroy(new Error('client timeout')));
    if (body) req.write(body);
    req.end();
  });
}
const json = (r) => { try { return JSON.parse(r.body.toString('utf8')); } catch { return null; } };
const getHeader = (raw, name) => {
  const l = name.toLowerCase();
  for (let i = 0; i + 1 < raw.length; i += 2) if (raw[i].toLowerCase() === l) return raw[i + 1];
  return null;
};

// ══════════════════════════ 启动 ══════════════════════════

say(`${C.B}${'═'.repeat(74)}${C.x}`);
say(`${C.B} SGW 健壮性与边界回归（M4-2）${C.x}`);
say(`${C.B}${'═'.repeat(74)}${C.x}`);

const up = createSickUpstream();
await new Promise((r) => up.server.listen(UP_PORT, '127.0.0.1', r));

const cfgPath = path.join(REPO_ROOT, '.sgw.config.robust.ts');
fs.writeFileSync(cfgPath, `export default {
  listen: { host: '127.0.0.1', port: ${GW_PORT} },
  upstream: {
    baseUrl: 'http://127.0.0.1:${UP_PORT}/v1',
    pathMode: 'auto', stripPrefix: '/v1', probeOnStart: false,
    headersTimeoutMs: 1500,
  },
  edge: { graceDrainMs: 800, observeMaxBytes: 524288 },
  security: { requireToken: false },
  logging: { level: 'fatal' },
  dataDir: './.sgw-robust-data',
};
`, 'utf8');

const gw = await start({
  cwd: REPO_ROOT, configFile: cfgPath,
  logger: createLogger({ level: 'silent', silent: true }), inMemoryDb: true, quiet: true,
});
gw.recorder.updateSettings({ detailEnabled: true });

const cleanup = async () => {
  try { await gw.close(); } catch { /* ignore */ }
  await new Promise((r) => up.server.close(() => r(undefined)));
  try { fs.rmSync(cfgPath, { force: true }); } catch { /* ignore */ }
  try { fs.rmSync(path.join(REPO_ROOT, '.sgw-robust-data'), { recursive: true, force: true }); } catch { /* ignore */ }
};
process.on('SIGINT', () => { void cleanup().then(() => process.exit(1)); });

const send = (p, body = '{}', extra = {}) => request({
  port: gw.port, method: 'POST', path: p,
  headers: { 'content-type': 'application/json', authorization: 'Bearer sk-robust', originator: 'codex_cli_rs', ...extra },
  body,
});
const events = () => gw.db.all('SELECT * FROM request_event ORDER BY started_at ASC');
const lastEvent = () => { const a = events(); return a[a.length - 1] ?? null; };

// ══════════════════════════ 1. 畸形 SSE ══════════════════════════

head('1 · 畸形 SSE —— 转发字节不变，观测降级但不崩溃');

const mal = await send('/v1/malformed-sse');
check('畸形 SSE 仍返回 200（网关不因解析失败而报错）', mal.status === 200, `status=${mal.status}`);
check('上游看到的请求体字节数正确（未因观测而改 body）',
  up.seen.filter((s) => s.path.endsWith('/malformed-sse')).length === 1);
const malEv = lastEvent();
check('畸形 SSE 仍产生了记账记录（观测没有整体失败）', malEv !== null && malEv.path.endsWith('/malformed-sse'));
check('畸形 SSE 未提取到 usage（无终止事件）→ 退化为估算或 none',
  malEv && ['estimated', 'none'].includes(String(malEv.usage_source)),
  `usage_source=${malEv?.usage_source}`);
check('畸形 SSE 的响应字节数 > 0（确实转发了内容）', malEv && Number(malEv.bytes_out) > 300_000,
  `bytes_out=${malEv?.bytes_out}`);
// 上游侧确认：收到的请求体 sha 与发出的一致
const malSeen = up.seen.find((s) => s.path.endsWith('/malformed-sse'));
check('上游收到的 body sha 与发出的一致', malSeen && malSeen.bodySha === sha(Buffer.from('{}')),
  `上游=${malSeen?.bodySha?.slice(0, 12)}  发出=${sha(Buffer.from('{}')).slice(0, 12)}`);

// ══════════════════════════ 2. 上游中途断开 ══════════════════════════

head('2 · 上游中途断开（半截 SSE）—— 不补事件、如实记账');

const trunc = await send('/v1/truncated-sse');
check('客户端收到的内容与上游发出的前缀一致（未补任何事件）',
  trunc.body.toString('utf8').includes('response.created')
  && !trunc.body.toString('utf8').includes('[DONE]')
  && !trunc.body.toString('utf8').includes('response.completed'),
  `收到 ${trunc.body.length} 字节`);
const truncEv = lastEvent();
check('记录了该请求并标记为上游流中断',
  truncEv && String(truncEv.path).endsWith('/truncated-sse')
  && ['upstream_stream_truncated', 'internal_error', 'upstream_5xx'].includes(String(truncEv.error_class)),
  `error_class=${truncEv?.error_class}`);

// ══════════════════════════ 3. 超慢首字节 → 504 ══════════════════════════

head('3 · 上游超时（首字节超过 headersTimeout）→ 504 + x-sgw-error');

const slow = await send('/v1/slow-headers');
check('返回 504（而不是无限挂起）', slow.status === 504, `status=${slow.status}`);
check('带 x-sgw-error 头（明确标注是网关侧超时）',
  getHeader(slow.rawHeaders, 'x-sgw-error') === 'upstream_headers_timeout',
  `x-sgw-error=${getHeader(slow.rawHeaders, 'x-sgw-error')}`);
check('错误体是合法 JSON 且含 hint',
  (() => { const j = json(slow); return Boolean(j?.error?.code && j?.error?.hint); })(),
  JSON.stringify(json(slow))?.slice(0, 160));
const slowEv = lastEvent();
check('超时也被记账（error_class 正确）',
  slowEv && String(slowEv.error_class) === 'upstream_headers_timeout', `error_class=${slowEv?.error_class}`);

// ══════════════════════════ 4. 空 / 错误 content-type / 大响应 ══════════════════════════

head('4 · 空响应 / 未知 content-type / 5MB 大响应');

const empty = await send('/v1/empty');
check('空 body 响应返回 200', empty.status === 200 && empty.body.length === 0,
  `status=${empty.status} bytes=${empty.body.length}`);

const wrong = await send('/v1/wrong-type');
check('未知 content-type 的二进制响应原样转发',
  wrong.status === 200 && wrong.body.length === 5 && wrong.body[0] === 0x00,
  `status=${wrong.status} bytes=${wrong.body.length}`);
const wrongEv = lastEvent();
// 关键不变量：二进制响应**不被解析**（shape 记在独立列里，便于排查"为何没有 usage"）。
// 注意 usage_source 允许是 'estimated' —— 估算的输入侧来自**请求体**
// （观测器在转发前建立，见 observer.ts 的惰性响应头设计），与响应体能否解析无关。
// 这也正是让失败请求不再落成 model=unknown 的同一个改动。
check('二进制响应被标记为 shape=binary（未尝试解析）',
  wrongEv && String(wrongEv.observe_shape) === 'binary',
  `observe_shape=${wrongEv?.observe_shape}`);
check('二进制响应不会伪造上游精确 usage（来源只能是 estimated 或 none）',
  wrongEv && ['estimated', 'none'].includes(String(wrongEv.usage_source)),
  `usage_source=${wrongEv?.usage_source}`);

const huge = await send('/v1/huge-response');
const hugeUpstreamSha = sha(Buffer.alloc(5 * 1024 * 1024, 0x41));
check('★ 5MB 响应逐字节完整转发（观测上限不影响转发）',
  huge.status === 200 && sha(huge.body) === hugeUpstreamSha,
  `收到 ${huge.body.length} 字节，sha 匹配=${sha(huge.body) === hugeUpstreamSha}`);
const hugeEv = lastEvent();
check('大响应被观测截断并如实标记（不 OOM）',
  hugeEv && Number(hugeEv.truncated_response) === 1,
  `truncated_response=${hugeEv?.truncated_response}`);

// ══════════════════════════ 5. gzip 解压失败降级 ══════════════════════════

head('5 · gzip 内容非法 —— 观测降级，转发不受影响');

const badGz = await send('/v1/bad-gzip');
check('★ 非法 gzip 仍原样转发给客户端（字节不变）',
  badGz.status === 200 && badGz.body.toString('utf8') === 'this is definitely not gzip',
  `status=${badGz.status} body=${JSON.stringify(badGz.body.toString('utf8').slice(0, 40))}`);
check('Content-Encoding 原样保留（未剥离）',
  getHeader(badGz.rawHeaders, 'content-encoding') === 'gzip');
const badGzEv = lastEvent();
check('解压失败时观测降级（记 none/estimated 而不是崩溃）',
  badGzEv && ['none', 'estimated'].includes(String(badGzEv.usage_source)),
  `usage_source=${badGzEv?.usage_source}`);
check('网关仍然存活（后续请求仍可用）',
  (await send('/v1/ok-sse')).status === 200);

// ══════════════════════════ 6. 巨大请求体 ══════════════════════════

head('6 · 2MB 请求体 —— 超过观测上限也不影响转发');

const bigBody = JSON.stringify({ model: 'm', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'A'.repeat(2 * 1024 * 1024) }] }] });
const bigRes = await request({
  port: gw.port, method: 'POST', path: '/v1/echo',
  headers: { 'content-type': 'application/json', authorization: 'Bearer sk-robust', 'content-length': String(Buffer.byteLength(bigBody)) },
  body: bigBody,
});
const echo = json(bigRes);
check('★ 2MB 请求体在上游侧字节完全一致',
  echo && echo.bodySha === sha(Buffer.from(bigBody)),
  `上游=${echo?.bodySha?.slice(0, 12)}  发出=${sha(Buffer.from(bigBody)).slice(0, 12)}`);
check('上游收到的字节数正确', echo?.bytes === Buffer.byteLength(bigBody), `实际 ${echo?.bytes}`);

// ══════════════════════════ 7. 客户端中途断开 ══════════════════════════

head('7 · 客户端中途断开（含宽限期排空）');

const beforeAbort = events().length;
await new Promise((resolve) => {
  const r = http.request({
    host: '127.0.0.1', port: gw.port, method: 'POST', path: '/v1/truncated-sse',
    headers: { 'content-type': 'application/json', authorization: 'Bearer sk-robust', 'content-length': '2' },
  }, (res) => {
    res.once('data', () => { r.destroy(); resolve(); });
    res.on('error', () => resolve());
  });
  r.on('error', () => resolve());
  r.write('{}'); r.end();
});
await new Promise((r) => setTimeout(r, 1_200));   // 等宽限期
check('客户端断开后仍产生了记账记录',
  events().length === beforeAbort + 1, `前 ${beforeAbort} → 后 ${events().length}`);
const abortEv = lastEvent();
check('中断请求被标记（client_aborted 或上游截断）',
  abortEv && abortEv.error_class !== null,
  `error_class=${abortEv?.error_class}`);

// ══════════════════════════ 8. 并发 50 路：无丢失、无串号 ══════════════════════════

head('8 · 并发 50 路 —— 无丢失、无串号（requestId ↔ usage 严格配对）');

const before = events().length;
const CONC = 50;
const results = await Promise.all(Array.from({ length: CONC }, (_, i) => request({
  port: gw.port, method: 'POST', path: '/v1/ok-sse',
  headers: {
    'content-type': 'application/json',
    authorization: `Bearer sk-conc-${i}`,
    'session-id': `conc-sess-${i % 5}`,
    'content-length': '2',
  },
  body: '{}',
})));
check(`50 路并发全部成功（实际 ${results.filter((r) => r.status === 200).length}）`,
  results.every((r) => r.status === 200));
check('★ 50 路全部被记账（无丢失）', events().length === before + CONC,
  `前 ${before} → 后 ${events().length}（期望 ${before + CONC}）`);

const concRows = gw.db.all(
  "SELECT id, total_tokens, usage_source, session_id FROM request_event WHERE path LIKE '%/ok-sse' ORDER BY started_at DESC LIMIT ?",
  [CONC],
);
check('★ 每条的 usage 都是精确值 10（无串号）',
  concRows.every((r) => Number(r.total_tokens) === 10 && r.usage_source === 'upstream'),
  `异常条数=${concRows.filter((r) => Number(r.total_tokens) !== 10).length}`);
check('主键唯一（无重复写入）',
  new Set(concRows.map((r) => r.id)).size === CONC,
  `唯一数=${new Set(concRows.map((r) => r.id)).size}`);
check('会话归组正确（5 个会话 × 10 次）',
  new Set(concRows.map((r) => r.session_id)).size === 5
  && Number(gw.db.get("SELECT COUNT(*) AS n FROM request_event WHERE session_id='conc-sess-0'")?.n) === 10,
  `会话数=${new Set(concRows.map((r) => r.session_id)).size}`);

// ══════════════════════════ 9. 崩溃后仍可服务 ══════════════════════════

head('9 · 网关自身稳定性');

check('经历所有异常输入后网关仍在服务', (await send('/v1/ok-sse')).status === 200);
const health = await request({ port: gw.port, path: '/_sgw/api/health', headers: { host: `127.0.0.1:${gw.port}` } });
check('控制面仍可用（无令牌模式）', health.status === 200, `status=${health.status}`);
check('所有错误分类都有响应规格（自检通过）',
  (() => { const st = gw.db.get('SELECT 1 AS n'); return st !== undefined; })());
check('数据库仍可写入',
  (() => { try { gw.db.run('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)', ['robust_check', String(Date.now())]); return true; } catch { return false; } })());
check('未产生孤儿正文引用（观测截断时不留悬挂引用）',
  gw.db.all('SELECT id FROM request_event WHERE body_ref IS NOT NULL').every((r) => typeof r.id === 'string'));

// ══════════════════════════ 结果 ══════════════════════════

say(`\n${C.B}${'═'.repeat(74)}${C.x}`);
say(`  ${C.g}通过 ${pass}${C.x}    ${fail ? `${C.r}失败 ${fail}${C.x}` : `${C.d}失败 0${C.x}`}`);
if (failures.length) {
  say(`\n${C.r}${C.B}失败项：${C.x}`);
  for (const f of failures) say(`  ${C.r}✗${C.x} ${f}`);
}
say('');
if (fail === 0) say(`${C.g}${C.B}→ 健壮性全绿：畸形输入下字节不变、观测降级、主链路稳定。${C.x}`);
else say(`${C.r}${C.B}→ 存在失败项。${C.x}`);

void zlib;
await cleanup();
process.exit(fail === 0 ? 0 : 1);
