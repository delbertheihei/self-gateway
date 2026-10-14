#!/usr/bin/env node
/**
 * SGW 端到端冒烟（M3）：真实链路 + 真实数据 + 前端资源可服务。
 *
 * 覆盖内容：
 *   1. 上游 → 网关 → 记账 → 统计 API 的完整数据链路（含 usage 精确提取）
 *   2. 前端构建产物能被网关托管（HTML / JS / CSS，含缓存头）
 *   3. **前端实际会调用的每一个 API** 都返回 200 且结构符合预期
 *   4. 明细开关关闭时，请求表返回明确的 notice 而 KPI 照常有数（核心产品行为）
 *
 * 为什么单独成脚本而不合并进 observe-regression：
 *   前者验证"记账正确性"，本脚本验证"产品可用性"（用户能不能真的看到东西）。
 *
 * 用法：node scripts/e2e-smoke.mjs [--keep]
 * 退出码：0 = 全绿；1 = 有断言失败
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
const UP_PORT = 18879;
const GW_PORT = 18767;

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

// ══════════════════════════ 上游：产生可预测的 usage ══════════════════════════

function createUpstream() {
  let n = 0;
  return http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      n++;
      const body = Buffer.concat(chunks).toString('utf8');
      let model = 'gpt-6-luna';
      try { model = JSON.parse(body).model ?? model; } catch { /* 忽略 */ }
      const url = new URL(req.url, 'http://x');
      // 每个请求递增 usage，便于验证聚合与分位
      const input = 1000 + n * 10;
      const cached = 800;
      const output = 50 + n;
      const reasoning = 10;
      const respId = `resp_e2e_${n}`;
      const sid = req.headers['session-id'] ?? null;

      if (url.pathname.endsWith('/models')) {
        const payload = JSON.stringify({ data: [{ id: model }] });
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) });
        res.end(payload);
        return;
      }
      if (!url.pathname.endsWith('/responses')) {
        res.writeHead(404); res.end('nope'); return;
      }

      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'x-request-id': `rid-e2e-${n}`,
        'openai-model': model,
      });
      res.flushHeaders();
      const frames = [
        `event: response.created\ndata: ${JSON.stringify({ type: 'response.created', sequence_number: 0, response: { id: respId, model, status: 'in_progress', usage: null } })}\n\n`,
        `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', sequence_number: 1, delta: '这是一段用于估算与展示的中文回复内容。' })}\n\n`,
        `event: response.completed\ndata: ${JSON.stringify({
          type: 'response.completed', sequence_number: 2,
          response: {
            id: respId, model, status: 'completed',
            output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '这是一段用于估算与展示的中文回复内容。' }] }],
            usage: {
              input_tokens: input,
              input_tokens_details: { cached_tokens: cached, cache_write_tokens: 0 },
              output_tokens: output,
              output_tokens_details: { reasoning_tokens: reasoning },
              total_tokens: input + output,
            },
          },
        })}\n\n`,
      ];
      let i = 0;
      const tick = () => {
        if (i >= frames.length) { res.end(); return; }
        res.write(frames[i++]);
        setTimeout(tick, 8);
      };
      void sid;
      tick();
    });
  });
}

