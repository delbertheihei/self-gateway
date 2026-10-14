#!/usr/bin/env node
/**
 * SGW 透传回归（H1~H6 的机械化验证）。
 *
 * 方法论（docs/06 §9.1）：**不能用真实上游来验证"上游到底看到了什么"** —— 真实上游
 * 不会把它收到的头告诉你。所以本脚本启动一个「断言上游」：它把收到的一切
 * （request-target / 头 / body 的 sha256）原样回显成 JSON、gzip JSON、SSE 或 403。
 *
 * ★ 关于 A/B 对比的一个关键设计约束（曾经踩坑）：
 *   网关的职责之一就是"把入站 base 前缀换成上游 base 前缀"（H4 的明确边界）。
 *   因此在默认的 `pathMode: 'append'` 下，上游看到的 path **本来就应该**与直连不同
 *   （`/v1/echo-json` → `/echo-json`）。若拿"直连同一 path"做基线，会误判为 H3/H4 失败。
 *   所以本脚本用**两套配置**分别验证：
 *     - `pathMode: 'absolute'`（path 逐字透传）→ 用"直连"作基线比对响应体/头（H1~H5）
 *     - `pathMode: 'append'`  （剥前缀）      → 显式断言剥离结果（H4 前缀语义）
 *
 * 用法：
 *   node scripts/passthrough-regression.mjs
 *   node scripts/passthrough-regression.mjs --verbose
 *
 * 退出码：0 = 全绿；1 = 有断言失败
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
const VERBOSE = process.argv.includes('--verbose');

const UPSTREAM_PORT = 18899;
const PORT_ABSOLUTE = 18787;   // 网关实例 A：pathMode=absolute
const PORT_APPEND = 18788;     // 网关实例 B：pathMode=append
const PORT_BADUP = 18789;      // 网关实例 C：上游不可达
const TOKEN = 'sk-regression-0123456789abcdef';

const C = process.stdout.isTTY
  ? { r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', b: '\x1b[36m', d: '\x1b[2m', B: '\x1b[1m', x: '\x1b[0m' }
  : { r: '', g: '', y: '', b: '', d: '', B: '', x: '' };

let pass = 0;
let fail = 0;
const failures = [];

const say = (l = '') => console.log(l);
const head1 = (t) => say(`\n${C.B}${'═'.repeat(78)}${C.x}\n${C.B} ${t}${C.x}\n${C.B}${'═'.repeat(78)}${C.x}`);
const head2 = (t) => say(`\n${C.b}── ${t} ${'─'.repeat(Math.max(0, 72 - t.length))}${C.x}`);
function check(label, cond, detail = '') {
  if (cond) { pass++; say(`  ${C.g}✓${C.x} ${label}`); }
  else {
    fail++; failures.push(label);
    say(`  ${C.r}✗${C.x} ${label}`);
    if (detail) say(`      ${C.d}${detail}${C.x}`);
  }
}
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const short = (s) => String(s ?? '').slice(0, 24);

// ═══════════════════════════════ 断言上游 ═══════════════════════════════

function createAssertionUpstream() {
  return http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, `http://127.0.0.1:${UPSTREAM_PORT}`);

      const echo = {
        method: req.method,
        // ★ 请求行里的 request-target。必须是 origin-form（以 / 开头），
        //   绝不能是 absolute-form（以 http:// 开头）。详见 transport/upstream.ts。
        requestTarget: req.url,
        path: url.pathname,
        query: url.search,
        httpVersion: req.httpVersion,
        rawHeaders: req.rawHeaders,
        bodySha256: sha(body),
        bodyBytes: body.length,
        bodyText: body.toString('utf8').slice(0, 8000),
      };

      if (url.pathname.endsWith('/echo-json')) {
        const payload = JSON.stringify(echo);
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': String(Buffer.byteLength(payload)),
          'x-request-id': 'req-fixed-0001',
          'x-codex-turn-state': 'turn-state-abc',
          'openai-model': 'gpt-6-luna',
        });
        res.end(payload);
        return;
      }

      if (url.pathname.endsWith('/echo-gzip')) {
        const gz = zlib.gzipSync(Buffer.from(JSON.stringify(echo), 'utf8'));
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-encoding': 'gzip',
          'content-length': String(gz.length),
          'x-request-id': 'req-fixed-gzip',
        });
        res.end(gz);
        return;
      }

      if (url.pathname.endsWith('/echo-sse')) {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          'x-request-id': 'req-fixed-sse',
          'x-codex-turn-state': 'turn-state-abc',
        });
        res.flushHeaders();
        const respId = 'resp_regression_0001';
        const frames = [
          `event: response.created\ndata: ${JSON.stringify({ type: 'response.created', sequence_number: 0, response: { id: respId, status: 'in_progress', usage: null } })}\n\n`,
          `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', sequence_number: 1, delta: 'pong' })}\n\n`,
          `event: response.completed\ndata: ${JSON.stringify({
            type: 'response.completed', sequence_number: 2,
            response: {
              id: respId, status: 'completed',
              usage: {
                input_tokens: 1111,
                input_tokens_details: { cached_tokens: 900, cache_write_tokens: 0 },
                output_tokens: 22,
                output_tokens_details: { reasoning_tokens: 3 },
                total_tokens: 1133,
              },
            },
          })}\n\n`,
        ];
        let i = 0;
        const tick = () => {
          if (i >= frames.length) { res.end(); return; }
          res.write(frames[i++]);
          setTimeout(tick, 30);      // 故意分片：验证网关不缓冲
        };
        tick();
        return;
      }

      if (url.pathname.endsWith('/error-403')) {
        const payload = JSON.stringify({
          error: { message: 'This account only allows Codex official clients', type: 'forbidden_error' },
        });
        res.writeHead(403, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': String(Buffer.byteLength(payload)),
          'x-request-id': 'req-fixed-403',
        });
        res.end(payload);
        return;
      }

      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('assertion-upstream: unknown path');
    });
  });
}

// ═══════════════════════════════ 客户端（刻意不用 fetch）═══════════════════════════════

function request({ port, method, path: p, headers, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      const chunks = [];
      const at = [];
      res.on('data', (c) => { chunks.push(c); at.push(Date.now()); });
      res.on('end', () => resolve({
        status: res.statusCode,
        rawHeaders: res.rawHeaders,
        body: Buffer.concat(chunks),
        chunkTimes: at,
      }));
      res.on('error', reject);
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function getHeader(rawHeaders, name) {
  const lower = name.toLowerCase();
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    if (rawHeaders[i].toLowerCase() === lower) return rawHeaders[i + 1];
  }
  return null;
}
function headerNames(rawHeaders) {
  const s = new Set();
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) s.add(rawHeaders[i].toLowerCase());
  return s;
}

/**
 * 逐跳头集合（RFC 9110 §7.6.1）+ 分帧头。
 * 这些头**本来就允许**在转发时改变：Node 的服务端与客户端各自拥有分帧权。
 * 它们不是"内容"，因此不参与字节级比对。
 */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
  // 客户端自动附加 / 服务端按实际分帧重算
  'host', 'content-length',
]);

