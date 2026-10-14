#!/usr/bin/env node
/**
 * SGW M0-6 / M0-7 探针 —— 「回声上游」
 *
 * 目的：让**真实的 Codex** 把请求打到本机这个假上游上，从而拿到两样东西：
 *   1. Codex 真实发送的**完整请求头集合**（M0-6）—— 网关必须"零白名单"透传它们，
 *      所以我们必须先知道到底有哪些头（例如 x-codex-turn-state、x-oai-attestation）。
 *   2. Codex 真实的**请求体结构**（tools 字段、store、prompt_cache_key 等），
 *      用于校准网关的观测器与估算器。
 *   3. 顺带验证假设 A1：Codex 是否接受纯 http://127.0.0.1 的 base_url（M0-7）。
 *
 * 为什么需要它：直连探测（probe-upstream.mjs）得到 403
 *   "This account only allows Codex official clients"，
 * 说明中继在验"客户端身份"。但**网关本身不需要伪造身份**（它只透传），
 * 所以真正要回答的问题是：真实 Codex 发出的头里，有哪些是我的探测脚本没发的？
 * 只有把 Codex 接到这个回声上游上，才能拿到权威答案。
 *
 * 重要特性：本服务**总是返回一个合法的、带完整 usage 的 SSE 流**，
 *   因此 Codex 在这上面能"正常工作"，不会报错 —— 你可以放心用它验证连通性。
 *
 * 用法：
 *   node scripts/echo-upstream.mjs                 # 监听 127.0.0.1:8899
 *   node scripts/echo-upstream.mjs --port 9000
 *   node scripts/echo-upstream.mjs --delay-ms 1500 # 模拟慢首字节
 *
 * 拿到捕获结果：
 *   notes/echo/*.json  —— 每次请求一个文件，含完整 rawHeaders + body
 *   控制台        —— 实时打印，便于边看边操作 Codex
 *
 * ⚠️ 安全：本服务会把 Authorization 头写入 notes/echo/（这是必要的诊断信息），
 *   但**打印到控制台时脱敏**。notes/ 必须在 .gitignore 中。
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const OUT_DIR = path.join(REPO_ROOT, 'notes', 'echo');

const argv = process.argv.slice(2);
const getVal = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const PORT = Number(getVal('port', 8899));
const HOST = '127.0.0.1';
const DELAY_MS = Number(getVal('delay-ms', 0));
const MAX_BODY = 2 * 1024 * 1024;

const C = process.stdout.isTTY
  ? { r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', b: '\x1b[36m', d: '\x1b[2m', B: '\x1b[1m', x: '\x1b[0m' }
  : { r: '', g: '', y: '', b: '', d: '', B: '', x: '' };

fs.mkdirSync(OUT_DIR, { recursive: true });

const REDACT = new Set(['authorization', 'x-api-key', 'api-key', 'cookie', 'set-cookie', 'proxy-authorization']);
const redactValue = (name, value) => {
  if (!REDACT.has(String(name).toLowerCase())) return value;
  const v = String(value);
  return `${v.slice(0, 10)}…${v.slice(-4)} <redacted len=${v.length} fp=${crypto.createHash('sha256').update(v).digest('hex').slice(0, 8)}>`;
};

let seq = 0;

const server = http.createServer((req, res) => {
  const startedAt = Date.now();
  const id = String(++seq).padStart(3, '0');
  const chunks = [];
  let truncated = false;

  req.on('data', (c) => {
    if (chunks.reduce((n, b) => n + b.length, 0) + c.length > MAX_BODY) { truncated = true; return; }
    chunks.push(c);
  });

  req.on('end', async () => {
    const body = Buffer.concat(chunks);
    const bodyText = body.toString('utf8');

    // ── 1. 结构化保存（rawHeaders 含原始大小写与重复头） ──
    const record = {
      seq: id,
      at: new Date().toISOString(),
      method: req.method,
      url: req.url,
      httpVersion: req.httpVersion,
      socket: { remoteAddress: req.socket.remoteAddress, remotePort: req.socket.remotePort, localPort: req.socket.localPort, alpn: req.socket.alpnProtocol ?? null },
      tls: req.socket.encrypted ? { protocol: req.socket.getProtocol?.(), cipher: req.socket.getCipher?.() } : null,
      rawHeaders: req.rawHeaders,
      headers: req.headers,
      bodyBytes: body.length,
      bodyTruncated: truncated,
      bodySha256: crypto.createHash('sha256').update(body).digest('hex'),
      bodyText,
      bodyJson: (() => { try { return JSON.parse(bodyText); } catch { return null; } })(),
    };
    const file = path.join(OUT_DIR, `${record.at.replace(/[:.]/g, '-')}-${id}.json`);
    fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8');

    // ── 2. 控制台摘要（脱敏） ──
    console.log(`\n${C.B}${'━'.repeat(72)}${C.x}`);
    console.log(`${C.B}[${id}] ${req.method} ${req.url}  HTTP/${req.httpVersion}  ${body.length}B${truncated ? ' (截断)' : ''}${C.x}`);
    console.log(`${C.d}    ${record.at}  来自 ${req.socket.remoteAddress}:${req.socket.remotePort} → :${req.socket.localPort}${req.socket.encrypted ? `  TLS(${req.socket.alpnProtocol})` : '  明文HTTP'}${C.x}`);

    console.log(`${C.b}  ── 请求头（共 ${req.rawHeaders.length / 2} 个）──${C.x}`);
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const n = req.rawHeaders[i]; const v = redactValue(n, req.rawHeaders[i + 1]);
      console.log(`    ${C.d}${n}:${C.x} ${v}`);
    }

    if (record.bodyJson) {
      const j = record.bodyJson;
      console.log(`${C.b}  ── 请求体要点 ──${C.x}`);
      const keys = ['model', 'stream', 'store', 'prompt_cache_key', 'previous_response_id', 'max_output_tokens', 'parallel_tool_calls', 'tool_choice', 'service_tier', 'reasoning', 'include'];
      for (const k of keys) if (k in j) console.log(`    ${C.d}${k}:${C.x} ${JSON.stringify(j[k]).slice(0, 120)}`);
      if (Array.isArray(j.tools)) console.log(`    ${C.d}tools:${C.x} ${j.tools.length} 个 [${j.tools.map((t) => t?.name ?? t?.type ?? '?').join(', ').slice(0, 160)}]`);
      if (Array.isArray(j.input)) console.log(`    ${C.d}input:${C.x} ${j.input.length} 项 [${[...new Set(j.input.map((x) => x?.type ?? '?'))].join(', ')}]`);
      if (typeof j.instructions === 'string') console.log(`    ${C.d}instructions:${C.x} ${j.instructions.length} 字符`);
      const others = Object.keys(j).filter((k) => !keys.includes(k) && !['tools', 'input', 'instructions'].includes(k));
      if (others.length) console.log(`    ${C.d}其他字段:${C.x} ${others.join(', ')}`);
    } else if (bodyText) {
      console.log(`${C.b}  ── 请求体（前 400 字符，非 JSON）──${C.x}`);
      console.log(`    ${C.d}${bodyText.slice(0, 400)}${C.x}`);
    }

    console.log(`${C.g}  → 已保存 ${path.relative(REPO_ROOT, file)}${C.x}`);

    // ── 3. 返回一个合法、完整、带 usage 的 SSE 响应 ──
    //    刻意做得和 OpenAI Responses API 一致，让 Codex 能正常走完这一轮。
    const model = record.bodyJson?.model ?? 'gpt-6-luna';
    const respId = `resp_echo_${crypto.randomBytes(8).toString('hex')}`;
    const now = Math.floor(Date.now() / 1000);
    const created = { type: 'response.created', sequence_number: 0, response: { id: respId, object: 'response', created_at: now, model, status: 'in_progress', output: [], usage: null } };
    const inProgress = { type: 'response.in_progress', sequence_number: 1, response: { id: respId, object: 'response', created_at: now, model, status: 'in_progress', output: [], usage: null } };
    const itemAdded = { type: 'response.output_item.added', sequence_number: 2, output_index: 0, item: { id: `msg_echo_${crypto.randomBytes(6).toString('hex')}`, type: 'message', status: 'in_progress', role: 'assistant', content: [] } };
    const text = `SGW echo upstream 已收到你的请求 [${id}]。这是一个本地假上游，用于捕获 Codex 真实发送的请求头与请求体。请在 notes/echo/ 查看完整捕获。`;
    const delta = { type: 'response.output_text.delta', sequence_number: 3, item_id: itemAdded.item.id, output_index: 0, content_index: 0, delta: text };
    const usage = {
      input_tokens: 1234,
      input_tokens_details: { cached_tokens: 1024, cache_write_tokens: 0 },
      output_tokens: 56,
      output_tokens_details: { reasoning_tokens: 12 },
      total_tokens: 1290,
    };
    const completed = {
      type: 'response.completed', sequence_number: 4,
      response: {
        id: respId, object: 'response', created_at: now, model, status: 'completed',
        output: [{ id: itemAdded.item.id, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] }],
        usage, end_turn: true,
      },
    };

    const sse = [
      `event: response.created\ndata: ${JSON.stringify(created)}\n\n`,
      `event: response.in_progress\ndata: ${JSON.stringify(inProgress)}\n\n`,
      `event: response.output_item.added\ndata: ${JSON.stringify(itemAdded)}\n\n`,
      `event: response.output_text.delta\ndata: ${JSON.stringify(delta)}\n\n`,
      `event: response.completed\ndata: ${JSON.stringify(completed)}\n\n`,
    ];

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-request-id': `echo-${id}-${crypto.randomBytes(4).toString('hex')}`,
      'openai-model': model,
      'x-codex-turn-state': 'echo-turn-state-0001',   // 让 Codex 能测"回放"路径
    });
    res.flushHeaders();
    res.socket?.setNoDelay(true);

    const writeWithDelay = (chunk) => new Promise((r) => { res.write(chunk); setTimeout(r, 40); });
    if (DELAY_MS > 0) await new Promise((r) => setTimeout(r, DELAY_MS));
    for (const frame of sse) {
      if (res.writableEnded || res.destroyed) break;
      await writeWithDelay(frame);
    }
    if (!res.writableEnded && !res.destroyed) res.end();
    console.log(`${C.d}  ← 已返回 SSЕ (5 事件, usage.total_tokens=1290, ${Date.now() - startedAt}ms)${C.x}`);
  });
});

server.requestTimeout = 0;          // 与网关设计一致：不掐断长流（docs/02 ADR-14）
server.headersTimeout = 60_000;
server.keepAliveTimeout = 65_000;

// WebSocket 升级尝试：Codex 若开了 supports_websockets 会打到这里 —— 正是 M0-8 要观测的
server.on('upgrade', (req, socket) => {
  const id = String(++seq).padStart(3, '0');
  const rec = { seq: id, at: new Date().toISOString(), kind: 'websocket-upgrade-attempt', method: req.method, url: req.url, rawHeaders: req.rawHeaders };
  const file = path.join(OUT_DIR, `${rec.at.replace(/[:.]/g, '-')}-${id}-ws.json`);
  fs.writeFileSync(file, `${JSON.stringify(rec, null, 2)}\n`, 'utf8');
  console.log(`\n${C.y}${C.B}[${id}] ⚠ 收到 WebSocket 升级请求：${req.method} ${req.url}${C.x}`);
  console.log(`${C.y}    这说明 Codex 启用了 supports_websockets —— 本网关 v1 不支持，需要改回 false。${C.x}`);
  for (let i = 0; i < req.rawHeaders.length; i += 2) console.log(`    ${C.d}${req.rawHeaders[i]}:${C.x} ${redactValue(req.rawHeaders[i], req.rawHeaders[i + 1])}`);
  console.log(`${C.g}  → 已保存 ${path.relative(REPO_ROOT, file)}${C.x}`);
  socket.write('HTTP/1.1 501 Not Implemented\r\nConnection: close\r\n\r\n');
  socket.destroy();
});

server.listen(PORT, HOST, () => {
  console.log(`${C.B}${'═'.repeat(72)}${C.x}`);
  console.log(`${C.B} SGW 回声上游（Echo Upstream）—— 用于捕获 Codex 真实请求${C.x}`);
  console.log(`${C.B}${'═'.repeat(72)}${C.x}`);
  console.log(`  监听          ${C.g}http://${HOST}:${PORT}${C.x}`);
  console.log(`  捕获输出      ${path.relative(REPO_ROOT, OUT_DIR)}\\`);
  console.log(`  模拟慢首字节  ${DELAY_MS}ms`);
  console.log(`  requestTimeout ${C.g}0${C.x}（不掐断长流）`);
  console.log('');
  console.log(`${C.y}接下来：${C.x}`);
  console.log(`  1. 另开一个终端，运行切换脚本（会自动备份 config.toml）：`);
  console.log(`     ${C.b}node scripts/point-codex.mjs --port ${PORT}${C.x}`);
  console.log(`  2. 在 Codex 里随便发一句话（例如"你好"）。`);
  console.log(`  3. 回到本终端看捕获的头与请求体；或直接看 ${path.relative(REPO_ROOT, OUT_DIR)}\\。`);
  console.log(`  4. 恢复直连：${C.b}node scripts/point-codex.mjs --restore${C.x}`);
  console.log('');
  console.log(`${C.d}本服务总是返回合法的 SSE + 完整 usage，所以 Codex 在这上面能正常工作，不会报错。${C.x}`);
  console.log(`${C.d}按 Ctrl+C 停止。${C.x}`);
});

process.on('SIGINT', () => { console.log(`\n${C.d}停止回声上游。捕获文件保留在 ${path.relative(REPO_ROOT, OUT_DIR)}\\${C.x}`); process.exit(0); });
