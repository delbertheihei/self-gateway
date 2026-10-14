/**
 * 价格表与成本估算（**纯函数 + 静态数据**，无 I/O，server 与 web 共用）。
 *
 * 设计要点：
 *
 * 1. **成本一律"读时"计算**（按当前价格表），不把金额固化进历史行。
 *    理由：价格表默认值随模型发布更新、也是用户可编辑的；一旦把金额写死，
 *    用户改价后历史数字永远不会变，界面上就会出现"改了价格但成本没动"的错觉。
 *    聚合计表里保留了完整的 token 分项（未缓存 input / 缓存命中 input / output），
 *    因此任意时间范围都能用当前价格**精确**重算，不需要数据迁移。
 *    （写入时的 `cost_usd` 列仍然保留，作为"当时价格下的历史留档"，但不用于展示。）
 *
 * 2. **默认价格表来自官方定价页**。数字与官方逐条核对过（见 `PRICE_TABLE_SOURCE`）。
 *    公司自建中继常常把模型改名（例如 `gpt-5.6-terra`），因此价格表**必须可编辑**，
 *    并且支持前缀通配（`gpt-6-*`）与默认行（`*`）。
 *
 * 3. 单位统一为 **USD / 1M tokens**（与官方定价页口径一致，避免 1K/1M 混用出错）。
 */

export interface ModelPrice {
  /** 模型名，或前缀通配（`gpt-6-*`），或兜底行 `*` */
  model: string;
  inputPerMtok: number;
  outputPerMtok: number;
  /** 缓存命中（cache read）单价；null = 按 input 单价计（不假装有折扣） */
  cachedPerMtok: number | null;
  /** 推理单价；null = 已包含在 output 单价里（Responses API 的 reasoning 是 output 子集） */
  reasoningPerMtok: number | null;
}