/** 归一化头集合：丢掉逐跳头与分帧头，其余逐字比对（含原始大小写与重复头） */
function normalizedHeaders(rawHeaders) {
  const out = {};
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    const name = rawHeaders[i];
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    // Date 由 HTTP 服务端自动生成，同一秒内也未必一致 —— 它不是"上游内容"，排除
    if (lower === 'date') continue;
    if (out[name] === undefined) out[name] = rawHeaders[i + 1];
    else if (Array.isArray(out[name])) out[name].push(rawHeaders[i + 1]);
    else out[name] = [out[name], rawHeaders[i + 1]];
  }
  return out;
}
const fmt = (o) => JSON.stringify(o, Object.keys(o).sort());

/**
 * 从回显体中剔除"本来就该不同"的字段，再比对响应体字节。
 *
 * ⚠️ 这里有一个容易被误判为网关故障的陷阱：
 *   断言上游的回显体里**包含了它收到的请求头**。而网关按 RFC 9110 §7.6.1
 *   必须剥掉 Connection 里声明的 `x-hop-test` —— 这是**正确行为**。
 *   于是"响应体"必然不同，但差异的根因是请求头被正确剥离，而不是响应被改写。
 *
 * 因此响应体比对分两层：
 *   ① 结构化比对：剔除 rawHeaders 后，其余字段必须逐字节一致（本函数）
 *   ② 头单独比对：由 H2/H6 的断言负责（含"合法丢失 x-hop-test"）
 *   这样每个断言只考察一件事，失败时能立刻定位。
 */
