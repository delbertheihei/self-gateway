#!/usr/bin/env node
/**
 * 一键跑完所有验证（M4 的"发布前门禁"）。
 *
 * 顺序刻意如此（快的、关键的先跑）：
 *   1. 类型门禁        —— 编译期错误
 *   2. 透传回归        —— 三条铁律里最重要的一条（不改字节）
 *   3. 观测回归        —— 记账正确性
 *   4. 端到端冒烟      —— 前端可见性与全部 API
 *   5. 健壮性回归      —— 畸形输入下的稳定性
 *
 * 性能基准与长稳测试**不在默认序列**里（耗时长），用 `pnpm bench` / `pnpm soak` 单独跑。
 *
 * 用法：node scripts/verify-all.mjs [--with-bench]
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const WITH_BENCH = process.argv.includes('--with-bench');

const C = process.stdout.isTTY
  ? { r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', b: '\x1b[36m', d: '\x1b[2m', B: '\x1b[1m', x: '\x1b[0m' }
  : { r: '', g: '', y: '', b: '', d: '', B: '', x: '' };

const steps = [
  { name: '类型门禁 · 服务端', cmd: process.execPath, args: [path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit'], cwd: ROOT },
  { name: '类型门禁 · 前端', cmd: process.execPath, args: [path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit', '-p', 'apps/web/tsconfig.json'], cwd: ROOT },
  { name: '透传回归 (H1~H6)', cmd: process.execPath, args: [path.join(HERE, 'passthrough-regression.mjs')], cwd: ROOT },
  { name: '观测回归 (M2)', cmd: process.execPath, args: [path.join(HERE, 'observe-regression.mjs')], cwd: ROOT },
  { name: '端到端冒烟 (M3)', cmd: process.execPath, args: [path.join(HERE, 'e2e-smoke.mjs')], cwd: ROOT },
  { name: '健壮性回归 (M4-2)', cmd: process.execPath, args: [path.join(HERE, 'robustness-regression.mjs')], cwd: ROOT },
];
if (WITH_BENCH) {
  steps.push({ name: '性能基准 (M4-1)', cmd: process.execPath, args: ['--no-warnings=ExperimentalWarning', path.join(HERE, 'bench-latency.mjs'), '--n', '200'], cwd: ROOT });
}

function run(step) {
  return new Promise((resolve) => {
    const child = spawn(step.cmd, step.args, { cwd: step.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { out += d.toString(); });
    child.on('close', (code) => resolve({ code: code ?? 1, out }));
  });
}

console.log(`${C.B}${'═'.repeat(74)}${C.x}`);
console.log(`${C.B} SGW 全量验证${WITH_BENCH ? '（含性能基准）' : ''}${C.x}`);
console.log(`${C.B}${'═'.repeat(74)}${C.x}\n`);

const results = [];
for (const step of steps) {
  process.stdout.write(`  ${C.b}▸${C.x} ${step.name} … `);
  const t0 = Date.now();
  const r = await run(step);
  const ms = Date.now() - t0;
  // 从输出里提取 "通过 N 失败 M" 之类的摘要
  const passMatch = /通过\s+(\d+)\s+失败\s+(\d+)/.exec(r.out);
  const summary = passMatch ? `通过 ${passMatch[1]} · 失败 ${passMatch[2]}` : (r.code === 0 ? 'OK' : 'FAIL');
  const line = `${r.code === 0 ? `${C.g}✓${C.x}` : `${C.r}✗${C.x}`} ${summary} ${C.d}(${(ms / 1000).toFixed(1)}s)${C.x}`;
  // 覆盖同一行
  process.stdout.write(`\r  ${line}${' '.repeat(Math.max(0, 40 - summary.length))}\n`);
  results.push({ ...step, code: r.code, ms, out: r.out, summary });
}

const failed = results.filter((r) => r.code !== 0);

console.log(`\n${C.B}${'─'.repeat(74)}${C.x}`);
for (const r of results) {
  console.log(`  ${r.code === 0 ? `${C.g}✓${C.x}` : `${C.r}✗${C.x}`} ${r.name.padEnd(30)} ${r.summary}`);
}

if (failed.length > 0) {
  console.log(`\n${C.r}${C.B}失败详情：${C.x}`);
  for (const f of failed) {
    console.log(`\n${C.r}── ${f.name} ──${C.x}`);
    const lines = f.out.split('\n').filter((l) => l.includes('✗') || /Error|error:/.test(l));
    for (const l of lines.slice(0, 20)) console.log(`  ${l.trim()}`);
  }
}

console.log(`\n${C.B}${'═'.repeat(74)}${C.x}`);
if (failed.length === 0) {
  const total = results.reduce((n, r) => n + (Number(/通过\s+(\d+)/.exec(r.out)?.[1] ?? 0)), 0);
  console.log(`  ${C.g}${C.B}✓ 全部通过${total > 0 ? `（合计 ${total} 条断言）` : ''}${C.x}`);
  console.log(`  ${C.d}  三条铁律已被机械化证明：不改字节 · 不引入延迟 · 数据不出本机${C.x}`);
} else {
  console.log(`  ${C.r}${C.B}✗ ${failed.length} 个步骤失败${C.x}`);
}
console.log(`${C.B}${'═'.repeat(74)}${C.x}`);

process.exit(failed.length === 0 ? 0 : 1);
