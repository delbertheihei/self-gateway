#!/usr/bin/env node
/**
 * SGW M0 探针（v2）—— 回答 `docs/01` §6 的待验证项，其中 M0-2b 是最高优先级。
 *
 * v2 相对 v1 的关键变化：
 *   v1 用 config.toml 的 `experimental_bearer_token` 直发，得到 403
 *   "This account only allows Codex official clients"。
 *   而本机 `auth.json` 的 `auth_mode = "chatgpt"` —— 真实 Codex 发的是 ChatGPT
 *   access_token，不是 sk- Key。因此 v2 增加身份候选矩阵（auth × originator × UA），
 *   逐个实测，找出中继到底在验什么。这对网关实现至关重要：
 *   **网关只做透传，本来不需要知道答案；但我们必须先确认"Codex 能连通"，否则
 *   切成网关后若失败，将无法区分"是网关的问题"还是"身份本来就不被接受"。**
 *
 * 设计原则（与 v1 相同）：
 *   1. 只用 Node 内置模块，零依赖。
 *   2. 不使用 fetch（它会注入头并透明解压，见 docs/03 §2.1 证据 E2/E3）。
 *   3. 请求体极小（max_output_tokens=16），只读不写。
 *   4. 凭据明文永不打印、永不落盘，只记 sha256 前 8 位指纹。
 *
 * 用法：
 *   node scripts/probe-upstream.mjs                     # 身份矩阵 + 流式主路径
 *   node scripts/probe-upstream.mjs --matrix-only       # 只跑身份矩阵（最省额度）
 *   node scripts/probe-upstream.mjs --auth bearer       # 只用 config.toml 的 bearer key
 *   node scripts/probe-upstream.mjs --auth chatgpt      # 只用 auth.json 的 access_token
 *   node scripts/probe-upstream.mjs --all               # 追加非流式 / models / 前缀探测
 *   node scripts/probe-upstream.mjs --base-url <url> --model <id> --token <sk-...>
 *
 * 退出码：0 = 通过；1 = 网络/上游失败；2 = 致命互操作问题（如 usage 缺字段）
 */

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// ─────────────────────────────── 常量 ───────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const NOTES_DIR = path.join(REPO_ROOT, 'notes');
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const CODEX_CONFIG = path.join(CODEX_HOME, 'config.toml');
const CODEX_AUTH = path.join(CODEX_HOME, 'auth.json');

// ★ 刻意**不**内置任何上游地址与模型名：
//   探针会真实打到该地址并消耗额度，写死一个具体中继意味着每个 clone 下来的人
//   都可能悄悄打到别人的环境上。地址与模型必须由使用者显式提供。
const DEFAULTS = { timeoutMs: 120_000 };

/** 身份候选值。来源：codex-rs 源码常量 DEFAULT_ORIGINATOR = "codex_cli_rs"，
 *  以及第三方位中观察到的 codex_vscode / codex_app。逐个实测优于猜测。 */
const ORIGINATORS = ['codex_cli_rs', 'codex_app', 'codex_vscode'];
const UA_VARIANTS = {
  'cli-like': (v) => `codex_cli_rs/${v} (sgw-m0-probe)`,
  'app-like': (v) => `Codex/${v} (Windows 11; x64) sgw-m0-probe`,
};

// ─────────────────────────────── CLI ───────────────────────────────

function parseArgv(argv) {
  const flags = new Set(); const values = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2); const next = argv[i + 1];
    if (next && !next.startsWith('--')) { values[key] = next; i++; } else flags.add(key);
  }
  return { flags, values };
}
const { flags, values } = parseArgv(process.argv.slice(2));
if (flags.has('help') || flags.has('h')) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 30)
    .map((l) => l.replace(/^ \*ap?\/?/, '').replace(/^ \*/gm, '')).join('\n'));
  process.exit(0);
}

const opt = {
  baseUrl: (values['base-url'] ?? process.env.SGW_BASE_URL ?? '').trim(),
  model: (values.model ?? process.env.SGW_MODEL ?? '').trim(),
  token: (values.token ?? process.env.SGW_TOKEN ?? '').trim(),
  authMode: (values.auth ?? 'auto').trim(),          // auto | bearer | chatgpt
  matrixOnly: flags.has('matrix-only'),
  noMatrix: flags.has('no-matrix'),
  nonStreaming: flags.has('non-streaming') || flags.has('all'),
  models: flags.has('models') || flags.has('all'),
  prefixProbe: flags.has('prefix-probe') || flags.has('all'),
  timeoutMs: Number(values['timeout-ms'] ?? process.env.SGW_TIMEOUT_MS ?? DEFAULTS.timeoutMs),
};

// ─────────────────────────────── 凭据加载 ───────────────────────────────

const fingerprint = (s) => (s ? crypto.createHash('sha256').update(s).digest('hex').slice(0, 8) : null);

/** 分类凭据形态：ChatGPT access_token 是 JWT（三段点分），sk- Key 不是 */
function classifyToken(t) {
  if (!t) return 'none';
  if (t.startsWith('sk-')) return 'api-key(sk-)';
  if (/^[\w-]+\.[\w-]+\.[\w-]+$/.test(t)) return 'jwt';
  return 'opaque';
}
function jwtClaims(t) {
  try {
    const p = t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(p, 'base64').toString('utf8'));
  } catch { return null; }
}