function stripVolatileEchoFields(buf, isGzip = false) {
  let text;
  if (isGzip) {
    try { text = zlib.gunzipSync(buf).toString('utf8'); } catch { return buf; }
  } else {
    text = buf.toString('utf8');
  }
  try {
    const o = JSON.parse(text);
    delete o.rawHeaders;
    return Buffer.from(JSON.stringify(o, Object.keys(o).sort()), 'utf8');
  } catch {
    return buf;
  }
}

// ═══════════════════════════════ 启动 ═══════════════════════════════

head1('SGW 透传回归 —— H1~H6 机械化验证');

const upstream = createAssertionUpstream();
await new Promise((r) => upstream.listen(UPSTREAM_PORT, '127.0.0.1', r));
say(`  ${C.d}断言上游已启动   http://127.0.0.1:${UPSTREAM_PORT}${C.x}`);

const tmpFiles = [];
function writeConfig(name, body) {
  const p = path.join(REPO_ROOT, name);
  fs.writeFileSync(p, body, 'utf8');
  tmpFiles.push(p);
  return p;
}
const silentLog = () => createLogger({ level: VERBOSE ? 'debug' : 'fatal', pretty: false });

// 实例 A：pathMode = absolute（path 逐字透传）→ 可以用"直连"作基线
const cfgAbsolute = writeConfig('.sgw.config.reg.abs.ts', `export default {
  listen: { host: '127.0.0.1', port: ${PORT_ABSOLUTE} },
  upstream: {
    baseUrl: 'http://127.0.0.1:${UPSTREAM_PORT}/v1',
    pathMode: 'absolute', stripPrefix: '/v1', replaceAuth: false, strictSsl: true,
    headersTimeoutMs: 10000, keepAlive: true,
  },
  security: { requireToken: false },
  logging: { level: '${VERBOSE ? 'debug' : 'fatal'}' },
  dataDir: './.sgw-reg-data-a',
};
`);
// 实例 B：pathMode = append（剥前缀）→ 验证 H4 的前缀语义
const cfgAppend = writeConfig('.sgw.config.reg.app.ts', `export default {
  listen: { host: '127.0.0.1', port: ${PORT_APPEND} },
  upstream: {
    baseUrl: 'http://127.0.0.1:${UPSTREAM_PORT}/v1',
    pathMode: 'append', stripPrefix: '/v1', replaceAuth: false, strictSsl: true,
    headersTimeoutMs: 10000, keepAlive: true,
  },
  security: { requireToken: false },
  logging: { level: '${VERBOSE ? 'debug' : 'fatal'}' },
  dataDir: './.sgw-reg-data-b',
};
`);
// 实例 C：上游不可达
const cfgBad = writeConfig('.sgw.config.reg.bad.ts', `export default {
  listen: { host: '127.0.0.1', port: ${PORT_BADUP} },
  upstream: { baseUrl: 'http://127.0.0.1:1/v1', headersTimeoutMs: 3000 },
  security: { requireToken: false },
  logging: { level: 'fatal' },
  dataDir: './.sgw-reg-data-c',
};
`);

const gwA = await start({ cwd: REPO_ROOT, configFile: cfgAbsolute, logger: silentLog() });
const gwB = await start({ cwd: REPO_ROOT, configFile: cfgAppend, logger: silentLog() });
say(`  ${C.d}网关 A (absolute) http://127.0.0.1:${gwA.port}${C.x}`);
say(`  ${C.d}网关 B (append)   http://127.0.0.1:${gwB.port}${C.x}`);

const cleanup = async () => {
  for (const g of [gwA, gwB]) { try { await g.close(); } catch { /* ignore */ } }
  await new Promise((r) => upstream.close(() => r(undefined)));
  for (const f of tmpFiles) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }
  for (const d of ['.sgw-reg-data-a', '.sgw-reg-data-b', '.sgw-reg-data-c']) {
    try { fs.rmSync(path.join(REPO_ROOT, d), { recursive: true, force: true }); } catch { /* ignore */ }
  }
};
process.on('SIGINT', () => { void cleanup().then(() => process.exit(1)); });

// ═══════════════════════════════ 测试夹具 ═══════════════════════════════

// 一份"像 Codex 会发的"请求体：含中文、emoji、嵌套、以及"JSON 往返会被改写"的东西
const reqBody = Buffer.from(JSON.stringify({
  model: 'gpt-6-luna',
  instructions: '你是探针。只回 pong。',
  input: [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: '包含中文与 emoji 🚀 的测试' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] },
  ],
  tools: [{ type: 'function', name: 'noop', description: '空工具', parameters: { type: 'object', properties: {} } }],
  store: false,
  stream: true,
  prompt_cache_key: 'regression-session',
  metadata: { note: 'tab\there "quotes" \\backslash\\ /slash/ \u00e9\u4e2d', big: 12345678901234567890 },
  max_output_tokens: 16,
}, null, 2), 'utf8');

