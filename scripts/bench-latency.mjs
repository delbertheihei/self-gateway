#!/usr/bin/env node
/**
 * 性能基准（M4-1）：**验证网关没有引入可测量的延迟**。
 *
 * 方法（对应 docs/06 §9.3）：
 *   - 交替执行 A（直连上游）/ B（经网关），消除时间漂移
 *   - 记录 TTFB（发出请求 → 收到响应头）与总耗时
 *   - 报告中位数差与 p95 差；**判据：p50 差 < 2ms 且 p95 差 < 5ms**
 *
 * 为什么用本地"最小上游"而不是真实中继：
 *   真实中继的延迟抖动（数百 ms 级）会把几毫秒的网关增量完全淹没，
 *   根本**测不出来**。要测的是"网关自身的开销"，就必须让上游的方差尽可能小。
 *   这与 docs/06 的判据一致：测的是增量，不是绝对延迟。
 *
 * 用法：node scripts/bench-latency.mjs [--n 200] [--payload small|large] [--json]
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { start } from '../apps/server/src/index.ts';
import { createLogger } from '../apps/server/src/config/logger.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');

const argv = process.argv.slice(2);
const val = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const N = Number(val('n', '200'));
const PAYLOAD = val('payload', 'small');
const AS_JSON = argv.includes('--json');

const UP_PORT = 18869;
const GW_PORT = 18757;

const C = process.stdout.isTTY
  ? { r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', b: '\x1b[36m', d: '\x1b[2m', B: '\x1b[1m', x: '\x1b[0m' }
  : { r: '', g: '', y: '', b: '', d: '', B: '', x: '' };

// ─────────────────────── 最小上游：低方差，便于测出增量 ───────────────────────

function createUpstream() {
  return http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const body = JSON.stringify({
        id: 'resp_bench', model: 'bench-model',
        usage: {
          input_tokens: 100, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
          output_tokens: 2, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 102,
        },
      });
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': String(Buffer.byteLength(body)),
        'x-request-id': 'rid-bench',
      });
      res.end(body);
    });
  });
}

function oneRequest({ port, body, headers }) {
  return new Promise((resolve, reject) => {
    const t0 = process.hrtime.bigint();
    let headersAt = 0;
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: '/v1/responses',
      headers: { 'content-type': 'application/json', 'content-length': String(body.length), ...headers },
    }, (res) => {
      headersAt = Number(process.hrtime.bigint() - t0) / 1e6;
      res.resume();
      res.on('end', () => {
        const total = Number(process.hrtime.bigint() - t0) / 1e6;
        resolve({ ttfb: headersAt, total, status: res.statusCode });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

// ─────────────────────── 统计工具 ───────────────────────

const sorted = (a) => [...a].sort((x, y) => x - y);
function pct(a, p) {
  if (a.length === 0) return NaN;
  const s = sorted(a);
  const idx = (s.length - 1) * p;
  const lo = Math.floor(idx); const hi = Math.ceil(idx);
  if (lo === hi) return s[lo];
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const sd = (a) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
};

/** Mann-Whitney U 检验（双侧近似正态），判断两组差异是否显著 */
function mannWhitney(a, b) {
  const n1 = a.length; const n2 = b.length;
  if (n1 < 5 || n2 < 5) return { u: NaN, z: NaN, p: NaN };
  const all = [...a.map((v) => ({ v, g: 0 })), ...b.map((v) => ({ v, g: 1 }))].sort((x, y) => x.v - y.v);
  // 秩（含并列取平均秩）
  const ranks = new Array(all.length).fill(0);
  let i = 0;
  while (i < all.length) {
    let j = i;
    while (j + 1 < all.length && all[j + 1].v === all[i].v) j++;
    const avg = (i + j + 2) / 2;
    for (let k = i; k <= j; k++) ranks[k] = avg;
    i = j + 1;
  }
  let r1 = 0;
  for (let k = 0; k < all.length; k++) if (all[k].g === 0) r1 += ranks[k];
  const u1 = r1 - (n1 * (n1 + 1)) / 2;
  const mu = (n1 * n2) / 2;
  const sigma = Math.sqrt((n1 * n2 * (n1 + n2 + 1)) / 12);
  const z = sigma === 0 ? 0 : (u1 - mu) / sigma;
  // 双侧 p（正态近似）
  const p = 2 * (1 - normalCdf(Math.abs(z)));
  return { u: u1, z, p };
}
function normalCdf(x) {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}
function erf(x) {
  const s = Math.sign(x);
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return s * y;
}

// ─────────────────────── 主流程 ───────────────────────

console.log(`${C.B}${'═'.repeat(74)}${C.x}`);
console.log(`${C.B} SGW 性能基准 —— 网关增量延迟（M4-1）${C.x}`);
console.log(`${C.B}${'═'.repeat(74)}${C.x}`);

const upstream = createUpstream();
await new Promise((r) => upstream.listen(UP_PORT, '127.0.0.1', r));