/** 计费用到的 token 分项（与 `UsageRecord` / DB 列一一对应） */
export interface CostTokens {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export const PRICE_TABLE_SOURCE = {
  label: 'OpenAI 官方定价页',
  url: 'https://platform.openai.com/docs/pricing',
  /** 逐条核对用的镜像（与官方数字一致，含带日期快照的模型 ID） */
  crossCheckUrl: 'https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json',
  retrievedAt: '2026-10-14',
  currency: 'USD',
  unit: 'per 1M tokens',
} as const;

/**
 * 默认价格表版本。**只在需要往默认表里补新模型时才 +1**：
 * 播种逻辑按版本号只跑一次，因此用户删掉的行不会在重启后"复活"。
 */
export const PRICE_TABLE_VERSION = 1;

/** 造行小工具（让下面的表保持"一行一个模型"，便于和官方页面对照） */
function p(model: string, input: number, output: number, cached: number | null): ModelPrice {
  return Object.freeze({ model, inputPerMtok: input, outputPerMtok: output, cachedPerMtok: cached, reasoningPerMtok: null });
}

/**
 * 官方默认价格（USD / 1M tokens）：输入 / 输出 / 缓存命中。
 *
 * ⚠️ 这些是 **OpenAI 官方直营** 的价格。若你走的是公司中继或云厂商，
 *    单价可能不同（也可能模型名不同）—— 请在设置页按中继账单修正。
 */
export const DEFAULT_MODEL_PRICES: readonly ModelPrice[] = Object.freeze([
  // ── GPT-5.x 世代 ──
  p('gpt-5', 1.25, 10, 0.125),
  p('gpt-5-2025-08-07', 1.25, 10, 0.125),
  p('gpt-5-chat', 1.25, 10, 0.125),
  p('gpt-5-codex', 1.25, 10, 0.125),
  p('gpt-5-mini', 0.25, 2, 0.025),
  p('gpt-5-mini-2025-08-07', 0.25, 2, 0.025),
  p('gpt-5-nano', 0.05, 0.4, 0.005),
  p('gpt-5-nano-2025-08-07', 0.05, 0.4, 0.005),
  p('gpt-5-pro', 15, 120, null),
  p('gpt-5-pro-2025-10-06', 15, 120, null),
  p('gpt-5-search-api', 1.25, 10, 0.125),
  p('gpt-5-search-api-2025-10-14', 1.25, 10, 0.125),
  p('gpt-5.1', 1.25, 10, 0.125),
  p('gpt-5.1-2025-11-13', 1.25, 10, 0.125),
  p('gpt-5.1-codex', 1.25, 10, 0.125),
  p('gpt-5.1-codex-max', 1.25, 10, 0.125),
  p('gpt-5.1-codex-mini', 0.25, 2, 0.025),
  p('gpt-5.2', 1.75, 14, 0.175),
  p('gpt-5.2-2025-12-11', 1.75, 14, 0.175),
  p('gpt-5.2-codex', 1.75, 14, 0.175),
  p('gpt-5.2-pro', 21, 168, null),
  p('gpt-5.2-pro-2025-12-11', 21, 168, null),
  p('gpt-5.3-codex', 1.75, 14, 0.175),
  p('gpt-5.4', 2.5, 15, 0.25),
  p('gpt-5.4-2026-03-05', 2.5, 15, 0.25),
  p('gpt-5.4-mini', 0.75, 4.5, 0.075),
  p('gpt-5.4-mini-2026-03-17', 0.75, 4.5, 0.075),
  p('gpt-5.4-nano', 0.2, 1.25, 0.02),
  p('gpt-5.4-nano-2026-03-17', 0.2, 1.25, 0.02),
  p('gpt-5.4-pro', 30, 180, null),
  p('gpt-5.4-pro-2026-03-05', 30, 180, null),
  p('gpt-5.5', 5, 30, 0.5),
  p('gpt-5.5-2026-04-23', 5, 30, 0.5),
  p('gpt-5.5-cyber', 12.5, 75, 1.25),
  p('gpt-5.5-pro', 30, 180, null),
  p('gpt-5.5-pro-2026-04-23', 30, 180, null),
  p('gpt-5.6', 4, 20, 0.4),
  p('gpt-5.6-cyber', 12.5, 75, 1.25),
  p('gpt-5.6-luna', 0.2, 1.2, 0.02),
  p('gpt-5.6-sol', 4, 20, 0.4),
  p('gpt-5.6-terra', 2, 12, 0.2),

  // ── GPT-6 世代 ──
  p('gpt-6-astra', 10, 50, 1),
  p('gpt-6-luna', 0.1, 0.5, 0.01),
  p('gpt-6-sol', 2, 10, 0.2),
  p('gpt-6.1-sol', 2, 10, 0.1),

  // ── 推理模型（o 系列）──
  p('o1', 15, 60, 7.5),
  p('o1-2024-12-17', 15, 60, 7.5),
  p('o1-pro', 150, 600, null),
  p('o1-pro-2025-03-19', 150, 600, null),
  p('o3', 2, 8, 0.5),
  p('o3-2025-04-16', 2, 8, 0.5),
  p('o3-deep-research', 10, 40, 2.5),
  p('o3-deep-research-2025-06-26', 10, 40, 2.5),
  p('o3-mini', 1.1, 4.4, 0.55),
  p('o3-mini-2025-01-31', 1.1, 4.4, 0.55),
  p('o3-pro', 20, 80, null),
  p('o3-pro-2025-06-10', 20, 80, null),
  p('o4-mini', 1.1, 4.4, 0.275),
  p('o4-mini-2025-04-16', 1.1, 4.4, 0.275),
  p('o4-mini-deep-research', 2, 8, 0.5),
  p('o4-mini-deep-research-2025-06-26', 2, 8, 0.5),

  // ── GPT-4.x / 4o 世代（仍在用）──
  p('gpt-4.1', 2, 8, 0.5),
  p('gpt-4.1-2025-04-14', 2, 8, 0.5),
  p('gpt-4.1-mini', 0.4, 1.6, 0.1),
  p('gpt-4.1-mini-2025-04-14', 0.4, 1.6, 0.1),
  p('gpt-4.1-nano', 0.1, 0.4, 0.025),
  p('gpt-4.1-nano-2025-04-14', 0.1, 0.4, 0.025),
  p('gpt-4o', 2.5, 10, 1.25),
  p('gpt-4o-2024-05-13', 5, 15, null),
  p('gpt-4o-2024-08-06', 2.5, 10, 1.25),
  p('gpt-4o-2024-11-20', 2.5, 10, 1.25),
  p('gpt-4o-mini', 0.15, 0.6, 0.075),
  p('gpt-4o-mini-2024-07-18', 0.15, 0.6, 0.075),
  p('gpt-4o-mini-search-preview', 0.15, 0.6, 0.075),
  p('gpt-4o-search-preview', 2.5, 10, 1.25),
  p('gpt-4', 30, 60, null),
  p('gpt-4-0613', 30, 60, null),
  p('gpt-4-turbo', 10, 30, null),
  p('gpt-4-turbo-2024-04-09', 10, 30, null),
  p('gpt-3.5-turbo', 0.5, 1.5, null),
  p('gpt-3.5-turbo-0125', 0.5, 1.5, null),
  p('gpt-3.5-turbo-1106', 1, 2, null),
  p('gpt-3.5-turbo-16k', 3, 4, null),
]);

/**
 * 价格匹配：**精确 → 最长前缀通配 → 默认行 `*`**。
 *
 * ★ 唯一的匹配实现。recorder（写时留档）与 analytics（读时算账）都必须用它，
 *   否则"界面数字"和"数据库里算出来的数字"会悄悄分叉。
 *
 * 为什么前缀通配要按长度降序：`gpt-6-*` 与 `gpt-6-1-*` 同时存在时，
 * 必须让更具体的那条赢。
 */
export function matchPrice(prices: readonly ModelPrice[], model: string | null | undefined): ModelPrice | null {
  if (!model) return null;
  const exact = prices.find((x) => x.model === model);
  if (exact) return exact;
  const wildcard = prices
    .filter((x) => x.model.endsWith('*') && x.model !== '*' && model.startsWith(x.model.slice(0, -1)))
    .sort((a, b) => b.model.length - a.model.length)[0];
  if (wildcard) return wildcard;
  return prices.find((x) => x.model === '*') ?? null;
}

/**
 * 成本（USD）。未配置价格的模型返回 null —— 调用方必须把它显示成"未知"，
 * **绝不能当成 0**（历史缺陷：概览把"没有价格"渲染成 `$0.0000?`）。
 */
export function computeCostUsd(price: ModelPrice | null, tokens: CostTokens): number | null {
  if (!price) return null;
  const cachedRate = price.cachedPerMtok ?? price.inputPerMtok;
  const cached = Math.max(0, tokens.cachedInputTokens);
  const uncached = Math.max(0, tokens.inputTokens - cached);
  const cost = (uncached / 1e6) * price.inputPerMtok
    + (cached / 1e6) * cachedRate
    + (Math.max(0, tokens.outputTokens) / 1e6) * price.outputPerMtok;
  return Math.round(cost * 1e6) / 1e6;
}