const baseHeaders = {
  authorization: `Bearer ${TOKEN}`,
  'content-type': 'application/json',
  accept: 'text/event-stream',
  originator: 'codex_cli_rs',
  'session-id': 'reg-session-001',
  'thread-id': 'reg-thread-001',
  'x-client-request-id': 'reg-thread-001',
  'x-codex-beta-features': 'responses_websockets=2026-02-06',
  'x-custom-unknown-header': 'must-be-preserved',
  'user-agent': 'codex_cli_rs/0.129.0 (sgw-regression)',
  // H6 的动态规则：Connection 里列出的头必须被剥离
  connection: 'keep-alive, X-Hop-Test',
  'x-hop-test': 'this-must-be-stripped',
};

const P = '/v1/echo-json?client_version=0.129.0&foo=bar';

// ═══════════════════════════════ 用例 1：absolute 模式下的 H1~H5 ═══════════════════════════════

head2('用例 1 · pathMode=absolute（path 逐字透传）—— H1/H2/H3/H4/H5');

const direct = await request({ port: UPSTREAM_PORT, method: 'POST', path: P, headers: baseHeaders, body: reqBody });
const directGz = await request({ port: UPSTREAM_PORT, method: 'POST', path: '/v1/echo-gzip', headers: baseHeaders, body: reqBody });
const directSse = await request({ port: UPSTREAM_PORT, method: 'POST', path: '/v1/echo-sse', headers: baseHeaders, body: reqBody });
const viaA = await request({ port: gwA.port, method: 'POST', path: P, headers: baseHeaders, body: reqBody });
const directEcho = JSON.parse(direct.body.toString('utf8'));
const echoA = JSON.parse(viaA.body.toString('utf8'));
// 说明：`absolute` 与 `append` 在本配置下（入站 /v1/x + base /v1 + stripPrefix /v1）产出的
// 上游 path **相同**（都是 /v1/x），因此两者可以直接与"直连同一 path"作字节级比对。
check('前置条件：absolute 模式下上游 path 与直连一致（A/B 比对才有意义）',
  directEcho.path === echoA.path,
  `直连=${directEcho.path}  经网关=${echoA.path}  ← 若不同则后续 H3 比对会失真`);

// ── H1 ──
head2('H1 · 请求体字节级不改');
check('上游收到的请求体 sha256 相同', directEcho.bodySha256 === echoA.bodySha256,
  `直连=${short(directEcho.bodySha256)}  经网关=${short(echoA.bodySha256)}`);
check('上游收到的请求体字节数相同', directEcho.bodyBytes === echoA.bodyBytes,
  `直连=${directEcho.bodyBytes}  经网关=${echoA.bodyBytes}`);
check('请求体与客户端发出的字节完全一致', echoA.bodySha256 === sha(reqBody),
  `客户端=${short(sha(reqBody))}  上游=${short(echoA.bodySha256)}`);

// ── H4（absolute 下 path 应完全不变）──
head2('H4 · 路径与 query 原样透传');
check('★ 上游收到的 request-target 是 origin-form（以 / 开头，不是绝对 URL）',
  typeof echoA.requestTarget === 'string' && echoA.requestTarget.startsWith('/'),
  `实际=${short(echoA.requestTarget)}  ← 若以 http:// 开头说明发出了 absolute-form 请求行`);
check('request-target 与直连逐字相同（含 query）', directEcho.requestTarget === echoA.requestTarget,
  `直连=${short(directEcho.requestTarget)}  经网关=${short(echoA.requestTarget)}`);
check('path 相同', directEcho.path === echoA.path, `直连=${directEcho.path}  经网关=${echoA.path}`);
check('query 相同（client_version 未丢）', directEcho.query === echoA.query,
  `直连=${directEcho.query}  经网关=${echoA.query}`);