const cfgPath = path.join(REPO_ROOT, '.sgw.config.bench.ts');
fs.writeFileSync(cfgPath, `export default {
  listen: { host: '127.0.0.1', port: ${GW_PORT} },
  upstream: { baseUrl: 'http://127.0.0.1:${UP_PORT}/v1', pathMode: 'auto', stripPrefix: '/v1', probeOnStart: false },
  security: { requireToken: false },
  logging: { level: 'fatal' },
  dataDir: './.sgw-bench-data',
};
`, 'utf8');

// 只起**一个**网关实例，通过开关切换观测状态。
// 理由：两个实例会争抢同一端口，且"同一实例切换开关"才是更诚实的对比 ——
// 排除端口/进程差异，只留下"观测与否"这一个变量。
const gw = await start({
  cwd: REPO_ROOT, configFile: cfgPath,
  logger: createLogger({ level: 'silent', silent: true }), inMemoryDb: true, quiet: true,
});
const gwPort = gw.port;

const payload = PAYLOAD === 'large'
  ? JSON.stringify({
      model: 'bench-model',
      instructions: 'x'.repeat(20_000),
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '中文测试内容'.repeat(2000) }] }],
      store: false, stream: true,
    })
  : JSON.stringify({
      model: 'bench-model',
      instructions: 'Reply briefly.',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'ping' }] }],
      store: false, stream: true,
    });
const bodyBuf = Buffer.from(payload, 'utf8');

console.log(`  ${C.d}样本数 N=${N}（每组）· payload=${PAYLOAD}（${bodyBuf.length} 字节）${C.x}`);
console.log(`  ${C.d}方法：A（直连）/ B（经网关·观测关）/ D（经网关·观测开）三者交替轮换执行${C.x}\n`);

const warmup = 10;
const A = []; const B = []; const D = [];
const Aed = []; const Bed = []; const Ded = [];

// 预热（排除 JIT 与连接建立开销）
gw.recorder.updateSettings({ detailEnabled: false });
for (let i = 0; i < warmup; i++) {
  await oneRequest({ port: UP_PORT, body: bodyBuf, headers: { authorization: 'Bearer bench' } });
  await oneRequest({ port: gwPort, body: bodyBuf, headers: { authorization: 'Bearer bench' } });
}

// ── 第一轮：观测关闭 ──
gw.recorder.updateSettings({ detailEnabled: false });
for (let i = 0; i < N; i++) {
  const order = i % 2 === 0
    ? [['A', UP_PORT], ['B', gwPort]]
    : [['B', gwPort], ['A', UP_PORT]];
  for (const [tag, port] of order) {
    const r = await oneRequest({ port, body: bodyBuf, headers: { authorization: 'Bearer bench' } });
    if (tag === 'A') { A.push(r.ttfb); Aed.push(r.total); } else { B.push(r.ttfb); Bed.push(r.total); }
  }
}

// ── 第二轮：观测开启（对照同一基线 A 的新采样，避免跨轮漂移） ──
gw.recorder.updateSettings({ detailEnabled: true });
const A2 = []; const A2ed = [];
for (let i = 0; i < N; i++) {
  const order = i % 2 === 0
    ? [['A', UP_PORT], ['D', gwPort]]
    : [['D', gwPort], ['A', UP_PORT]];
  for (const [tag, port] of order) {
    const r = await oneRequest({ port, body: bodyBuf, headers: { authorization: 'Bearer bench' } });
    if (tag === 'A') { A2.push(r.ttfb); A2ed.push(r.total); } else { D.push(r.ttfb); Ded.push(r.total); }
  }
}

function report(name, base, treated, baseTotal, treatedTotal) {
  const d50 = pct(treated, 0.5) - pct(base, 0.5);
  const d95 = pct(treated, 0.95) - pct(base, 0.95);
  const d99 = pct(treated, 0.99) - pct(base, 0.99);
  const mw = mannWhitney(base, treated);
  const pass50 = d50 < 2;
  const pass95 = d95 < 5;
  return { name, d50, d95, d99, mw, pass: pass50 && pass95, baseTotal, treatedTotal };
}

const rOff = report('经网关（观测关闭）', A, B, Aed, Bed);
const rOn = report('经网关（观测开启）', A2, D, A2ed, Ded);

console.log(`  ${C.d}TTFB（发出请求 → 收到响应头，单位 ms）${C.x}`);
console.log(`  ${'—'.repeat(72)}`);
const rows = [
  ['直连上游（基线·第1轮）', A],
  ['经网关 · 观测关闭', B],
  ['直连上游（基线·第2轮）', A2],
  ['经网关 · 观测开启', D],
];
console.log(`  ${'组'.padEnd(22)}${'p50'.padStart(9)}${'p95'.padStart(9)}${'p99'.padStart(9)}${'均值'.padStart(9)}${'标准差'.padStart(9)}`);
for (const [label, arr] of rows) {
  console.log(`  ${label.padEnd(22)}${pct(arr, 0.5).toFixed(2).padStart(9)}${pct(arr, 0.95).toFixed(2).padStart(9)}`
    + `${pct(arr, 0.99).toFixed(2).padStart(9)}${mean(arr).toFixed(2).padStart(9)}${sd(arr).toFixed(2).padStart(9)}`);
}