function readCodexConfig(file) {
  if (!fs.existsSync(file)) return { found: false, file, providers: [], top: {} };
  const text = fs.readFileSync(file, 'utf8');
  const providers = []; let current = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    const header = line.match(/^\[model_providers\.([^\]]+)\]$/);
    if (header) { current = { id: header[1] }; providers.push(current); continue; }
    if (line.startsWith('[')) { current = null; continue; }
    if (!current) continue;
    const kv = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.+?)\s*$/); if (!kv) continue;
    let v = kv[2];
    const q = v.match(/^"([\s\S]*)"$/) ?? v.match(/^'([\s\S]*)'$/);
    current[kv[1]] = q ? q[1] : v;
  }
  const top = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim(); if (line.startsWith('[')) break;
    const kv = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.+?)\s*$/); if (!kv) continue;
    const q = kv[2].match(/^"([\s\S]*)"$/); top[kv[1]] = q ? q[1] : kv[2];
  }
  return { found: true, file, providers, top };
}

const codexCfg = readCodexConfig(CODEX_CONFIG);
const provider = codexCfg.providers[0] ?? null;
// 地址来源优先级：--base-url / SGW_BASE_URL → 本机 Codex 配置里的 provider base_url
if (!opt.baseUrl) opt.baseUrl = provider?.base_url ?? '';
// 模型来源优先级：--model / SGW_MODEL → 本机 Codex 配置里的顶层 model
if (!opt.model) opt.model = codexCfg.top?.model ?? '';

// ★ 两者缺一不可：**绝不**回落到内置默认值（这正是"写死上游"的老毛病）。
//   报错信息要直接告诉用户怎么补，而不是丢一句"缺少参数"。
if (!opt.baseUrl || !opt.model) {
  const missing = [
    !opt.baseUrl ? '上游地址（--base-url 或 SGW_BASE_URL）' : null,
    !opt.model ? '模型名（--model 或 SGW_MODEL）' : null,
  ].filter(Boolean);
  process.stderr.write(`\n✗ 缺少${missing.join(' 与 ')}\n\n`
    + '  本探针不在代码里内置上游地址与模型 —— 它会真实发起请求并消耗额度，\n'
    + '  因此必须由你显式指定（或让本机 Codex 配置提供）：\n\n'
    + '    node scripts/probe-upstream.mjs --base-url https://<你的中继>/v1 --model <模型名>\n'
    + '    SGW_BASE_URL=... SGW_MODEL=... node scripts/probe-upstream.mjs\n\n'
    + `  （已读取的 Codex 配置：${CODEX_CONFIG}${codexCfg.found ? '' : ' —— 文件不存在'}）\n\n`);
  process.exit(1);
}

/** 收集所有可用凭据候选 → [{ id, label, token, tokenKind, source }] */
const credentials = [];
if (opt.token) {
  credentials.push({
    id: 'cli', label: values.token ? 'CLI --token' : 'SGW_TOKEN 环境变量',
    token: opt.token, tokenKind: classifyToken(opt.token), source: '用户显式提供',
  });
}
if (!opt.token && provider?.experimental_bearer_token) {
  credentials.push({
    id: 'bearer', label: 'config.toml → experimental_bearer_token',
    token: provider.experimental_bearer_token,
    tokenKind: classifyToken(provider.experimental_bearer_token),
    source: 'Codex config.toml',
  });
}
if (!opt.token && provider?.env_key && process.env[provider.env_key]) {
  credentials.push({
    id: 'envkey', label: `环境变量 ${provider.env_key}`,
    token: process.env[provider.env_key], tokenKind: classifyToken(process.env[provider.env_key]),
    source: `config.toml → env_key`,
  });
}
if (!opt.token && fs.existsSync(CODEX_AUTH)) {
  try {
    const a = JSON.parse(fs.readFileSync(CODEX_AUTH, 'utf8'));
    if (a.tokens?.access_token) {
      credentials.push({
        id: 'chatgpt', label: `auth.json → tokens.access_token (auth_mode=${a.auth_mode ?? '?'})`,
        token: a.tokens.access_token, tokenKind: classifyToken(a.tokens.access_token),
        source: 'Codex auth.json（ChatGPT 登录令牌）',
      });
    }
    if (a.OPENAI_API_KEY) {
      credentials.push({
        id: 'authkey', label: 'auth.json → OPENAI_API_KEY',
        token: a.OPENAI_API_KEY, tokenKind: classifyToken(a.OPENAI_API_KEY), source: 'Codex auth.json',
      });
    }
  } catch (e) { /* 忽略：auth.json 解析失败不致命 */ }
}

// 按 --auth 过滤
let activeCreds = credentials;
if (opt.authMode === 'bearer') activeCreds = credentials.filter((c) => c.id === 'bearer' || c.id === 'envkey' || c.id === 'authkey' || c.id === 'cli');
else if (opt.authMode === 'chatgpt') activeCreds = credentials.filter((c) => c.id === 'chatgpt');
else if (opt.authMode !== 'auto') activeCreds = credentials.filter((c) => c.id === opt.authMode);

// ─────────────────────────────── 渲染 ───────────────────────────────