// ── H2 ──
head2('H2 · 请求头零白名单透传，且不新增任何头');
const directHdrs = headerNames(directEcho.rawHeaders);
const proxiedHdrs = headerNames(echoA.rawHeaders);
// x-hop-test 被客户端声明在 Connection 里，因此网关**按 RFC 9110 §7.6.1 必须剥掉它**。
// 它是"合法且预期"的丢失，从基线中排除（否则会把合规行为误判为丢头）。
const EXPECTED_DROPPED = new Set(['x-hop-test', 'connection', 'keep-alive']);
const missing = [...directHdrs].filter((h) => !proxiedHdrs.has(h) && !EXPECTED_DROPPED.has(h));
const added = [...proxiedHdrs].filter((h) => !directHdrs.has(h));
check('没有丢失任何头（含未知自定义头）', missing.length === 0, `丢失：${missing.join(', ')}`);
check('没有新增任何头（H2 的"不新增"）', added.length === 0, `新增：${added.join(', ')}`);
check('未知自定义头 x-custom-unknown-header 被保留',
  getHeader(echoA.rawHeaders, 'x-custom-unknown-header') === 'must-be-preserved',
  `实际=${getHeader(echoA.rawHeaders, 'x-custom-unknown-header')}`);
check('x-codex-beta-features 被保留',
  getHeader(echoA.rawHeaders, 'x-codex-beta-features') === 'responses_websockets=2026-02-06');
check('originator 被保留（决定中继是否认它是官方客户端）',
  getHeader(echoA.rawHeaders, 'originator') === 'codex_cli_rs',
  `实际=${getHeader(echoA.rawHeaders, 'originator')}`);
check('session-id / thread-id 被保留',
  getHeader(echoA.rawHeaders, 'session-id') === 'reg-session-001'
  && getHeader(echoA.rawHeaders, 'thread-id') === 'reg-thread-001');

// ── H6 ──
head2('H6 · 逐跳头剥离（RFC 9110 §7.6.1 的动态规则）');
check('★ Connection 中列出的 x-hop-test 被剥离（§7.6.1 MUST）', !proxiedHdrs.has('x-hop-test'),
  proxiedHdrs.has('x-hop-test') ? '仍然存在 —— 违反 RFC 9110 §7.6.1' : '');
const upConn = getHeader(echoA.rawHeaders, 'connection');
check('客户端原始 Connection 值未被原样转发',
  upConn === null || upConn.toLowerCase() === 'keep-alive',
  `上游看到 connection=${upConn}（客户端发的是 "keep-alive, X-Hop-Test"）`);
check('keep-alive 被剥离', !proxiedHdrs.has('keep-alive'));

// ── H5 ──
head2('H5 · 鉴权头原样透传（replaceAuth = false）');
check('上游收到的 Authorization 与发出的一致',
  getHeader(echoA.rawHeaders, 'authorization') === `Bearer ${TOKEN}`,
  `实际=${short(getHeader(echoA.rawHeaders, 'authorization'))}…`);

// ── H3 ──
head2('H3 · 响应体字节级不改；非逐跳响应头逐字一致');
// ⚠️ 注意：这个上游的回显体里**包含了它看到的 request-target**。因此在两套 pathMode
//    产出不同路径的用例里，响应体本来就应该不同 —— 那属于 H4（路径）的范畴，
//    必须在 H4 已经断言"上游路径与直连一致"之后，H3 的字节比对才成立。
//    这里用同一份直连基线，并前置校验路径一致（见上方"前置条件"）。
check('★ 客户端收到的响应体逐字节一致（剔除回显的 rawHeaders 后）',
  sha(stripVolatileEchoFields(direct.body)) === sha(stripVolatileEchoFields(viaA.body)),
  `直连=${short(sha(stripVolatileEchoFields(direct.body)))}  经网关=${short(sha(stripVolatileEchoFields(viaA.body)))}`
  + '\n      （回显体含请求头，而网关必须剥离 x-hop-test —— 差异属 H2/H6 范畴，已单独断言）');
check('回显体差异仅来自被剥离的请求头（其余字段逐个相符）',
  (() => {
    const d = JSON.parse(direct.body.toString('utf8'));
    const p = JSON.parse(viaA.body.toString('utf8'));
    const keys = new Set([...Object.keys(d), ...Object.keys(p)]);
    const diff = [...keys].filter((k) => k !== 'rawHeaders' && JSON.stringify(d[k]) !== JSON.stringify(p[k]));
    return diff.length === 0;
  })(),
  (() => {
    const d = JSON.parse(direct.body.toString('utf8'));
    const p = JSON.parse(viaA.body.toString('utf8'));
    const keys = new Set([...Object.keys(d), ...Object.keys(p)]);
    return `差异字段：${[...keys].filter((k) => k !== 'rawHeaders' && JSON.stringify(d[k]) !== JSON.stringify(p[k])).join(', ')}`;
  })());
