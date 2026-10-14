/**
 * 维护任务：保留策略清理、日志轮转、SQLite 检查点、上游 usage 契约复检。
 *
 * 调度策略：每小时一次（低优先级），外加启动后延迟 30s 跑一次。
 * 用 `unref()` 让定时器不阻止进程退出。
 *
 * 为什么把"清理"和"usage 契约复检"放一起：
 *   两者都是"低频、非关键路径、失败可忽略"的后台工作，共用一套调度最省心。
 */

import { pruneLogFiles, type Logger } from '../config/logger.ts';
import type { Recorder, CleanupReport } from '../recorder/index.ts';

export interface MaintenanceOptions {
  log: Logger;
  recorder: Recorder;
  logDir: string;
  logKeepDays: number;
  /** 复检上游 usage 契约的回调（可选） */
  recheckUsageContract?: () => Promise<void>;
  intervalMs?: number;
}

export interface Maintenance {
  /** 立即执行一次（设置页"立即清理"按钮用） */
  runNow(reason: string): CleanupReport;
  stop(): void;
  lastReport(): CleanupReport | null;
}

export function createMaintenance(opts: MaintenanceOptions): Maintenance {
  const intervalMs = opts.intervalMs ?? 3_600_000;   // 1h
  let last: CleanupReport | null = null;
  let running = false;

  function run(reason: string): CleanupReport {
    if (running) {
      opts.log.debug({ reason }, '维护任务正在运行，跳过本次');
      return last ?? emptyReport();
    }
    running = true;
    try {
      const report = opts.recorder.cleanup();
      last = report;

      const prunedLogs = pruneLogFiles(opts.logDir, opts.logKeepDays, opts.log);
      if (prunedLogs > 0) opts.log.info({ prunedLogs }, '已清理过期日志文件');

      if (report.deletedDetailRows > 0 || report.deletedBodyDirs.length > 0 || prunedLogs > 0) {
        opts.log.info({
          reason,
          deletedDetailRows: report.deletedDetailRows,
          deletedBodyDirs: report.deletedBodyDirs.length,
          prunedLogs,
          dbBytes: report.dbBytes,
          bodyBytes: report.bodyBytes,
        }, `维护完成：${report.reason}`);
      } else {
        opts.log.debug({ reason }, '维护完成：无需清理');
      }
      return report;
    } catch (e) {
      opts.log.error({ err: (e as Error).message }, '维护任务失败（已忽略）');
      return last ?? emptyReport();
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => { run('scheduled'); }, intervalMs);
  timer.unref?.();

  // 启动后 30s 跑一次（让首次清理的可见性尽早出现）
  const kickoff = setTimeout(() => {
    run('startup');
    void opts.recheckUsageContract?.().catch(() => { /* 忽略 */ });
  }, 30_000);
  kickoff.unref?.();

  return {
    runNow(reason: string): CleanupReport { return run(reason); },
    stop(): void { clearInterval(timer); clearTimeout(kickoff); },
    lastReport(): CleanupReport | null { return last; },
  };
}

function emptyReport(): CleanupReport {
  return {
    ranAt: Date.now(), deletedDetailRows: 0, deletedBodyDirs: [],
    deletedSessions: 0, reason: '尚未执行', dbBytes: 0, bodyBytes: 0,
  };
}
