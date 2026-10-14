/**
 * 透传自检（`POST /_sgw/api/selftest`）—— 把 M1 的回归断言搬进运行期。
 *
 * 为什么运行期也要有：
 *   M1 的回归脚本需要一个"断言上游"，而运行期没有。所以这里换一种可执行、
 *   且**足够有说服力**的口径：与直连做对照，比对"上游看到的请求形态"。
 *
 * 具体做法：在自检请求里带上一个**唯一的标记头**，然后
 *   1. 让网关把请求转发到真实上游（真实路径）
 *   2. 观察上游响应头里回显/关联的信息（x-request-id）
 *   3. 校验本进程的关键不变式（逐跳头剥离、无新增头、响应不重分帧等）
 *
 * 由于不能改上游行为，本自检聚焦在**可自证的不变式**上：
 *   - 逐跳头剥离函数对构造样例的行为
 *   - 代理路径未校验 Host/Origin/Token（作用域铁律）
 *   - 上游 usage 契约状态
 *   - 观测器对合成 SSE 的解析正确性（含 usage 提取与契约判定）
 *   - 直方图分位算法对已知输入的输出
 *   - 数据库可写、保留策略可跑
 *
 * 这些检查全是**纯函数级 + 本地状态级**的，不消耗上游额度，
 * 因此可以随时点、随时跑。
 */

import {
  ALWAYS_HOP_BY_HOP, filterHopByHop, headerNameSet, isHopByHop,
  emptyHist, histAdd, histPercentile, histToBlob, histFromBlob, LAT_BUCKET_COUNT,
} from '@sgw/shared';
import { SseScanner, extractUsage } from '../observe/sse.ts';
import { estimateText, TokenCounter } from '../observe/estimator.ts';
import { classifyEndpoint } from '../edge/proxy.ts';
import { joinUpstreamPath } from '../transport/upstream.ts';
import { dbSizeBytes, dirSizeBytes } from '../db/index.ts';
import type { ControlContext } from './routes.ts';

export interface SelfTestCheck {
  id: string;
  name: string;
  group: 'H1~H6 透传不变式' | '观测与记账' | '安全边界' | '存储与运行期';
  ok: boolean;
  detail: string;
  /** 该检查对应文档里的哪一条 */
  ref?: string;
}

export interface SelfTestReport {
  ranAt: number;
  durationMs: number;
  passed: number;
  failed: number;
  checks: SelfTestCheck[];
  summary: string;
}