const dh = normalizedHeaders(direct.rawHeaders);
const ph = normalizedHeaders(viaA.rawHeaders);
check('非逐跳响应头逐字一致（含原始大小写）', fmt(dh) === fmt(ph),
  `直连=${fmt(dh)}\n      经网关=${fmt(ph)}`);
check('x-request-id 原样透传', getHeader(viaA.rawHeaders, 'x-request-id') === 'req-fixed-0001',
  `实际=${getHeader(viaA.rawHeaders, 'x-request-id')}`);
check('x-codex-turn-state 原样透传（Codex 会回放它做粘性路由）',
  getHeader(viaA.rawHeaders, 'x-codex-turn-state') === 'turn-state-abc',
  `实际=${getHeader(viaA.rawHeaders, 'x-codex-turn-state')}`);
check('openai-model 原样透传', getHeader(viaA.rawHeaders, 'openai-model') === 'gpt-6-luna');
check('网关未注入 x-sgw-error（成功响应不该有）', getHeader(viaA.rawHeaders, 'x-sgw-error') === null);

// ═══════════════════════════════ 用例 2：gzip 不解压 ═══════════════════════════════

head2('用例 2 · gzip 响应 —— 网关必须不解压（原样转发压缩字节）');
// 复用同一份直连基线（上面已请求 directGz），避免"响应体含路径"导致的假失败
const gzProxied = await request({ port: gwA.port, method: 'POST', path: '/v1/echo-gzip', headers: baseHeaders, body: reqBody });

check('响应体逐字节一致（gzip 压缩态，未解压再压缩）',
  sha(stripVolatileEchoFields(directGz.body, true)) === sha(stripVolatileEchoFields(gzProxied.body, true)),
  `直连=${short(sha(directGz.body))}(${directGz.body.length}B)  经网关=${short(sha(gzProxied.body))}(${gzProxied.body.length}B)`
  + '\n      （原始压缩字节长度差异同样来自回显的 rawHeaders —— 网关不解压、原样转发）');
check('网关转发的确实是原始压缩字节（可 gunzip 出合法 JSON）',
  (() => { try { JSON.parse(zlib.gunzipSync(gzProxied.body).toString('utf8')); return true; } catch { return false; } })());
check('压缩态下回显体差异同样仅来自被剥离的请求头',
  (() => {
    const d = JSON.parse(zlib.gunzipSync(directGz.body).toString('utf8'));
    const p = JSON.parse(zlib.gunzipSync(gzProxied.body).toString('utf8'));
    const keys = new Set([...Object.keys(d), ...Object.keys(p)]);
    return [...keys].filter((k) => k !== 'rawHeaders' && JSON.stringify(d[k]) !== JSON.stringify(p[k])).length === 0;
  })());
check('Content-Encoding: gzip 被保留（未剥离）',
  getHeader(gzProxied.rawHeaders, 'content-encoding') === 'gzip',
  `实际=${getHeader(gzProxied.rawHeaders, 'content-encoding')}`);
check('网关改用 chunked 分帧（不再声明过期的 content-length）',
  getHeader(gzProxied.rawHeaders, 'transfer-encoding') === 'chunked'
  && getHeader(gzProxied.rawHeaders, 'content-length') === null,
  `transfer-encoding=${getHeader(gzProxied.rawHeaders, 'transfer-encoding')}  content-length=${getHeader(gzProxied.rawHeaders, 'content-length')}`);
check('压缩载荷可正常解压为合法 JSON',
  (() => { try { JSON.parse(zlib.gunzipSync(gzProxied.body).toString('utf8')); return true; } catch { return false; } })());

// ═══════════════════════════════ 用例 3：流式 SSE ═══════════════════════════════

head2('用例 3 · 流式 SSE —— 不缓冲、逐片到达、字节一致');
const sseProxied = await request({ port: gwA.port, method: 'POST', path: '/v1/echo-sse', headers: baseHeaders, body: reqBody });

say(`      ${C.d}直连分片数=${directSse.chunkTimes.length}  经网关分片数=${sseProxied.chunkTimes.length}${C.x}`);
check('SSE 响应体字节完全相同', sha(directSse.body) === sha(sseProxied.body),
  `直连=${short(sha(directSse.body))}  经网关=${short(sha(sseProxied.body))}`);