function request({ port, method = 'GET', path: p, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const finalHeaders = { ...headers };
    if (body && finalHeaders['content-length'] === undefined) {
      finalHeaders['content-length'] = String(Buffer.byteLength(body));
    }
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: finalHeaders }, (res) => {
      const cs = [];
      res.on('data', (c) => cs.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, rawHeaders: res.rawHeaders, body: Buffer.concat(cs) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
const json = (r) => { try { return JSON.parse(r.body.toString('utf8')); } catch { return null; } };

// ══════════════════════════ 启动 ══════════════════════════

say(`${C.B}${'═'.repeat(74)}${C.x}`);
say(`${C.B} SGW 端到端冒烟（M3）${C.x}`);
say(`${C.B}${'═'.repeat(74)}${C.x}`);

const upstream = createUpstream();
await new Promise((r) => upstream.listen(UP_PORT, '127.0.0.1', r));

const tmpFiles = [];
const cfgPath = path.join(REPO_ROOT, '.sgw.config.e2e.ts');
fs.writeFileSync(cfgPath, `export default {
  listen: { host: '127.0.0.1', port: ${GW_PORT} },
  upstream: {
    baseUrl: 'http://127.0.0.1:${UP_PORT}/v1',
    pathMode: 'auto', stripPrefix: '/v1', replaceAuth: false,
    probeOnStart: false, probeModel: 'gpt-6-luna',
  },
  edge: { graceDrainMs: 1200, observeMaxBytes: 524288 },
  security: { requireToken: true },
  logging: { level: 'fatal' },
  dataDir: './.sgw-e2e-data',
};
`, 'utf8');
tmpFiles.push(cfgPath);

const dataDir = path.join(REPO_ROOT, '.sgw-e2e-data');
const gw = await start({
  cwd: REPO_ROOT,
  configFile: cfgPath,
  logger: createLogger({ level: 'silent', silent: true }),
  inMemoryDb: true,
  quiet: true,
});
gw.recorder.updateSettings({ detailEnabled: true });
const TOKEN = gw.tokenGuard.token();

const cleanup = async () => {
  try { await gw.close(); } catch { /* ignore */ }
  await new Promise((r) => upstream.close(() => r(undefined)));
  for (const f of tmpFiles) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
};
process.on('SIGINT', () => { void cleanup().then(() => process.exit(1)); });

/** 与前端 lib/api.ts 一致：所有管理接口都在 /_sgw/api 前缀下 */
const API_PREFIX = '/_sgw/api';

const api = (p, opts = {}) => request({
  port: gw.port, path: `${API_PREFIX}${p}`, ...opts,
  headers: {
    host: `127.0.0.1:${gw.port}`,
    origin: `http://127.0.0.1:${gw.port}`,
    'x-gateway-token': TOKEN,
    ...(opts.body ? { 'content-type': 'application/json' } : {}),
    ...(opts.headers ?? {}),
  },
});

/** 模拟浏览器导航（带 Accept: text/html），用于验证 SPA fallback */
const browser = (p) => request({
  port: gw.port, path: p,
  headers: { host: `127.0.0.1:${gw.port}`, accept: 'text/html,application/xhtml+xml', 'user-agent': 'Mozilla/5.0' },
});

// ══════════════════════════ 1. 产生真实流量 ══════════════════════════

head('1 · 产生真实流量（模拟 Codex 多会话多模型）');

const models = ['gpt-6-luna', 'gpt-6-luna', 'gpt-6-luna', 'gpt-6-mini', 'gpt-6-mini'];
let sent = 0;
for (let i = 0; i < models.length; i++) {
  const body = JSON.stringify({
    model: models[i],
    instructions: '只回一句话。',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '你好，请简短回复' }] }],
    store: false, stream: true, prompt_cache_key: `sess-${i % 2}`,
  });
  const r = await request({
    port: gw.port, method: 'POST', path: '/v1/responses',
    headers: {
      authorization: `Bearer sk-e2e-${crypto.randomBytes(4).toString('hex')}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
      originator: 'codex_cli_rs',
      'session-id': `sess-${i % 2}`,
      'thread-id': `thread-${i}`,
      'content-length': String(Buffer.byteLength(body)),
    },
    body,
  });
  if (r.status === 200) sent++;
}
check(`5 个请求全部经网关成功转发（实际成功 ${sent}）`, sent === models.length);
check('网关记录了 5 条明细', gw.db.get('SELECT COUNT(*) AS n FROM request_event')?.n === 5,
  `实际 ${gw.db.get('SELECT COUNT(*) AS n FROM request_event')?.n}`);

const totalTokensInDb = Number(gw.db.get('SELECT SUM(total_tokens) AS s FROM request_event')?.s ?? 0);
// 期望：第 i 个请求 input=1000+10*(i+1), output=50+(i+1), total=input+output
let expected = 0;
for (let i = 0; i < models.length; i++) expected += (1000 + 10 * (i + 1)) + (50 + (i + 1));
check(`DB 内 total_tokens 合计正确（期望 ${expected}）`, totalTokensInDb === expected, `实际 ${totalTokensInDb}`);
check('全部为上游精确值（无估算）',
  Number(gw.db.get("SELECT COUNT(*) AS n FROM request_event WHERE usage_source='upstream'")?.n) === 5);
check('会话归组生效（2 个会话）',
  Number(gw.db.get('SELECT COUNT(DISTINCT session_id) AS n FROM request_event')?.n) === 2,
  `实际 ${gw.db.get('SELECT COUNT(DISTINCT session_id) AS n FROM request_event')?.n}`);

// ══════════════════════════ 2. 前端资源托管 ══════════════════════════

head('2 · 前端构建产物由网关托管');

const distDir = path.join(REPO_ROOT, 'apps', 'web', 'dist');
const distExists = fs.existsSync(path.join(distDir, 'index.html'));
check('已存在前端构建产物 apps/web/dist/index.html', distExists,
  distExists ? '' : '请先运行：pnpm --filter @sgw/web build');

if (distExists) {
  const html = await browser('/');
  check('GET / 返回 HTML', html.status === 200 && /text\/html/.test(String(html.headers['content-type'] ?? '')),
    `status=${html.status} type=${html.headers['content-type']}`);
  const htmlText = html.body.toString('utf8');
  check('HTML 含应用节点与标题', htmlText.includes('id="root"') && htmlText.includes('<title>'));
  check('HTML 含防 FOUC 的主题引导脚本', htmlText.includes("localStorage.getItem('sgw.theme')"));
  check('HTML 声明 noindex（本地仪表盘不该被索引）', htmlText.includes('noindex'));

  const jsMatch = /src="(\/assets\/[^"]+\.js)"/.exec(htmlText);
  const cssMatch = /href="(\/assets\/[^"]+\.css)"/.exec(htmlText);
  // 绝对路径：hash 路由下相对路径会解析错目录
  check('资源使用绝对路径 /assets/…（hash 路由下必须如此）', jsMatch !== null && jsMatch[1].startsWith('/assets/'),
    `匹配到 ${jsMatch?.[1] ?? '(未匹配)'}`);

  if (jsMatch) {
    const js = await request({ port: gw.port, path: jsMatch[1], headers: { host: `127.0.0.1:${gw.port}` } });
    check('JS 资源可获取', js.status === 200 && js.body.length > 10_000, `status=${js.status} bytes=${js.body.length}`);
    check('JS 资源带长缓存头（内容哈希文件名）',
      String(js.headers['cache-control'] ?? '').includes('immutable'), `cache-control=${js.headers['cache-control']}`);
  }
  if (cssMatch) {
    const css = await request({ port: gw.port, path: cssMatch[1], headers: { host: `127.0.0.1:${gw.port}` } });
    check('CSS 资源可获取', css.status === 200 && css.body.length > 1000, `status=${css.status} bytes=${css.body.length}`);
    const cssText = css.body.toString('utf8');
    check('CSS 含双主题令牌（data-theme 覆盖）', cssText.includes('data-theme'));
    check('CSS 含等宽数字设置（避免数字跳动）', cssText.includes('tabular-nums'));
  }
  const spaFallback = await browser('/some/deep/route');
  check('未匹配的深层路由回落到 index.html（SPA fallback，仅对浏览器导航）',
    spaFallback.status === 200 && /text\/html/.test(String(spaFallback.headers['content-type'] ?? '')),
    `status=${spaFallback.status}`);
  // 非 HTML 请求（例如脚本/爬虫）不该拿到 index.html，否则会产生"软 404"
  const notFound = await request({
    port: gw.port, path: '/not-a-real-endpoint',
    headers: { host: `127.0.0.1:${gw.port}`, accept: 'application/json' },
  });
  check('非浏览器导航（Accept 不含 html）仍返回 404（不产生软 404）',
    notFound.status === 404, `实际 ${notFound.status}`);
}

// ══════════════════════════ 3. 前端实际会调用的所有 API ══════════════════════════

head('3 · 前端实际调用的每个 API 都可用');

const endpoints = [
  // 注意：/health 与 /version 直接返回对象（不包 data 信封），其余接口返回 { data: … }
  ['/health', (d) => d.ok === true && typeof d.version === 'string', true],
  ['/meta', (d) => Array.isArray(d.models) && d.counts.events === 5 && 'storage' in d],
  ['/stats/summary?range=24h', (d) => d.requestCount === 5 && d.totalTokens === expected],
  ['/stats/timeseries?range=24h&bucket=hour&breakdown=type', (d) => Array.isArray(d) && d.length >= 24],
  ['/stats/timeseries?range=24h&bucket=hour&breakdown=model', (d) => Array.isArray(d.models) && d.models.length === 2],
  ['/stats/by-model?range=24h', (d) => Array.isArray(d) && d.some((m) => m.model === 'gpt-6-luna')],
  ['/stats/by-session?range=24h', (d) => Array.isArray(d) && d.length === 2],
  ['/stats/latency?range=24h', (d) => typeof d.p50 === 'number' && d.sampleCount === 5],
  // /requests 的 data 就是请求数组；外层 Page 对象含 meta/warnings
  ['/requests?range=24h&limit=10', (d) => Array.isArray(d) && d.length === 5],
  ['/sessions?limit=10', (d) => Array.isArray(d) && d.length === 2],
  ['/settings', (d) => 'logging' in d && 'retention' in d && 'upstream' in d],
];

for (const [p, validate, unwrapped] of endpoints) {
  const r = await api(p);
  const body = json(r);
  const payload = unwrapped ? body : body?.data;
  const ok = r.status === 200 && validate(payload);
  check(`GET ${p}`, ok, r.status !== 200
    ? `status=${r.status}`
    : `实际类型=${Array.isArray(payload) ? `array(${payload.length})` : typeof payload}；`
      + `顶层键=${payload && typeof payload === 'object' ? Object.keys(payload).join(',') : '—'}`);
}

// 详情 + 正文（正文未开启 → 必须 403 且给出可执行提示）
const firstId = String(gw.db.get('SELECT id FROM request_event ORDER BY started_at LIMIT 1')?.id);
const detail = await api(`/requests/${firstId}`);
check(`GET /requests/:id`, detail.status === 200 && json(detail)?.data?.id === firstId, `status=${detail.status}`);
check('详情含 Codex 身份头与 request-id',
  json(detail)?.data?.originator === 'codex_cli_rs' && String(json(detail)?.data?.upstreamRequestId ?? '').startsWith('rid-e2e-'));

const bodyRes = await api(`/requests/${firstId}/body?side=request`);
check('正文未开启时返回 403 + BODY_LOGGING_DISABLED', bodyRes.status === 403 && json(bodyRes)?.error?.code === 'BODY_LOGGING_DISABLED',
  `status=${bodyRes.status} code=${json(bodyRes)?.error?.code}`);

const csv = await api('/export/requests.csv?range=24h');
check('CSV 导出可用且含表头与 5 行数据',
  csv.status === 200 && csv.body.toString('utf8').split('\n').filter((l) => l.trim()).length === 6,
  `status=${csv.status} 行数=${csv.body.toString('utf8').split('\n').filter((l) => l.trim()).length}`);

const st = await api('/selftest', { method: 'POST', body: '{}' });
check('透传自检全绿', json(st)?.data?.failed === 0,
  `failed=${json(st)?.data?.failed}：${json(st)?.data?.checks?.filter((c) => !c.ok).map((c) => c.name).join('；')}`);

// ══════════════════════════ 4. 关明细后的产品行为 ══════════════════════════

head('4 · 关掉明细后的产品行为（核心设计验证）');

const patch = await api('/settings', {
  method: 'PATCH', body: JSON.stringify({ logging: { detailEnabled: false } }),
});
check('可通过 API 关闭明细', patch.status === 200, `status=${patch.status}`);

const reqAfter = await api('/requests?range=24h&limit=10');
const afterBody = json(reqAfter);
// 关闭明细**不应隐藏历史明细**（只意味着不再记录新请求）
check('★ 关明细后历史明细仍可见（不隐藏已有数据）',
  Array.isArray(afterBody?.data) && afterBody.data.length === 5,
  `data.length=${afterBody?.data?.length}`);
check('附带"新请求不再记录"的 warning',
  (afterBody?.warnings ?? []).some((w) => String(w).startsWith('detail_logging_disabled:')
    || w === 'DETAIL_LOGGING_DISABLED'),
  `warnings=${JSON.stringify(afterBody?.warnings)}`);
check('历史明细场景也带开启指引（用户知道下一步做什么）',
  typeof afterBody?.notice?.hint === 'string' && afterBody.notice.hint.includes('记录请求明细'),
  `notice=${JSON.stringify(afterBody?.notice)?.slice(0, 140)}`);

const sumAfter = json(await api('/stats/summary?range=24h'))?.data;
check('★ 关明细后 KPI 仍然有数（聚合恒写，不归零）', sumAfter?.requestCount === 5,
  `requestCount=${sumAfter?.requestCount}`);

// 用一段"没有匹配结果"的查询条件，验证空结果也是结构化响应
// （注意：path 必须是已转义的 ASCII，否则 Node 的 http 客户端会拒绝）
const emptyRange = await api(`/requests?range=24h&limit=10&q=${encodeURIComponent('no-such-keyword-zzz')}`);
const emptyBody = json(emptyRange);
check('无匹配结果时仍返回结构化响应（HTTP 200 + 空数组）',
  emptyRange.status === 200 && Array.isArray(emptyBody?.data) && emptyBody.data.length === 0,
  `status=${emptyRange.status} data.length=${emptyBody?.data?.length}`);

// 明细关闭时，notice 的文案应区分"区间内有历史"与"区间内无历史"两种情形。
// 注意：`meta.totalApprox` 统计的是该时间范围内**全部**明细（不受 q/模型等筛选影响），
// 因此这里用一个"还没有任何明细"的过去时间区间来触发"无历史"分支。
const pastFrom = Date.now() - 30 * 86_400_000;
const pastTo = Date.now() - 29 * 86_400_000;
const offQuery = `/requests?range=custom&from=${pastFrom}&to=${pastTo}&limit=10`;
const offWithNoData = await api(offQuery);
const offBody = json(offWithNoData);
check('明细关闭且区间内无历史时，notice 文案为「仅保留聚合统计」',
  offWithNoData.status === 200
  && (offBody?.warnings ?? []).includes('DETAIL_LOGGING_DISABLED')
  && typeof offBody?.notice?.message === 'string'
  && offBody.notice.message.includes('仅保留聚合统计'),
  `message=${offBody?.notice?.message} warnings=${JSON.stringify(offBody?.warnings)}`);

const sumBefore = json(await api('/stats/summary?range=24h'))?.data;
check('★ 关明细后 KPI 仍然有数（聚合恒写，不归零）', sumBefore?.requestCount === 5,
  `requestCount=${sumBefore?.requestCount}`);

// 再发一个请求：聚合应增长，但明细不增长
const body = JSON.stringify({ model: 'gpt-6-luna', input: [], stream: true });
await request({
  port: gw.port, method: 'POST', path: '/v1/responses',
  headers: { authorization: 'Bearer sk-x', 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) },
  body,
});
const sumAfter2 = json(await api('/stats/summary?range=24h'))?.data;
check('★ 关明细后新请求仍计入聚合', sumAfter2?.requestCount === 6, `requestCount=${sumAfter2?.requestCount}`);
check('关明细后新请求不写明细',
  gw.db.get('SELECT COUNT(*) AS n FROM request_event')?.n === 5,
  `实际 ${gw.db.get('SELECT COUNT(*) AS n FROM request_event')?.n}`);

const healthAfter = json(await api('/health'))?.logging;
check('/health 反映开关状态', healthAfter?.detailEnabled === false);

// ══════════════════════════ 结果 ══════════════════════════

say(`\n${C.B}${'═'.repeat(74)}${C.x}`);
say(`  ${C.g}通过 ${pass}${C.x}    ${fail ? `${C.r}失败 ${fail}${C.x}` : `${C.d}失败 0${C.x}`}`);
if (failures.length) {
  say(`\n${C.r}${C.B}失败项：${C.x}`);
  for (const f of failures) say(`  ${C.r}✗${C.x} ${f}`);
}
say('');
if (fail === 0) {
  say(`${C.g}${C.B}→ 端到端链路打通：Codex 请求 → 记账 → 统计 API → 仪表盘资源，全部可用。${C.x}`);
  say(`${C.d}  仪表盘地址：http://127.0.0.1:${GW_PORT}/   （首次访问请带上启动日志里的 ?token=…）${C.x}`);
} else {
  say(`${C.r}${C.B}→ 存在失败项。${C.x}`);
}

await cleanup();
process.exit(fail === 0 ? 0 : 1);