const C = process.stdout.isTTY
  ? { r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', b: '\x1b[36m', d: '\x1b[2m', B: '\x1b[1m', x: '\x1b[0m' }
  : { r: '', g: '', y: '', b: '', d: '', B: '', x: '' };
const say = (l = '') => console.log(l);
const h1 = (t) => say(`\n${C.B}${'═'.repeat(74)}${C.x}\n${C.B} ${t}${C.x}\n${C.B}${'═'.repeat(74)}${C.x}`);
const h2 = (t) => say(`\n${C.b}── ${t} ${'─'.repeat(Math.max(0, 68 - t.length))}${C.x}`);
const ok = (t) => say(`  ${C.g}✓${C.x} ${t}`);
const bad = (t) => say(`  ${C.r}✗${C.x} ${t}`);
const warn = (t) => say(`  ${C.y}!${C.x} ${t}`);
const info = (k, v) => say(`  ${C.d}${String(k).padEnd(30)}${C.x} ${v}`);
const findings = { fatal: [], warn: [], ok: [] };

// ─────────────────────────────── HTTP 原语 ───────────────────────────────

function rawRequest({ method, url, headers, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const startedAt = Date.now();
    const chunks = [];
    const marks = { connectAt: null, headersAt: null, firstByteAt: null, endAt: null };

    const req = mod.request({
      protocol: u.protocol, hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: `${u.pathname}${u.search}`, method, headers,
      // 刻意不设 timeout：node:http 客户端默认无超时，与网关设计一致（docs/02 ADR-14）
    });
    const timer = setTimeout(() => req.destroy(new Error(`客户端侧超时 ${timeoutMs}ms`)), timeoutMs);
    req.on('socket', (s) => { if (s.connecting) s.once('connect', () => { marks.connectAt = Date.now(); }); else marks.connectAt = Date.now(); });
    req.on('response', (res) => {
      marks.headersAt = Date.now();
      res.on('data', (c) => { if (marks.firstByteAt === null) marks.firstByteAt = Date.now(); chunks.push(c); });
      res.on('end', () => { marks.endAt = Date.now(); clearTimeout(timer);
        resolve({ status: res.statusCode, statusMessage: res.statusMessage, httpVersion: res.httpVersion,
          rawHeaders: res.rawHeaders, body: Buffer.concat(chunks), marks, startedAt }); });
      res.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    if (body) req.write(body);
    req.end();
  });
}
function getHeader(res, name) {
  const lower = name.toLowerCase();
  for (let i = 0; i < res.rawHeaders.length; i += 2)
    if (res.rawHeaders[i].toLowerCase() === lower) return res.rawHeaders[i + 1];
  return null;
}

// ─────────────── 响应体解析：容忍"JSON 错误体 + SSE"混合（上游真实行为） ───────────────

/**
 * 上游在 403 时返回的是这种混合体：
 *   {"error":{...}}event: response.failed\ndata: {...}\n\n
 * —— 先是裸 JSON（无分隔），紧接 SSE 帧。必须容错解析，否则会把事件名解析错。
 */
function parseUpstreamBody(bodyBuf, contentType) {
  const text = bodyBuf.toString('utf8');
  const result = { text, leadingJson: null, sseEvents: [], sseTypeCounts: new Map(), sawDoneSentinel: false, parseErrors: 0, shape: 'unknown' };

  // 1) 尝试整体作为 JSON
  try { result.leadingJson = JSON.parse(text); result.shape = 'pure-json'; return result; } catch { /* 继续 */ }

  // 2) 剥离前导 JSON 对象（括号配对扫描），剩下按 SSE 解析
  let rest = text;
  const t = text.trimStart();
  if (t.startsWith('{')) {
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let i = 0; i < t.length; i++) {
      const ch = t[i];
      if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') { inStr = true; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    if (end > 0) {
      try { result.leadingJson = JSON.parse(t.slice(0, end)); rest = t.slice(end); } catch { /* 保持原样 */ }
    }
  }

  // 3) 解析剩余部分为 SSE 帧
  const scanner = createSseScanner();
  scanner.push(Buffer.from(rest, 'utf8'));
  const scanned = scanner.finish();
  result.sseEvents = scanned.events;
  result.sseTypeCounts = scanned.typeCounts;
  result.sawDoneSentinel = scanned.sawDoneSentinel;
  result.parseErrors = scanned.parseErrors;
  result.shape = result.leadingJson && scanned.events.length ? 'json+sse' : scanned.events.length ? 'sse' : result.leadingJson ? 'pure-json' : 'unknown';
  return result;
}

function createSseScanner() {
  let buf = Buffer.alloc(0);
  const events = []; const typeCounts = new Map();
  let sawDoneSentinel = false; let parseErrors = 0;

  const flushFrame = (frameText) => {
    let eventName = null; let id = null; const dataLines = [];
    for (const line of frameText.split('\n')) {
      if (line === '' || line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') eventName = value;
      else if (field === 'id') id = value;
      else if (field === 'data') dataLines.push(value);
    }
    if (dataLines.length === 0 && !eventName) return;
    const dataRaw = dataLines.join('\n');
    if (dataRaw.trim() === '[DONE]') { sawDoneSentinel = true; return; }
    let parsed = null;
    try { parsed = dataRaw ? JSON.parse(dataRaw) : null; } catch { parseErrors++; }
    const type = parsed?.type ?? eventName ?? '(no-type)';
    typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
    events.push({ event: eventName, id, type, parsed, raw: dataRaw });
  };

  return {
    push(chunk) {
      buf = Buffer.concat([buf, chunk]);   // 必须按 Buffer 累积：多字节 UTF-8 可能跨分片
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.subarray(0, idx); buf = buf.subarray(idx + 2);
        flushFrame(frame.toString('utf8').replace(/\r/g, ''));
      }
    },
    finish() {
      if (buf.length) { flushFrame(buf.toString('utf8').replace(/\r/g, '')); buf = Buffer.alloc(0); }
      return { events, typeCounts, sawDoneSentinel, parseErrors };
    },
  };
}

// ─────────────── Codex ResponseCompleted 契约校验（M0-2b） ───────────────

function validateCompletedContract(terminalEvent) {
  const r = { present: false, missing: [], nonInteger: [], responseId: null, usage: null, verdict: 'n/a' };
  const parsed = terminalEvent?.parsed;
  if (!parsed) return r;
  r.present = true;
  const resp = parsed.response;
  if (!resp || typeof resp !== 'object') { r.missing.push('response'); r.verdict = 'FATAL'; return r; }
  if (typeof resp.id !== 'string' || resp.id.length === 0) r.missing.push('response.id'); else r.responseId = resp.id;

  if (resp.usage === undefined || resp.usage === null) { r.verdict = 'NO_USAGE'; return r; }
  const u = resp.usage; r.usage = u;
  for (const f of ['input_tokens', 'output_tokens', 'total_tokens']) {
    if (!(f in u)) r.missing.push(`usage.${f}`);
    else if (!Number.isInteger(u[f])) r.nonInteger.push(`usage.${f}=${JSON.stringify(u[f])}`);
  }
  if (u.input_tokens_details && typeof u.input_tokens_details === 'object' && !('cached_tokens' in u.input_tokens_details))
    r.missing.push('usage.input_tokens_details.cached_tokens');
  if (u.output_tokens_details && typeof u.output_tokens_details === 'object' && !('reasoning_tokens' in u.output_tokens_details))
    r.missing.push('usage.output_tokens_details.reasoning_tokens');
  r.verdict = (r.missing.length || r.nonInteger.length) ? 'FATAL' : 'OK';
  return r;
}

// ─────────────────────────────── 请求构造 ───────────────────────────────

const joinBase = (base, suffix) => {
  const b = base.replace(/\/+$/, ''); const s = suffix.replace(/^\/+/, '');
  return s ? `${b}/${s}` : b;
};

function buildHeaders({ url, token, accept, originator, ua, includeVersion }) {
  const u = new URL(url);
  const h = {
    host: u.host,
    authorization: `Bearer ${token}`,
    accept,
    'content-type': 'application/json',
    'user-agent': ua,
    originator,
    'session-id': 'sgw-m0-probe-session',
    'thread-id': 'sgw-m0-probe-thread',
    'x-client-request-id': 'sgw-m0-probe-thread',
    'accept-encoding': 'identity',   // 仅探测可解析性；正式网关不强制（docs/02 ADR-16）
    connection: 'keep-alive',
  };
  if (includeVersion) h.version = '0.129.0';
  return h;
}

function buildResponsesBody(model, stream = true) {
  return JSON.stringify({
    model,
    instructions: 'You are a probe. Reply with the single word: pong',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'ping' }] }],
    tools: [], tool_choice: 'auto', parallel_tool_calls: false,
    store: false, stream,
    prompt_cache_key: 'sgw-m0-probe-session',
    max_output_tokens: 16,
  });
}

/** 从错误体里提取可读信息 */
function describeFailure(parsed) {
  const msg = parsed?.leadingJson?.error?.message
    ?? parsed?.sseEvents?.find((e) => e.parsed?.response?.error)?.parsed?.response?.error?.message
    ?? parsed?.leadingJson?.message ?? null;
  const code = parsed?.leadingJson?.error?.code ?? parsed?.leadingJson?.error?.type ?? null;
  return { msg, code };
}

// ═══════════════════════════════ 主流程 ═══════════════════════════════

// 注意：必须在使用前声明（finish() 会读它）。之前放在主流程中部导致 TDZ 错误。
const probe = {
  meta: {
    startedAt: new Date().toISOString(), node: process.version, baseUrl: opt.baseUrl, model: opt.model,
    codexConfigFile: CODEX_CONFIG, codexAuthFile: CODEX_AUTH,
    credentialCandidates: activeCreds.map((c) => ({ id: c.id, label: c.label, kind: c.tokenKind, fp: fingerprint(c.token), source: c.source })),
    matrixUsed: !opt.noMatrix,
  },
  matrix: [],
  stream: null, contract: null, nonStreaming: null, models: null, findings,
};

h1('SGW M0 探针 v2 —— 身份矩阵 + 上游协议与 usage 契约验证');

h2('0. 环境与凭据候选');
info('Node', process.version);
info('Codex config', `${CODEX_CONFIG} ${codexCfg.found ? '(已找到)' : '(未找到)'}`);
if (provider) {
  info('provider', `${provider.id}  wire_api=${provider.wire_api ?? '?'}  requires_openai_auth=${provider.requires_openai_auth ?? '?'}`);
}
info('探测 base_url', opt.baseUrl);
info('探测 model', opt.model);
say('');
info('凭据候选', String(activeCreds.length));
for (const c of activeCreds) {
  let extra = '';
  if (c.tokenKind === 'jwt') {
    const cl = jwtClaims(c.token);
    if (cl?.exp) {
      const expAt = new Date(cl.exp * 1000);
      const expired = Date.now() > cl.exp * 1000;
      extra = `  ${expired ? C.r + '已过期' + C.x : C.g + '有效至 ' + expAt.toLocaleString() + C.x}`;
      if (cl['https://api.openai.com/auth']?.chatgpt_plan_type) extra += `  plan=${cl['https://api.openai.com/auth'].chatgpt_plan_type}`;
    }
  }
  say(`    ${C.d}•${C.x} ${c.label}`);
  say(`      ${C.d}形态=${c.tokenKind}  指纹=${fingerprint(c.token)}${C.x}${extra}`);
}
info('accept-encoding', 'identity（探测专用）');

if (activeCreds.length === 0) {
  bad('没有可用的凭据候选。请用 --token <sk-...> 或设置 SGW_TOKEN。');
  process.exit(1);
}

// ── 阶段 1：身份矩阵 ──

const streamUrl = joinBase(opt.baseUrl, 'responses');
const matrix = [];

if (!opt.noMatrix) {
  h2('1. 身份矩阵 —— 找出中继到底在验什么（每个组合 1 次极小请求）');
  say(`  ${C.d}目标 URL：${streamUrl}${C.x}`);
  say(`  ${C.d}判定：HTTP 200 = 接受；403 forbidden_error = 身份不被认可${C.x}`);
  say('');

  const ua = UA_VARIANTS['cli-like']('0.129.0');
  const combos = [];
  for (const cred of activeCreds) {
    for (const originator of ORIGINATORS) {
      combos.push({ cred, originator, ua, includeVersion: false, tag: `${cred.id} + originator=${originator}` });
    }
  }
  // 额外试一个"Desktop 形态"的 UA（仅用第一个候选，避免请求过多）
  if (activeCreds[0]) {
    combos.push({
      cred: activeCreds[0], originator: 'codex_app',
      ua: UA_VARIANTS['app-like']('26.1007.21434'), includeVersion: false,
      tag: `${activeCreds[0].id} + originator=codex_app + UA=app-like`,
    });
  }

  say(`  ${'#'.padEnd(3)}${'凭据'.padEnd(10)}${'originator'.padEnd(16)}${'UA'.padEnd(10)}状态  说明`);
  say(`  ${'─'.repeat(72)}`);
  for (let i = 0; i < combos.length; i++) {
    const cb = combos[i];
    const uaKind = cb.ua === ua ? 'cli-like' : 'app-like';
    let status = 'ERR'; let note = '';
    try {
      const res = await rawRequest({
        method: 'POST', url: streamUrl,
        headers: buildHeaders({ url: streamUrl, token: cb.cred.token, accept: 'text/event-stream', originator: cb.originator, ua: cb.ua, includeVersion: cb.includeVersion }),
        body: buildResponsesBody(opt.model, true),
        timeoutMs: Math.min(opt.timeoutMs, 30_000),
      });
      status = String(res.status);
      const parsed = parseUpstreamBody(res.body, getHeader(res, 'content-type'));
      const f = describeFailure(parsed);
      note = res.status === 200 ? `${C.g}接受${C.x}` : (f.msg ? `${f.msg}` : parsed.shape);
      matrix.push({ ...cb, status: res.status, note, shape: parsed.shape, errorMsg: f.msg, errorCode: f.code, contentType: getHeader(res, 'content-type'), requestId: getHeader(res, 'x-request-id') });
    } catch (e) {
      note = e.message;
      matrix.push({ ...cb, status: null, note: e.message, errorMsg: e.message });
    }
    say(`  ${String(i + 1).padEnd(3)}${cb.cred.id.padEnd(10)}${cb.originator.padEnd(16)}${uaKind.padEnd(10)}${String(status).padEnd(6)}${note}`);
  }

  const winners = matrix.filter((m) => m.status === 200);
  probe.matrix = matrix.map((m) => ({
    cred: m.cred.id, originator: m.originator,
    ua: m.ua === ua ? 'cli-like' : 'app-like',
    status: m.status, errorMsg: m.errorMsg ?? null, errorCode: m.errorCode ?? null,
  }));
  say('');
  if (winners.length) {
    ok(`${winners.length} 个组合被接受。可用的身份形态组合：`);
    for (const w of winners) say(`      ${C.g}•${C.x} 凭据=${w.cred.id}  originator=${w.originator}  UA=${w.ua === ua ? 'cli-like' : 'app-like'}`);
    findings.ok.push(`身份矩阵有 ${winners.length} 个通过组合 —— Codex 可正常连通（网关只需透传，无需构造身份）`);
  } else {
    bad('所有身份组合都被拒绝 —— 这不是网关能解决的问题，而是账号/中继侧的策略限制。');
    const msgs = [...new Set(matrix.map((m) => m.errorMsg).filter(Boolean))];
    for (const m of msgs) say(`      ${C.r}•${C.x} ${m}`);
    findings.fatal.push(`所有身份组合均被拒绝：${msgs.join(' | ')}`);
    say('');
    warn('重要含义：如果连"模仿 Codex 直连"都不被接受，那么把 Codex 指向网关后，');
    say('        网关透传的仍是同样的身份与头，结果应当相同（也可能因缺少某个头而不同）。');
    say('        但**必须先弄清楚真实 Codex 当前是否能正常使用**，否则无法区分问题来源。');
  }
}

if (opt.matrixOnly) { finish(findings.fatal.length ? 2 : 0); }

// ── 阶段 2：选一个"最可能成功"的身份跑完整流式解析 ──

h2('2. 流式 POST /responses —— 完整解析（M0-1 / M0-2 / M0-2b / M0-3 / M0-4）');

const winner = matrix.find((m) => m.status === 200);
const chosen = winner
  ? { cred: winner.cred, originator: winner.originator, ua: winner.ua, basis: '矩阵中已验证通过的组合' }
  : { cred: activeCreds[0], originator: 'codex_cli_rs', ua: UA_VARIANTS['cli-like']('0.129.0'), basis: '矩阵无通过项，用首个候选继续（仅为拿到上游的真实响应形态）' };
info('采用身份', `${chosen.cred.id} + originator=${chosen.originator}`);
info('依据', chosen.basis);
info('URL', streamUrl);

let res = null;
try {
  res = await rawRequest({
    method: 'POST', url: streamUrl,
    headers: buildHeaders({ url: streamUrl, token: chosen.cred.token, accept: 'text/event-stream', originator: chosen.originator, ua: chosen.ua, includeVersion: false }),
    body: buildResponsesBody(opt.model, true), timeoutMs: opt.timeoutMs,
  });
} catch (e) {
  bad(`请求失败：${e.message}`);
  findings.fatal.push(`流式请求无法完成：${e.message}`);
  if (/self.signed|unable to verify|CERT/i.test(e.message)) warn('疑似 TLS 证书问题：上游若用内网 CA，请在网关配置 caFile。');
  finish(1);
}

const ct = getHeader(res, 'content-type');
const ce = getHeader(res, 'content-encoding');
const te = getHeader(res, 'transfer-encoding');
const parsed = parseUpstreamBody(res.body, ct);
const isSse = (ct ?? '').includes('text/event-stream');

say('');
info('HTTP 状态', `${res.status} ${res.statusMessage} (HTTP/${res.httpVersion})`);
info('content-type', ct ?? '(无)');
info('content-encoding', ce ?? '(无 → 未压缩)');
info('transfer-encoding', te ?? '(无)');
info('content-length', getHeader(res, 'content-length') ?? '(无 → 分块)');
info('x-request-id', getHeader(res, 'x-request-id') ?? C.y + '(缺失)' + C.x);
info('x-codex-turn-state', getHeader(res, 'x-codex-turn-state') ?? '(无)');
info('openai-model', getHeader(res, 'openai-model') ?? '(无)');
info('响应体形态', parsed.shape + (parsed.leadingJson ? '（含前导 JSON 错误体）' : ''));
info('响应体字节数', String(res.body.length));
info('建连 / 响应头 / 首字节 / 总', `${res.marks.connectAt ? res.marks.connectAt - res.startedAt : '?'} / ${res.marks.headersAt - res.startedAt} / ${res.marks.firstByteAt ? res.marks.firstByteAt - res.startedAt : '?'} / ${res.marks.endAt - res.startedAt} ms`);

const rlKeys = [];
for (let i = 0; i < res.rawHeaders.length; i += 2) {
  const n = res.rawHeaders[i].toLowerCase();
  if (n.startsWith('x-codex-') || n.includes('ratelimit') || n.includes('rate-limit'))
    rlKeys.push(`${res.rawHeaders[i]}: ${res.rawHeaders[i + 1]}`);
}
if (rlKeys.length) { info('限流/Codex 头', `${rlKeys.length} 个`); for (const k of rlKeys) say(`      ${C.d}${k}${C.x}`); }


if (!isSse) {
  const f = describeFailure(parsed);
  bad(`响应不是 SSE（content-type=${ct}）`);
  if (f.msg) bad(`上游消息：${f.msg}${f.code ? ` (${f.code})` : ''}`);
  say('');
  say(`  ${C.d}原始响应体（前 1200 字符，便于贴给中继管理员）：${C.x}`);
  for (const line of parsed.text.slice(0, 1200).split('\n')) say(`  ${C.d}│ ${line}${C.x}`);
  findings.fatal.push(`流式请求返回 ${res.status} 且非 SSE：${f.msg ?? parsed.shape}`);
  probe.stream = { status: res.status, contentType: ct, isSse: false, shape: parsed.shape, bodyPreview: parsed.text.slice(0, 2000) };
  finish(2);
}

ok('响应是 SSE 流（text/event-stream）—— M0-1 通过');
say('');
info('SSE 事件总数', String(parsed.sseEvents.length));
info('[DONE] 哨兵', parsed.sawDoneSentinel ? '有（非标准，Codex 可容忍）' : '无（标准 Responses 行为）');
info('解析失败帧数', String(parsed.parseErrors));

h2('2b. SSE 事件类型清单（M0-3）');
const sorted = [...parsed.sseTypeCounts.entries()].sort((a, b) => b[1] - a[1]);
for (const [t, n] of sorted) say(`  ${String(n).padStart(4)} ×  ${t}`);
const privateEvents = sorted.map(([t]) => t).filter((t) => t.startsWith('codex.') || t.startsWith('responsesapi.'));
if (privateEvents.length) {
  warn(`非标准私有事件：${privateEvents.join(', ')}（Codex 会忽略，不影响透传）`);
  findings.warn.push(`上游发出私有事件类型：${privateEvents.join(', ')}`);
} else ok('事件类型均为标准 Responses 事件族');

const terminals = parsed.sseEvents.filter((e) => e.type === 'response.completed' || e.type === 'response.incomplete');
const failed = parsed.sseEvents.find((e) => e.type === 'response.failed' || e.type === 'error');
if (terminals.length === 0) {
  bad('没有 response.completed / response.incomplete —— 无法取得 usage');
  if (failed) {
    const em = failed.parsed?.response?.error?.message ?? failed.parsed?.message ?? '(无 message)';
    bad(`流以失败事件结束：${failed.type} → ${em}`);
    findings.fatal.push(`流以 ${failed.type} 结束：${em}`);
  } else {
    findings.fatal.push('SSE 流中没有终止事件，usage 无从获取');
  }
} else {
  ok(`收到 ${terminals.length} 个终止事件：${[...new Set(terminals.map((e) => e.type))].join(', ')}`);
}

// ── 阶段 3：usage 契约（M0-2b） ──

h2('3. usage 契约校验 —— M0-2b（决定 Codex 会不会整轮硬失败）');
const contract = validateCompletedContract(terminals[terminals.length - 1]);
probe.contract = contract;

if (!contract.present) {
  warn('无终止事件可校验，跳过。');
} else if (contract.verdict === 'OK') {
  ok(`response.id = ${contract.responseId}`);
  ok('usage 完整：input_tokens / output_tokens / total_tokens 均为整数');
  const u = contract.usage;
  info('input_tokens', String(u.input_tokens));
  info('output_tokens', String(u.output_tokens));
  info('total_tokens', String(u.total_tokens));
  info('cached_tokens', String(u.input_tokens_details?.cached_tokens ?? '(无 details)'));
  info('cache_write_tokens', String(u.input_tokens_details?.cache_write_tokens ?? '(无)'));
  info('reasoning_tokens', String(u.output_tokens_details?.reasoning_tokens ?? '(无 details)'));
  findings.ok.push('usage 完整 —— 可精确记账，且 Codex 不会因 usage 结构失败');
} else if (contract.verdict === 'NO_USAGE') {
  warn('response.completed 未携带 usage（或为 null）。');
  info('对 Codex', '安全 —— token_usage = None，本轮正常');
  info('对记账', '无法精确记账，需走本地估算');
  findings.warn.push('上游不返回 usage：用量统计将退化为本地估算（±5–15%）');
} else {
  bad(`致命互操作问题！缺失字段：${contract.missing.join(', ')}`);
  if (contract.nonInteger.length) bad(`类型非整数：${contract.nonInteger.join(', ')}`);
  say('');
  say(`  ${C.r}${C.B}后果：Codex 会在本轮直接失败，报错形如${C.x}`);
  say(`  ${C.r}  failed to parse ResponseCompleted: missing field \`${(contract.missing[0] ?? 'X').split('.').pop()}\`${C.x}`);
  say('');
  say(`  ${C.y}这不是你的配置问题，也不是网关的问题 —— 是上游中继的 usage 结构不符合 Codex 契约。${C.x}`);
  say(`  ${C.d}可把下面这段直接发给中继管理员：${C.x}`);
  say(`  ${C.d}  POST ${streamUrl} 的 response.completed.response.usage 缺字段：${contract.missing.join(', ')}；${C.x}`);
  say(`  ${C.d}  Codex 把这些字段声明为非 Option，缺失会导致整轮解析失败。${C.x}`);
  findings.fatal.push(`usage 契约不满足：缺 ${contract.missing.join(', ')} → Codex 会整轮失败`);
}

// ── 阶段 4：压缩 ──

h2('4. 压缩行为（M0-4）');
if (ce && ce !== 'identity') {
  warn(`上游使用 Content-Encoding: ${ce} → 观测器需在旁路解压（转发仍原样，H3）`);
  findings.warn.push(`上游对 SSE 启用了 ${ce} 压缩：观测器需在旁路解压`);
} else ok('上游未压缩 SSE 响应 —— 观测器可直接解析明文（最简情况）');

probe.stream = {
  status: res.status, contentType: ct, contentEncoding: ce, transferEncoding: te, isSse: true, shape: parsed.shape,
  requestId: getHeader(res, 'x-request-id'), turnState: getHeader(res, 'x-codex-turn-state'), openaiModel: getHeader(res, 'openai-model'),
  rateLimitHeaders: rlKeys, eventTypes: Object.fromEntries(sorted), eventCount: parsed.sseEvents.length,
  parseErrors: parsed.parseErrors, sawDoneSentinel: parsed.sawDoneSentinel, privateEvents,
  terminalTypes: [...new Set(terminals.map((e) => e.type))],
  timingMs: { connect: res.marks.connectAt ? res.marks.connectAt - res.startedAt : null, headers: res.marks.headersAt - res.startedAt,
    firstByte: res.marks.firstByteAt ? res.marks.firstByteAt - res.startedAt : null, total: res.marks.endAt - res.startedAt },
  bytes: res.body.length,
};

// ── 阶段 5（可选）：非流式 / models / 前缀 ──

if (opt.nonStreaming) {
  h2('5. 非流式 POST /responses（对照）');
  try {
    const r2 = await rawRequest({
      method: 'POST', url: streamUrl,
      headers: buildHeaders({ url: streamUrl, token: chosen.cred.token, accept: 'application/json', originator: chosen.originator, ua: chosen.ua }),
      body: buildResponsesBody(opt.model, false), timeoutMs: opt.timeoutMs,
    });
    const p2 = parseUpstreamBody(r2.body, getHeader(r2, 'content-type'));
    const obj = p2.leadingJson?.response ?? p2.leadingJson;
    const c2 = validateCompletedContract({ parsed: { response: obj } });
    info('HTTP 状态', String(r2.status));
    info('content-type', getHeader(r2, 'content-type') ?? '(无)');
    if (c2.verdict === 'OK') { ok('非流式也带完整 usage'); info('total_tokens', String(c2.usage.total_tokens)); }
    else if (c2.verdict === 'NO_USAGE') warn('非流式响应不带 usage');
    else bad(`非流式结构异常：缺 ${c2.missing.join(', ')}`);
    probe.nonStreaming = { status: r2.status, verdict: c2.verdict, usage: c2.usage ?? null };
  } catch (e) { bad(`请求失败：${e.message}`); probe.nonStreaming = { error: e.message }; }
}

if (opt.models || opt.prefixProbe) {
  h2('6. 路径前缀与 /models（M0-5）');
  const cands = [
    { label: "stripPrefix='/v1' → /models", url: `${joinBase(opt.baseUrl, 'models')}?client_version=0.129.0` },
    { label: "stripPrefix='' → /v1/models", url: `${joinBase(opt.baseUrl, 'v1/models')}?client_version=0.129.0` },
  ];
  const results = [];
  for (const c of cands) {
    try {
      const r3 = await rawRequest({
        method: 'GET', url: c.url,
        headers: { ...buildHeaders({ url: c.url, token: chosen.cred.token, accept: 'application/json', originator: chosen.originator, ua: chosen.ua }) },
        timeoutMs: opt.timeoutMs,
      });
      results.push({ ...c, status: r3.status });
      info(c.label.padEnd(30), `HTTP ${r3.status}`);
    } catch (e) { results.push({ ...c, error: e.message }); info(c.label.padEnd(30), `ERR ${e.message}`); }
  }
  const good = results.find((r) => r.status === 200);
  if (good) ok(`应使用：${good.label}`);
  else {
    const authed = results.find((r) => r.status === 401 || r.status === 403);
    if (authed) warn(`均非 200，但「${authed.label}」返回 ${authed.status}（端点存在）→ 采用它`);
    else bad('两个候选都不可用，需人工检查上游路由');
  }
  probe.models = { candidates: results };
}

finish(findings.fatal.length ? 2 : 0);

// ═══════════════════════════════ 收尾 ═══════════════════════════════

function finish(code) {
  h1(code === 0 ? '结论汇总' : '结论汇总（存在问题）');
  if (findings.ok.length) { say(`${C.g}通过：${C.x}`); for (const f of findings.ok) say(`  ${C.g}✓${C.x} ${f}`); }
  if (findings.warn.length) { say(`\n${C.y}需注意：${C.x}`); for (const f of findings.warn) say(`  ${C.y}!${C.x} ${f}`); }
  if (findings.fatal.length) { say(`\n${C.r}${C.B}致命问题：${C.x}`); for (const f of findings.fatal) say(`  ${C.r}✗${C.x} ${f}`); }

  say('');
  if (code === 0 && findings.warn.length === 0) say(`${C.g}${C.B}→ 结论：上游行为符合预期，可以开始实现 M1（纯透传骨架）。${C.x}`);
  else if (code === 0) say(`${C.y}${C.B}→ 结论：可以开始 M1，但把"需注意"项纳入设计。${C.x}`);
  else if (code === 2) say(`${C.r}${C.B}→ 结论：存在互操作问题，请先按上文与中继方确认。${C.x}`);
  else say(`${C.r}${C.B}→ 结论：探测未完成，先解决连通性/凭据问题。${C.x}`);

  try {
    fs.mkdirSync(NOTES_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    probe.meta.finishedAt = new Date().toISOString();
    probe.meta.exitCode = code;
    const jsonPath = path.join(NOTES_DIR, `probe-${stamp}.json`);
    fs.writeFileSync(jsonPath, `${JSON.stringify(probe, null, 2)}\n`, 'utf8');
    const mdPath = path.join(NOTES_DIR, `probe-${stamp}.md`);
    fs.writeFileSync(mdPath, renderMarkdown(), 'utf8');
    say('');
    info('产物 JSON', path.relative(REPO_ROOT, jsonPath));
    info('产物 MD', path.relative(REPO_ROOT, mdPath));
    say(`  ${C.d}不含明文凭据（仅 sha256 前 8 位指纹）${C.x}`);
  } catch (e) {
    warn(`产物落盘失败：${e.message}`);
  }
  process.exit(code);
}

function renderMarkdown() {
  const m = probe.meta, s = probe.stream ?? {}, ct = probe.contract;
  const L = [];
  L.push('# SGW M0 探针报告', '');
  L.push(`- 时间：${m.startedAt} → ${m.finishedAt}`);
  L.push(`- Node：${m.node}`);
  L.push(`- 上游：\`${m.baseUrl}\`　模型：\`${m.model}\``);
  L.push(`- Codex config：\`${m.codexConfigFile}\``);
  L.push(`- 退出码：${m.exitCode}`, '');
  L.push('## 凭据候选（仅指纹）', '', '| id | 来源 | 形态 | 指纹 |', '|---|---|---|---|');
  for (const c of m.credentialCandidates) L.push(`| ${c.id} | ${c.source} | ${c.kind} | \`${c.fp}\` |`);
  L.push('');
  if (probe.matrix?.length) {
    L.push('## 身份矩阵结果', '', '| 凭据 | originator | UA | HTTP | 上游消息 |', '|---|---|---|---|---|');
    for (const r of probe.matrix) {
      L.push(`| ${r.cred} | \`${r.originator}\` | ${r.ua === undefined ? '-' : (String(r.ua).includes('codex_cli_rs') ? 'cli-like' : 'app-like')} | ${r.status ?? 'ERR'} | ${(r.errorMsg ?? '').replace(/\|/g, '\\|').slice(0, 90) || '—'} |`);
    }
    L.push('');
  }
  L.push('## 逐项结论（对应 docs/01 §6）', '', '| 项 | 问题 | 结论 |', '|---|---|---|');
  L.push(`| M0-1 | 是否返回 SSE 流 | ${s.isSse ? '✅ 是' : '❌ 否（' + (s.contentType ?? '?') + '）'} |`);
  L.push(`| M0-2 | usage 字段完整性 | ${ct?.verdict === 'OK' ? '✅ 完整' : ct?.verdict === 'NO_USAGE' ? '⚠️ 不返回 usage' : '❌ 缺：' + (ct?.missing ?? []).join(', ')} |`);
  L.push(`| M0-2b | 是否导致 Codex 硬失败 | ${ct?.verdict === 'FATAL' ? '❌ **会**' : ct?.verdict === 'OK' ? '✅ 不会' : '—'} |`);
  L.push(`| M0-3 | 事件类型数 | ${s.eventTypes ? Object.keys(s.eventTypes).length + ' 种 / ' + s.eventCount + ' 个事件' : '—'} |`);
  L.push(`| M0-4 | 响应压缩 | ${s.contentEncoding && s.contentEncoding !== 'identity' ? '⚠️ ' + s.contentEncoding : '✅ 未压缩'} |`);
  L.push(`| M0-4b | x-request-id | ${s.requestId ? '✅ `' + s.requestId + '`' : '❌ 缺失'} |`);
  L.push(`| M0-4c | x-codex-turn-state | ${s.turnState ? '有 `' + s.turnState + '`' : '无'} |`);
  L.push(`| M0-4d | 限流头 | ${s.rateLimitHeaders?.length ?? 0} 个 |`);
  L.push(`| M0-8 | [DONE] 哨兵 | ${s.sawDoneSentinel ? '有（非标准）' : '无（标准）'} |`);
  L.push('');
  if (s.eventTypes) {
    L.push('## SSE 事件类型清单', '', '| 次数 | 事件类型 |', '|---|---|');
    for (const [t, n] of Object.entries(s.eventTypes)) L.push(`| ${n} | \`${t}\` |`);
    L.push('');
  }
  if (ct?.usage) L.push('## usage 结构实测', '', '```json', JSON.stringify(ct.usage, null, 2), '```', '');
  if (s.timingMs) L.push('## 时序（ms）', '', '```json', JSON.stringify(s.timingMs, null, 2), '```', '');
  if (findings.fatal.length || findings.warn.length || findings.ok.length) {
    L.push('## 结论明细', '');
    for (const f of findings.ok) L.push(`- ✅ ${f}`);
    for (const f of findings.warn) L.push(`- ⚠️ ${f}`);
    for (const f of findings.fatal) L.push(`- ❌ ${f}`);
    L.push('');
  }
  L.push('> 本报告不含明文凭据。');
  return `${L.join('\n')}\n`;
}
