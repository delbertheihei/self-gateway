/**
 * 长稳（soak）测试：持续流量下观察 RSS 与句柄是否泄漏。
 * 用法：node scripts/soak.mjs [--minutes 8] [--interval 1500]
 * 判据：RSS 增长 < 25%，activeHandles 不单调增长（无泄漏迹象）
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
const MINUTES = Number(val('minutes', '8'));
const INTERVAL = Number(val('interval', '1500'));
const UP = 18849; const GW = 18737;

const up = http.createServer((req, res) => {
  const cs = []; req.on('data', c => cs.push(c));
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');
    if (!url.pathname.endsWith('/responses')) { res.writeHead(404); res.end(); return; }
    const isStream = cs.length > 0;
    const payload = 'A'.repeat(2048);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'rid-soak' });
    const frames = [
      `event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { id: 'r', model: 'soak', usage: null } })}\n\n`,
      `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: payload })}\n\n`,
      `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: 'r', model: 'soak', usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 40, cache_write_tokens: 0 }, output_tokens: 20, output_tokens_details: { reasoning_tokens: 5 }, total_tokens: 120 } } })}\n\n`,
    ];
    let i = 0;
    const tick = () => { if (i >= frames.length) { res.end(); return; } res.write(frames[i++]); setTimeout(tick, 4); };
    void isStream;
    tick();
  });
});
await new Promise(r => up.listen(UP, '127.0.0.1', r));

const cfg = path.join(REPO_ROOT, '.sgw.config.soak.ts');
fs.writeFileSync(cfg, `export default { listen:{host:'127.0.0.1',port:${GW}}, upstream:{baseUrl:'http://127.0.0.1:${UP}/v1', stripPrefix:'/v1', probeOnStart:false}, edge:{graceDrainMs:500}, security:{requireToken:false}, logging:{level:'fatal'}, dataDir:'./.sgw-soak-data' };\n`);
const gw = await start({ cwd: REPO_ROOT, configFile: cfg, logger: createLogger({ level: 'silent', silent: true }), inMemoryDb: true, quiet: true });
gw.recorder.updateSettings({ detailEnabled: true });

function req() {
  return new Promise((resolve) => {
    const body = JSON.stringify({ model: 'soak', input: [], stream: true });
    const r = http.request({ host: '127.0.0.1', port: gw.port, method: 'POST', path: '/v1/responses',
      headers: { 'content-type': 'application/json', authorization: 'Bearer sk-soak', 'session-id': 'soak-sess', 'content-length': String(Buffer.byteLength(body)) } }, x => {
      const cs = []; x.on('data', c => cs.push(c)); x.on('end', () => resolve(cs.length)); x.on('error', () => resolve(0));
    });
    r.on('error', () => resolve(0));
    r.write(body); r.end();
  });
}
function longReq() {   // 模拟流式长响应：客户端提前断开（触发宽限期排空路径）
  return new Promise((resolve) => {
    const body = '{}';
    const r = http.request({ host: '127.0.0.1', port: gw.port, method: 'POST', path: '/v1/responses',
      headers: { 'content-type': 'application/json', authorization: 'Bearer sk-soak', 'content-length': '2' } }, x => {
      x.once('data', () => { r.destroy(); resolve(1); });
      x.on('error', () => resolve(0));
    });
    r.on('error', () => resolve(0));
    r.write(body); r.end();
  });
}

const samples = [];
const t0 = Date.now();

/** 活跃句柄数（Node 未公开 API，仅用于观察趋势；取不到则记 0） */
function activeHandles() {
  try {
    const fn = process._getActiveHandles;
    return typeof fn === 'function' ? fn.call(process).length : 0;
  } catch { return 0; }
}

const endAt = t0 + MINUTES * 60_000;
let n = 0;
const baselineRss = process.memoryUsage().rss;
console.log(`[soak] 开始：${MINUTES} 分钟，间隔 ${INTERVAL}ms，基线 RSS=${(baselineRss/1048576).toFixed(1)}MB`);

while (Date.now() < endAt) {
  n++;
  // 每 10 次插入一次"客户端提前断开"，覆盖宽限期排空路径
  if (n % 10 === 0) await longReq(); else await req();
  const m = process.memoryUsage();
  samples.push({ t: Date.now() - t0, rss: m.rss, heap: m.heapUsed, handles: activeHandles(), req: n });
  if (n % 40 === 0) {
    const last = samples[samples.length - 1];
    console.log(`[soak] t=${Math.round((last.t)/1000)}s  reqs=${last.req}  RSS=${(last.rss/1048576).toFixed(1)}MB  heap=${(last.heap/1048576).toFixed(1)}MB  handles=${last.handles}`);
  }
  await new Promise(r => setTimeout(r, INTERVAL));
}

const first = samples.slice(0, Math.max(1, Math.floor(samples.length * 0.2)));
const lastS = samples.slice(-Math.max(1, Math.floor(samples.length * 0.2)));
const avg = (a, k) => a.reduce((s, x) => s + x[k], 0) / a.length;
const rss0 = avg(first, 'rss'); const rss1 = avg(lastS, 'rss');
const growth = (rss1 - rss0) / rss0;
const h0 = avg(first, 'handles'); const h1 = avg(lastS, 'handles');
const eventCount = Number(gw.db.get('SELECT COUNT(*) AS n FROM request_event')?.n ?? 0);

const result = {
  minutes: MINUTES, intervalMs: INTERVAL, requests: n, recordedEvents: eventCount,
  rssStartMB: rss0 / 1048576, rssEndMB: rss1 / 1048576, rssGrowthPct: growth * 100,
  handlesStart: h0, handlesEnd: h1,
  pass: growth < 0.25 && h1 <= h0 + 5,
};
console.log('\n[soak] 结果:', JSON.stringify(result, null, 2));
const out = path.join(REPO_ROOT, 'notes', `soak-${Date.now()}.json`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ ...result, samples: samples.filter((_, i) => i % 5 === 0) }, null, 2));
console.log(`[soak] 已写入 ${path.relative(REPO_ROOT, out)}`);
console.log(result.pass ? '[soak] ✓ 无泄漏迹象' : '[soak] ✗ 疑似泄漏');

await gw.close();
await new Promise(r => up.close(() => r(undefined)));
fs.rmSync(cfg, { force: true }); fs.rmSync(path.join(REPO_ROOT, '.sgw-soak-data'), { recursive: true, force: true });
process.exit(result.pass ? 0 : 1);