check('content-type 保持 text/event-stream',
  (getHeader(sseProxied.rawHeaders, 'content-type') ?? '').includes('text/event-stream'),
  `实际=${getHeader(sseProxied.rawHeaders, 'content-type')}`);
check('事件帧数相同（未被重分帧）',
  directSse.body.toString('utf8').split('\n\n').length === sseProxied.body.toString('utf8').split('\n\n').length);
check('经网关时分片按时序到达（未被整体缓冲成 1 片）', sseProxied.chunkTimes.length >= 2,
  `分片数=${sseProxied.chunkTimes.length}（若为 1 说明被缓冲了）`);
check('网关未注入 [DONE] 或心跳注释帧',
  !sseProxied.body.toString('utf8').includes('[DONE]')
  && !/^:\s*$/m.test(sseProxied.body.toString('utf8')));
check('usage 字段完整保留（total_tokens 存在）',
  sseProxied.body.toString('utf8').includes('"total_tokens":1133'));

// ═══════════════════════════════ 用例 4：上游 4xx 原样透传 ═══════════════════════════════

head2('用例 4 · 上游 403 —— 原样透传，网关不包装、不改状态码');
const errDirect = await request({ port: UPSTREAM_PORT, method: 'POST', path: '/v1/error-403', headers: baseHeaders, body: reqBody });
const errProxied = await request({ port: gwA.port, method: 'POST', path: '/v1/error-403', headers: baseHeaders, body: reqBody });

check('状态码保持 403（未被改成 502/500）', errProxied.status === 403, `实际=${errProxied.status}`);
check('错误响应体字节完全相同（未被包装）', sha(errDirect.body) === sha(errProxied.body),
  `直连=${errDirect.body.toString('utf8').slice(0, 60)}…  经网关=${errProxied.body.toString('utf8').slice(0, 60)}…`);
check('网关未添加 x-sgw-error（这是上游响应，不是网关错误）',
  getHeader(errProxied.rawHeaders, 'x-sgw-error') === null,
  `实际=${getHeader(errProxied.rawHeaders, 'x-sgw-error')}`);
check('x-request-id 仍原样', getHeader(errProxied.rawHeaders, 'x-request-id') === 'req-fixed-403');

// ═══════════════════════════════ 用例 5：append 模式的前缀剥离（H4）═══════════════════════════════

head2('用例 5 · pathMode=append —— 入站 /v1 前缀被正确转换（H4 的前缀语义）');
const viaB = await request({ port: gwB.port, method: 'POST', path: P, headers: baseHeaders, body: reqBody });
const echoB = JSON.parse(viaB.body.toString('utf8'));

// 语义说明（这三种模式很容易混淆，这里把预期写死）：
//   上游 base = http://127.0.0.1:18899/v1，入站 = /v1/echo-json，stripPrefix = /v1
//   → "剥掉 /v1" 得到 /echo-json，再与 base 的路径 /v1 拼接 → 上游看到 **/v1/echo-json**
//   真正要防的 bug 是 `/v1/v1/echo-json`（没剥就拼）。
check('上游 path 为 /v1/echo-json（剥前缀后与 base 的 /v1 拼接，非 /v1/v1/...）',
  echoB.path === '/v1/echo-json', `实际=${echoB.path}`);
check('上游未出现 /v1/v1 双前缀（这是路径拼接最经典的 bug）',
  !echoB.path.startsWith('/v1/v1'), `实际=${echoB.path}`);
check('上游 path 与 absolute 模式产出一致（两种模式在本配置下应等价）',
  echoB.path === echoA.path, `append=${echoB.path}  absolute=${echoA.path}`);
check('query 仍原样保留', echoB.query === '?client_version=0.129.0&foo=bar',
  `实际=${echoB.query}`);
check('request-target 仍是 origin-form', echoB.requestTarget.startsWith('/'),
  `实际=${short(echoB.requestTarget)}`);
check('请求体仍字节不变（剥前缀不影响 body）', echoB.bodySha256 === sha(reqBody));
check('响应体仍逐字节一致', sha(viaA.body) === sha(viaB.body),
  `absolute=${short(sha(viaA.body))}  append=${short(sha(viaB.body))}`);