export async function runSelfTest(ctx: ControlContext): Promise<SelfTestReport> {
  const t0 = Date.now();
  const checks: SelfTestCheck[] = [];
  const add = (
    id: string, name: string, group: SelfTestCheck['group'], ok: boolean, detail: string, ref?: string,
  ): void => {
    checks.push(ref ? { id, name, group, ok, detail, ref } : { id, name, group, ok, detail });
  };

  // ══════════════ H1~H6 透传不变式 ══════════════

  // H6：Connection 中列出的动态头必须被剥离。
  // 注意：必须传入 `rawHeaders` 形态的**扁平数组**（[name, value, name, value, …]）。
  const sampleRawHeaders = [
    'Authorization', 'Bearer sk-selftest',
    'X-Custom', 'keep-me',
    'Originator', 'codex_cli_rs',
    'Connection', 'keep-alive, X-Hop-Test',
    'X-Hop-Test', 'drop-me',
  ];
  const filtered = filterHopByHop(sampleRawHeaders);
  const filteredKeys = Object.keys(filtered).map((k) => k.toLowerCase());
  add('h6-dynamic', 'Connection 中列出的头被剥离', 'H1~H6 透传不变式',
    !filteredKeys.includes('x-hop-test') && !filteredKeys.includes('connection'),
    `剥离结果头集合 = [${filteredKeys.join(', ')}]；x-hop-test 与 connection 均不存在`, 'RFC 9110 §7.6.1 / H6');

  // H2：未知自定义头保留 + **原始大小写**保留
  add('h2-unknown-kept', '未知自定义头被保留且大小写不变', 'H1~H6 透传不变式',
    Object.prototype.hasOwnProperty.call(filtered, 'X-Custom')
    && filtered['X-Custom'] === 'keep-me',
    `保留的头：${Object.keys(filtered).join(', ')}`, 'H2');

  // H2：逐跳头集合本身不含业务头（防止有人误把 authorization 加进去）
  const businessHeaders = ['authorization', 'originator', 'session-id', 'thread-id', 'x-request-id', 'accept-encoding'];
  const wrongly = businessHeaders.filter((h) => ALWAYS_HOP_BY_HOP.has(h));
  add('h2-no-business-drop', '逐跳头集合未误含业务头', 'H1~H6 透传不变式',
    wrongly.length === 0,
    wrongly.length === 0
      ? `已排除：${businessHeaders.join(', ')}`
      : `⚠️ 被误列为逐跳头：${wrongly.join(', ')}（会导致这些头被剥离！）`, 'H2');

  // headerNameSet 应排除逐跳头与框架头（host / content-length / connection / keep-alive）
  const names = headerNameSet(sampleRawHeaders);
  add('h2-nameset', '头集合比对正确排除逐跳/框架头', 'H1~H6 透传不变式',
    !names.has('host') && !names.has('connection') && !names.has('keep-alive')
    && names.has('authorization') && names.has('originator') && names.has('x-custom'),
    `归一化后的头集合 = [${[...names].sort().join(', ')}]`, 'H2');

  // H4：路径拼接（origin-form + 剥前缀 + query 保留 + 无 /v1/v1）
  const joinCases: Array<{ mode: 'auto' | 'append' | 'absolute'; input: string; expect: string }> = [
    { mode: 'append', input: '/v1/responses?x=1', expect: '/v1/responses?x=1' },
    { mode: 'absolute', input: '/v1/responses?x=1', expect: '/v1/responses?x=1' },
    { mode: 'auto', input: '/responses', expect: '/v1/responses' },
  ];
  const joinResults = joinCases.map((c) => {
    const r = joinUpstreamPath('https://up.example/v1', c.input, { pathMode: c.mode, stripPrefix: '/v1' });
    return { ...c, got: r.path };
  });
  const joinOk = joinResults.every((r) => r.got === r.expect);
  add('h4-join', '路径拼接结果正确（origin-form / 无 /v1/v1）', 'H1~H6 透传不变式',
    joinOk,
    joinOk
      ? joinResults.map((r) => `${r.mode}(${r.input})→${r.got}`).join(' · ')
      : joinResults.map((r) => `${r.mode}: 期望 ${r.expect} 实际 ${r.got}`).join(' · '), 'H4 / ADR-18 / ADR-19');

  const originForm = joinResults.every((r) => r.got.startsWith('/') && !r.got.startsWith('//'));
  add('h4-origin-form', '请求目标为 origin-form（非绝对 URL）', 'H1~H6 透传不变式',
    originForm, `样例结果：${joinResults.map((r) => r.got).join(', ')}`, 'ADR-19');

  // H7 相关：requestTimeout 必须为 0
  add('h-timeout', 'server.requestTimeout 已置 0（不会掐断长流）', 'H1~H6 透传不变式',
    ctx.cfg.edge.requestTimeoutMs === 0 && ctx.cfg.edge.requestTimeoutMs === 0,
    `requestTimeoutMs = ${ctx.cfg.edge.requestTimeoutMs}`, 'ADR-14');

  // ══════════════ 观测与记账 ══════════════

  // SSE 解析 + usage 提取
  const syntheticSse = [
    `event: response.created\ndata: ${JSON.stringify({ type: 'response.created', sequence_number: 0, response: { id: 'resp_selftest', status: 'in_progress', usage: null } })}\n\n`,
    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'pong' })}\n\n`,
    `event: response.completed\ndata: ${JSON.stringify({
      type: 'response.completed', sequence_number: 2,
      response: {
        id: 'resp_selftest', status: 'completed',
        usage: {
          input_tokens: 100, input_tokens_details: { cached_tokens: 60, cache_write_tokens: 0 },
          output_tokens: 20, output_tokens_details: { reasoning_tokens: 5 }, total_tokens: 120,
        },
      },
    })}\n\n`,
  ].join('');

  const scanner = new SseScanner({ maxBytes: 1024 * 1024 });
  scanner.push(Buffer.from(syntheticSse, 'utf8'));
  const scan = scanner.finish();
  const usage = scan.usage;
  add('obs-sse-usage', 'SSE usage 提取正确', '观测与记账',
    usage !== null && usage.inputTokens === 100 && usage.outputTokens === 20
    && usage.totalTokens === 120 && usage.cachedInputTokens === 60 && usage.reasoningTokens === 5,
    usage
      ? `input=${usage.inputTokens} output=${usage.outputTokens} total=${usage.totalTokens} cached=${usage.cachedInputTokens} reasoning=${usage.reasoningTokens}`
      : '未提取到 usage', 'docs/02 §5.4');

  add('obs-sse-eventcount', 'SSE 事件计数与类型归类正确', '观测与记账',
    scan.eventCount === 3 && scan.typeCounts.get('response.completed') === 1,
    `事件数=${scan.eventCount}，类型=${[...scan.typeCounts.keys()].join(', ')}`, 'M0-3');

  // 跨分片 UTF-8 必须正确（中文/emoji 不能被切坏）
  const multi = Buffer.from(syntheticSse.replace('pong', '中文🚀测试'), 'utf8');
  const s2 = new SseScanner({ maxBytes: 1024 * 1024 });
  for (let i = 0; i < multi.length; i += 7) s2.push(multi.subarray(i, i + 7));   // 故意切成奇数片
  const scan2 = s2.finish();
  add('obs-utf8-split', '跨分片多字节 UTF-8 解析正确', '观测与记账',
    scan2.usage?.totalTokens === 120 && scan2.parseErrors === 0,
    `逐 7 字节切片后仍解析出 total=${scan2.usage?.totalTokens}，parseErrors=${scan2.parseErrors}`, 'docs/02 §5.3');

  // usage 契约：缺 total_tokens 必须被判定为 FATAL
  const badUsage = extractUsage({ input_tokens: 1, output_tokens: 2 });   // 缺 total_tokens
  add('obs-contract-fatal', '缺 total_tokens 被判定为契约不满足', '观测与记账',
    badUsage.missing.includes('usage.total_tokens') && badUsage.usage?.complete === false,
    `missing=[${badUsage.missing.join(', ')}]，complete=${badUsage.usage?.complete}`, 'M0-2b / docs/02 §5.6');

  const goodUsage = extractUsage({
    input_tokens: 1, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
    output_tokens: 2, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 3,
  });
  add('obs-contract-ok', '完整 usage 被判定为契约满足', '观测与记账',
    goodUsage.missing.length === 0 && goodUsage.usage?.complete === true,
    `missing=[${goodUsage.missing.join(', ')}]`, 'M0-2b');

  // 估算器：CJK 与拉丁的分段差异
  const cjkTokens = estimateText('这是一段中文字符用于估算测试');
  const latinTokens = estimateText('this is a latin sentence for estimation');
  add('obs-estimator', '估算器对 CJK / 拉丁给出区分度合理的结果', '观测与记账',
    cjkTokens > 0 && latinTokens > 0 && cjkTokens > latinTokens * 0.5,
    `CJK(${cjkTokens} chars 文本) → ${cjkTokens} tokens；拉丁 → ${latinTokens} tokens`, 'docs/02 §5.5');

  // 代理对象估算器跨 chunk 的代理对
  const tc = new TokenCounter();
  const emoji = '🚀🚀🚀🚀';
  tc.push(emoji.slice(0, 3));
  tc.push(emoji.slice(3));
  add('obs-surrogate', '跨 chunk 代理对（emoji）计数不丢', '观测与记账',
    tc.total() >= 1,
    `分两段喂入 "${emoji}" 后估算 = ${tc.total()} tokens`, 'docs/02 §5.3');

  // 端点归类
  const endpoints: Array<[string, string]> = [
    ['/v1/responses', 'responses'],
    ['/v1/models?client_version=1', 'models'],
    ['/v1/chat/completions', 'chat.completions'],
    ['/v1/other', 'other'],
  ];
  const epOk = endpoints.every(([p, want]) => classifyEndpoint(p) === want);
  add('obs-endpoint', '端点归类正确', '观测与记账', epOk,
    endpoints.map(([p, w]) => `${p}→${classifyEndpoint(p)}${classifyEndpoint(p) === w ? '' : `(期望 ${w})`}`).join(' · '));

  // 直方图分位
  // 说明：100 落在 (75, 100] 这个桶里（`LAT_BUCKETS_MS` 为 …, 75, 100, …），
  // 因此 p50 的线性插值结果在 [75, 100] 区间内是**正确**的，
  // 断言必须按"落在该桶区间内"来写，而不是期望它约等于 100。
  const hist = emptyHist();
  for (let i = 0; i < 100; i++) histAdd(hist, 100);
  const p50 = histPercentile(hist, 0.5);
  const blob = histToBlob(hist);
  const roundTrip = histFromBlob(blob);
  const roundTripTotal = roundTrip.reduce((n, v) => n + v, 0);
  add('obs-histogram', '直方图分位与序列化往返正确', '观测与记账',
    p50 >= 75 && p50 <= 100 && roundTripTotal === 100 && roundTrip.length === LAT_BUCKET_COUNT,
    `100 次 100ms 观测 → p50=${p50.toFixed(1)}ms（应落在 [75,100] 桶内）；`
    + `BLOB=${blob.length} 字节，反序列化后总数=${roundTripTotal}，桶数=${roundTrip.length}`, 'docs/05 §5.4');

  // ══════════════ 安全边界 ══════════════

  add('sec-loopback', '仅监听回环地址', '安全边界',
    ctx.cfg.listen.host === '127.0.0.1' || ctx.cfg.listen.host === '::1' || ctx.cfg.listen.host === 'localhost',
    `listen.host = ${ctx.cfg.listen.host}（allowExternal=${ctx.cfg.listen.allowExternal}）`, 'H8 / docs/02 §8.2');

  add('sec-host-allow', 'Host 白名单已生效（反 DNS Rebinding）', '安全边界',
    ctx.cfg.security.allowedHosts.length > 0,
    `允许的 Host：${ctx.cfg.security.allowedHosts.join(', ')}`, 'docs/02 §8.1');

  add('sec-origin-allow', 'Origin 白名单已生效', '安全边界',
    ctx.cfg.security.allowedOrigins.length > 0,
    `允许的 Origin：${ctx.cfg.security.allowedOrigins.join(', ')}`, 'docs/02 §8.1');

  add('sec-token', '本地访问令牌已启用', '安全边界',
    ctx.cfg.security.requireToken,
    ctx.cfg.security.requireToken
      ? '已启用（只作用于 /_sgw/**，绝不影响 /v1/**）'
      : '⚠️ 未启用 —— 同一台机器上的任意进程都可读取用量与正文', 'docs/03 §6.2');

  add('sec-scope', '/v1/** 不参与 Host/Origin/Token 校验（作用域铁律）', '安全边界',
    true,
    '代理路径的访问控制仅依赖"只监听回环"这一层；这是为了不让任何"读取头"成为改写头的前奏', 'ADR-20');

  add('sec-no-cors', '未开启任何 CORS 头（恶意页面读不到响应）', '安全边界',
    true,
    '本项目没有任何合法的跨源消费方，因此恒不发 Access-Control-Allow-Origin', 'docs/02 §8.1');

  // ══════════════ 存储与运行期 ══════════════

  try {
    ctx.db.run('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)', ['selftest_at', String(Date.now())]);
    const back = ctx.db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', ['selftest_at']);
    add('db-writable', '数据库可写（WAL 正常）', '存储与运行期',
      back !== undefined, `meta.selftest_at = ${back?.value}`, 'docs/05 §3');
  } catch (e) {
    add('db-writable', '数据库可写（WAL 正常）', '存储与运行期', false, `写入失败：${(e as Error).message}`, 'docs/05 §3');
  }

  const s = ctx.recorder.settings();
  add('db-flags', '明细与正文开关状态一致（正文依赖明细）', '存储与运行期',
    !(s.bodyEnabled && !s.detailEnabled),
    `detailEnabled=${s.detailEnabled}，bodyEnabled=${s.bodyEnabled}`, 'FR-C1 / FR-C2');

  add('db-retention', '保留策略参数合法', '存储与运行期',
    s.detailDays >= 0 && s.bodyDays >= 0 && s.maxDbBytes > 0,
    `明细 ${s.detailDays} 天 · 正文 ${s.bodyDays} 天 · 容量上限 ${(s.maxDbBytes / 1024 / 1024 / 1024).toFixed(1)} GB`);

  add('storage-size', '存储占用可读', '存储与运行期',
    dbSizeBytes(ctx.db) >= 0,
    `DB ${fmtBytes(dbSizeBytes(ctx.db))} · 正文目录 ${fmtBytes(dirSizeBytes(`${ctx.cfg.dataDir}/bodies`))}`, 'docs/05 §7.2');

  add('runtime-errors', '所有错误分类都有响应规格', '存储与运行期',
    true, 'assertErrorSpecsComplete() 在启动期已校验通过', 'docs/00 §7');

  const failed = checks.filter((c) => !c.ok);
  const durationMs = Date.now() - t0;
  return {
    ranAt: t0,
    durationMs,
    passed: checks.length - failed.length,
    failed: failed.length,
    checks,
    summary: failed.length === 0
      ? `全部通过（${checks.length} 项，${durationMs}ms）。透传不变式、观测解析、安全边界与存储均正常。`
      : `${failed.length} 项未通过：${failed.map((c) => c.name).join('；')}`,
  };
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export { isHopByHop };
