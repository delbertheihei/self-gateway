#!/usr/bin/env node
/**
 * SGW 接入/回滚脚本 —— 把 Codex 指向网关（或回声上游），并保证能一键回滚。
 *
 * 设计要点：
 *   1. **最小改动**：只改 `[model_providers.<id>]` 下的 `base_url` 一行，
 *      其余（wire_api / requires_openai_auth / experimental_bearer_token）原样不动。
 *   2. **先备份再改**：备份文件名带 sgw 标记，不会覆盖其他工具的备份。
 *   3. **拒绝危险的键**：如果发现 `wire_api = "chat"`（Codex ≥ v0.95 已移除，会硬报错）
 *      或 `supports_websockets = true`（网关 v1 不支持 WS），明确报错而不是默默改坏。
 *   4. **硬编码 127.0.0.1**：绝不用 localhost —— Codex 对 localhost 有优先解析 IPv6 的已知缺陷
 *      (openai/codex#21773 / #19525)。
 *   5. **幂等**：重复执行安全；`--restore` 从任意时间点恢复原始配置。
 *
 * 用法：
 *   node scripts/point-codex.mjs                      # 指向网关（默认端口 8787，可用 --port / SGW_PORT 覆盖）
 *   node scripts/point-codex.mjs --port 8899          # 指向回声上游
 *   node scripts/point-codex.mjs --base-url https://<你的上游>/v1   # 恢复上游直连
 *   node scripts/point-codex.mjs --restore            # 用备份整体还原
 *   node scripts/point-codex.mjs --status             # 只看当前指向，不改任何东西
 *   node scripts/point-codex.mjs --dry-run            # 打印将要写出的内容，不落盘
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const CONFIG = path.join(CODEX_HOME, 'config.toml');
const BACKUP = `${CONFIG}.sgw-backup`;
const MARKER = path.join(CODEX_HOME, '.sgw-managed.json');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(`--${f}`);
const val = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const C = process.stdout.isTTY
  ? { r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', b: '\x1b[36m', d: '\x1b[2m', B: '\x1b[1m', x: '\x1b[0m' }
  : { r: '', g: '', y: '', b: '', d: '', B: '', x: '' };
const say = (l = '') => console.log(l);
const ok = (t) => say(`${C.g}✓${C.x} ${t}`);
const bad = (t) => say(`${C.r}✗${C.x} ${t}`);
const warn = (t) => say(`${C.y}!${C.x} ${t}`);
const info = (k, v) => say(`  ${C.d}${String(k).padEnd(16)}${C.x} ${v}`);

// ─────────────────────────── 读写与解析 ───────────────────────────

if (!fs.existsSync(CONFIG)) {
  bad(`找不到 Codex 配置文件：${CONFIG}`);
  say(`  ${C.d}可用 CODEX_HOME 环境变量指定其他位置。${C.x}`);
  process.exit(1);
}
const original = fs.readFileSync(CONFIG, 'utf8');
const eol = original.includes('\r\n') ? '\r\n' : '\n';
const lines = original.split(/\r?\n/);

/** 定位 [model_providers.<id>] 段及其 base_url 行 */
function analyze(srcLines) {
  let section = null;
  let baseUrlLine = -1; let sectionStart = -1; let sectionEnd = srcLines.length;
  let wireApi = null; let supportsWs = null; let providerId = null;
  const baseUrls = [];   // 所有 provider 的 base_url，便于判断"当前指向"

  for (let i = 0; i < srcLines.length; i++) {
    const line = srcLines[i];
    const sec = line.match(/^\s*\[model_providers\.([^\]]+)\]\s*$/);
    if (sec) {
      if (section) sectionEnd = i;
      section = sec[1]; providerId ??= sec[1];
      if (sectionStart === -1) sectionStart = i;
      continue;
    }
    if (/^\s*\[/.test(line)) { if (section) { sectionEnd = i; section = null; } continue; }
    if (!section) continue;
    const kv = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.+?)\s*$/);
    if (!kv) continue;
    if (kv[1] === 'base_url') {
      const m = kv[2].match(/^["'](.*)["']$/);
      baseUrls.push({ provider: section, url: m ? m[1] : kv[2], line: i });
      if (section === providerId && baseUrlLine === -1) baseUrlLine = i;
    }
    if (section === providerId) {
      if (kv[1] === 'wire_api') wireApi = kv[2].replace(/["']/g, '');
      if (kv[1] === 'supports_websockets') supportsWs = kv[2].trim() === 'true';
    }
  }
  return { providerId, baseUrlLine, sectionStart, sectionEnd, wireApi, supportsWs, baseUrls };
}

const a = analyze(lines);
const currentUrl = a.baseUrlLine >= 0
  ? (lines[a.baseUrlLine].match(/=\s*["'](.*)["']/)?.[1] ?? '(解析失败)')
  : '(该 provider 下没有 base_url，将新增)';

// ─────────────────────────── --status ───────────────────────────

if (has('status')) {
  say(`${C.B}SGW 接入状态${C.x}`);
  info('配置文件', CONFIG);
  info('provider', a.providerId ?? '(未找到 model_providers 段)');
  info('base_url', currentUrl);
  info('wire_api', a.wireApi ?? '(未设置)');
  info('supports_websockets', a.supportsWs === null ? '(未设置 → 默认 false ✓)' : String(a.supportsWs));
  info('备份存在', fs.existsSync(BACKUP) ? `${C.g}是${C.x} (${BACKUP})` : '否');
  if (a.baseUrls.length > 1) {
    say('');
    say(`  ${C.d}全部 provider 的 base_url：${C.x}`);
    for (const b of a.baseUrls) say(`    ${C.d}${b.provider} → ${b.url}${C.x}`);
  }
  const isGw = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\/v1\/?$/.test(currentUrl);
  const isLoopback = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i.test(currentUrl);
  say('');
  if (isGw) ok('当前指向：本地网关/回声上游（请求会被观测）');
  // 不做"是不是某家公司域名"的硬编码判断 —— 任何非回环地址都意味着绕过了本地观测
  else if (isLoopback) warn('当前指向：本机其他端口（不是 8787/v1 形态，请确认端口与路径）');
  else warn('当前指向：外部上游直连（无本地观测）');
  process.exit(0);
}

// ─────────────────────────── --restore ───────────────────────────

if (has('restore')) {
  if (!fs.existsSync(BACKUP)) {
    bad(`找不到备份：${BACKUP}`);
    say(`  ${C.d}没有备份可恢复。若当前 base_url 指向本地，可手动改回上游地址：${C.x}`);
    say(`  ${C.d}  node scripts/point-codex.mjs --base-url <上游地址>${C.x}`);
    process.exit(1);
  }
  if (has('dry-run')) { say(`${C.y}[dry-run]${C.x} 将会用备份覆盖 ${CONFIG}`); process.exit(0); }
  fs.copyFileSync(BACKUP, CONFIG);
  ok('已从备份恢复配置');
  info('恢复自', BACKUP);
  const after = analyze(fs.readFileSync(CONFIG, 'utf8').split(/\r?\n/));
  info('当前 base_url', after.baseUrlLine >= 0 ? fs.readFileSync(CONFIG, 'utf8').split(/\r?\n/)[after.baseUrlLine].trim() : '(无)');
  if (fs.existsSync(MARKER)) fs.rmSync(MARKER);
  say(`\n${C.g}Codex 已回到直连状态。重启 Codex 使其生效。${C.x}`);
  process.exit(0);
}

// ─────────────────────────── 计算目标地址 ───────────────────────────

const port = val('port', process.env.SGW_PORT || '8787');
const targetUrl = val('base-url', `http://127.0.0.1:${port}/v1`);

say(`${C.B}SGW —— 把 Codex 指向本地网关${C.x}`);
say('');
info('配置文件', CONFIG);
info('provider', a.providerId ?? '(未找到)');
info('原 base_url', currentUrl);
info('新 base_url', `${C.g}${targetUrl}${C.x}`);

// ── 前置安全检查：拒绝会让 Codex 直接坏掉的配置 ──

let abort = false;
if (a.wireApi && a.wireApi !== 'responses') {
  bad(`wire_api = "${a.wireApi}" —— 必须是 "responses"。`);
  say(`  ${C.d}Codex ≥ rust-v0.95.0 已移除 chat/completions 支持（硬报错），本项目也只按 responses 设计。${C.x}`);
  say(`  ${C.d}请先把 config.toml 里的 wire_api 改为 "responses"，再运行本脚本。${C.x}`);
  abort = true;
}
if (a.supportsWs === true) {
  bad('supports_websockets = true —— 本网关 v1 不支持 WebSocket 代理。');
  say(`  ${C.d}若保持开启，Codex 会改走 ws://…/v1/responses 并失败。${C.x}`);
  say(`  ${C.d}请把该键删除，或改为 false，再运行本脚本。${C.x}`);
  abort = true;
}
if (/^https?:\/\/localhost/i.test(targetUrl)) {
  bad('目标地址不能使用 localhost —— Codex 存在优先解析 IPv6 的已知缺陷（#21773 / #19525）。');
  say(`  ${C.d}请使用 127.0.0.1。${C.x}`);
  abort = true;
}
if (abort) { say(''); bad('已中止，未做任何修改。'); process.exit(2); }

if (a.wireApi === null) warn('provider 下没有 wire_api 键 —— Codex 默认即为 responses，可接受。');
if (a.baseUrlLine === -1) warn('该 provider 下没有 base_url，将在段内新增一行。');

// ── 生成新内容 ──

const next = [...lines];
if (a.baseUrlLine >= 0) {
  next[a.baseUrlLine] = `base_url = "${targetUrl}"`;
} else {
  // 在 provider 段标题之后插入
  next.splice(a.sectionStart + 1, 0, `base_url = "${targetUrl}"`);
}
const nextText = next.join(eol);

if (has('dry-run')) {
  say('');
  say(`${C.y}[dry-run] 以下是将要写入的内容（不做任何改动）：${C.x}`);
  say(`${C.d}${'─'.repeat(70)}${C.x}`);
  if (a.baseUrlLine >= 0) {
    say(`  第 ${a.baseUrlLine + 1} 行：`);
    say(`  ${C.r}- ${lines[a.baseUrlLine]}${C.x}`);
    say(`  ${C.g}+ ${next[a.baseUrlLine]}${C.x}`);
  } else {
    say(`  在 [model_providers.${a.providerId}] 后新增：`);
    say(`  ${C.g}+ base_url = "${targetUrl}"${C.x}`);
  }
  say(`${C.d}${'─'.repeat(70)}${C.x}`);
  process.exit(0);
}

// ── 幂等：若已指向同一地址且无备份，仍创建备份（保留最初的上游地址）──
//    若已指向同一地址且有备份，则不动备份，避免把"网关地址"备份成原始配置。

const alreadyTargeted = currentUrl === targetUrl;
if (!alreadyTargeted && !fs.existsSync(BACKUP)) {
  fs.writeFileSync(BACKUP, original, 'utf8');
  ok(`已备份原始配置 → ${path.basename(BACKUP)}`);
} else if (!fs.existsSync(BACKUP)) {
  fs.writeFileSync(BACKUP, original, 'utf8');
  ok(`已备份当前配置 → ${path.basename(BACKUP)}`);
} else {
  info('备份', `已存在，保持不变（保留最初的上游地址）`);
}

fs.writeFileSync(CONFIG, nextText, 'utf8');
fs.writeFileSync(MARKER, `${JSON.stringify({
  managedAt: new Date().toISOString(),
  provider: a.providerId,
  from: currentUrl,
  to: targetUrl,
  backup: BACKUP,
}, null, 2)}\n`, 'utf8');

ok('配置已更新');
say('');
say(`${C.d}${'─'.repeat(70)}${C.x}`);
say(`${C.g}${C.B}下一步${C.x}`);
say(`  1. 确保网关已在运行：${C.b}pnpm start${C.x}  或回声上游：${C.b}node scripts/echo-upstream.mjs${C.x}`);
say(`  2. ${C.y}重启 Codex${C.x}（或新开一个会话），让配置生效。`);
say(`  3. 检查指向：${C.b}node scripts/point-codex.mjs --status${C.x}`);
say('');
say(`${C.y}${C.B}回滚（一条命令）${C.x}`);
say(`  ${C.b}node scripts/point-codex.mjs --restore${C.x}`);
say(`${C.d}  等价于：Copy-Item "${BACKUP}" "${CONFIG}" -Force${C.x}`);
say(`${C.d}${'─'.repeat(70)}${C.x}`);