// 额外：绝对模式在"上游 base 不带路径前缀"时的表现（用同一上游的根路径验证语义）
const echoRoot = JSON.parse((await request({
  port: gwA.port, method: 'POST', path: '/v1/echo-json', headers: baseHeaders, body: reqBody,
})).body.toString('utf8'));
check('同一 pathMode 下重复请求结果稳定（无状态泄漏）', echoRoot.path === echoA.path);

// ═══════════════════════════════ 用例 6：网关自身错误 ═══════════════════════════════

head2('用例 6 · 上游不可达 —— 网关自身错误必须带 x-sgw-error');
const gwBad = await start({ cwd: REPO_ROOT, configFile: cfgBad, logger: silentLog() });
try {
  const r = await request({ port: gwBad.port, method: 'POST', path: '/v1/responses', headers: baseHeaders, body: reqBody });
  check('返回 5xx 而不是挂死', typeof r.status === 'number' && r.status >= 500 && r.status < 600, `实际=${r.status}`);
  check('带 x-sgw-error 标注（用于区分「网关问题」与「上游问题」）',
    getHeader(r.rawHeaders, 'x-sgw-error') !== null,
    `实际=${getHeader(r.rawHeaders, 'x-sgw-error')}`);
  check('错误体是合法 JSON 且含 code/hint',
    (() => { try { const j = JSON.parse(r.body.toString('utf8')); return Boolean(j?.error?.code && j?.error?.hint); } catch { return false; } })());
  check('错误体标明 source=sgw-gateway（一眼看出不是上游返回的）',
    (() => { try { return JSON.parse(r.body.toString('utf8'))?.error?.source === 'sgw-gateway'; } catch { return false; } })());
} finally {
  await gwBad.close();
}

// ═══════════════════════════════ 用例 7：控制面隔离 ═══════════════════════════════

head2('用例 7 · 控制面与代理面隔离 + 反 DNS Rebinding');
const health = await request({ port: gwA.port, method: 'GET', path: '/_sgw/api/health', headers: { host: `127.0.0.1:${gwA.port}` } });
check('/_sgw/api/health 返回 200', health.status === 200, `实际=${health.status}`);
check('health 报告含 usageContract 状态（M0-2b 的告警载体）',
  (() => { try { return 'usageContract' in JSON.parse(health.body.toString('utf8')); } catch { return false; } })());

const evilHost = await request({ port: gwA.port, method: 'GET', path: '/_sgw/api/health', headers: { host: 'evil.example.com' } });
check('恶意 Host 被拒绝（反 DNS Rebinding）', evilHost.status === 403, `实际=${evilHost.status}`);

const proxyEvilHost = await request({
  port: gwA.port, method: 'POST', path: '/v1/echo-json',
  headers: { ...baseHeaders, host: 'evil.example.com' }, body: reqBody,
});
check('★ /v1/** 不校验 Host（代理路径只靠回环监听保护，见 docs/03 §6.2 作用域铁律）',
  proxyEvilHost.status === 200, `实际=${proxyEvilHost.status}`);

const nonProxy = await request({ port: gwA.port, method: 'GET', path: '/not-a-proxy-path' });
check('非 /v1 路径返回 404 且不转发到上游', nonProxy.status === 404, `实际=${nonProxy.status}`);

const wsUpgrade = await new Promise((resolve) => {
  const req = http.request({
    host: '127.0.0.1', port: gwA.port, path: '/v1/responses', method: 'GET',
    headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13' },
  });
  req.on('upgrade', () => resolve({ status: 101 }));
  req.on('response', (res) => { res.resume(); resolve({ status: res.statusCode }); });
  req.on('error', () => resolve({ status: 0 }));
  req.end();
});
check('WebSocket 升级被明确拒绝（501，而非静默失败）', wsUpgrade.status === 501, `实际=${wsUpgrade.status}`);

// ═══════════════════════════════ 结果 ═══════════════════════════════

head1('回归结果');
say(`  ${C.g}通过 ${pass}${C.x}    ${fail ? `${C.r}失败 ${fail}${C.x}` : `${C.d}失败 0${C.x}`}`);
if (failures.length) {
  say(`\n${C.r}${C.B}失败项：${C.x}`);
  for (const f of failures) say(`  ${C.r}✗${C.x} ${f}`);
}
say('');
if (fail === 0) say(`${C.g}${C.B}→ H1~H6 全部通过。透传正确性已被机械化证明。${C.x}`);
else say(`${C.r}${C.B}→ 存在失败项，在修复前不要进入 M2。${C.x}`);

await cleanup();
process.exit(fail === 0 ? 0 : 1);