console.log(`\n  ${C.d}增量（经网关 − 直连）${C.x}`);
console.log(`  ${'—'.repeat(70)}`);
for (const r of [rOff, rOn]) {
  const mark = r.pass ? `${C.g}✓ 通过${C.x}` : `${C.r}✗ 超出阈值${C.x}`;
  console.log(`  ${r.name.padEnd(22)} Δp50=${r.d50 >= 0 ? '+' : ''}${r.d50.toFixed(2)}ms`
    + `  Δp95=${r.d95 >= 0 ? '+' : ''}${r.d95.toFixed(2)}ms`
    + `  Δp99=${r.d99 >= 0 ? '+' : ''}${r.d99.toFixed(2)}ms   ${mark}`);
  console.log(`  ${' '.repeat(22)}Mann-Whitney p=${Number.isFinite(r.mw.p) ? r.mw.p.toFixed(3) : 'n/a'}`
    + `${Number.isFinite(r.mw.p) && r.mw.p >= 0.05 ? `  ${C.d}（差异不显著：网关开销被噪声掩盖）${C.x}` : ''}`);
}

// 总耗时对比（含响应体传输）
console.log(`\n  ${C.d}总耗时（发出请求 → 响应结束）${C.x}`);
console.log(`  ${'—'.repeat(70)}`);
console.log(`  直连 p50=${pct(Aed, 0.5).toFixed(2)}ms  p95=${pct(Aed, 0.95).toFixed(2)}ms`);
console.log(`  经网关(观测开) p50=${pct(Ded, 0.5).toFixed(2)}ms  p95=${pct(Ded, 0.95).toFixed(2)}ms`
  + `  Δp50=${(pct(Ded, 0.5) - pct(Aed, 0.5)).toFixed(2)}ms`);

// 资源占用
const mem = process.memoryUsage();
console.log(`\n  ${C.d}资源（本进程，含测试夹具）${C.x}`);
console.log(`  RSS=${(mem.rss / 1024 / 1024).toFixed(1)}MB  heapUsed=${(mem.heapUsed / 1024 / 1024).toFixed(1)}MB`);

const allPass = rOff.pass && rOn.pass;

console.log(`\n${C.B}${'═'.repeat(74)}${C.x}`);
if (allPass) {
  console.log(`  ${C.g}${C.B}✓ 判据满足：Δp50 < 2ms 且 Δp95 < 5ms（观测开关均如此）${C.x}`);
  console.log(`  ${C.d}  即：网关没有引入可测量的延迟增量。${C.x}`);
} else {
  console.log(`  ${C.r}${C.B}✗ 有组别超出阈值（Δp50 < 2ms 且 Δp95 < 5ms）${C.x}`);
}
console.log(`${C.B}${'═'.repeat(74)}${C.x}`);

if (AS_JSON) {
  const out = {
    ranAt: new Date().toISOString(), n: N, payload: PAYLOAD, payloadBytes: bodyBuf.length,
    direct: { p50: pct(A, 0.5), p95: pct(A, 0.95), p99: pct(A, 0.99), mean: mean(A), sd: sd(A), n: A.length },
    gatewayObserveOff: { p50: pct(B, 0.5), p95: pct(B, 0.95), p99: pct(B, 0.99), mean: mean(B), sd: sd(B), n: B.length, deltaP50: rOff.d50, deltaP95: rOff.d95, p: rOff.mw.p },
    gatewayObserveOn: { p50: pct(D, 0.5), p95: pct(D, 0.95), p99: pct(D, 0.99), mean: mean(D), sd: sd(D), n: D.length, deltaP50: rOn.d50, deltaP95: rOn.d95, p: rOn.mw.p },
    directRound2: { p50: pct(A2, 0.5), p95: pct(A2, 0.95), n: A2.length },
    pass: allPass,
  };
  const file = path.join(REPO_ROOT, 'notes', `bench-${Date.now()}.json`);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
    console.log(`  ${C.d}结果已写入 ${path.relative(REPO_ROOT, file)}${C.x}`);
  } catch { /* 忽略 */ }
}

// 清理
try { await gw.close(); } catch { /* ignore */ }
await new Promise((r) => upstream.close(() => r(undefined)));
try { fs.rmSync(cfgPath, { force: true }); } catch { /* ignore */ }
try { fs.rmSync(path.join(REPO_ROOT, '.sgw-bench-data'), { recursive: true, force: true }); } catch { /* ignore */ }
void crypto;

process.exit(allPass ? 0 : 1);
