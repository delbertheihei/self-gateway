/**
 * SGW 进程入口 —— 唯一负责"组装"的地方，不含业务逻辑（docs/00 §4）。
 *
 * 启动顺序：
 *   读配置 → 建 logger → 开 DB → 建 recorder → 建事件总线 → 自环检测
 *   → 建 http server → 挂路由 → 探测上游 → 启动维护任务 → 监听
 *
 * ★ 四处关键设置，缺一个就会出问题：
 *   1. `server.requestTimeout = 0` —— Node 默认 300s，会掐断 LLM 长流（ADR-14）。
 *   2. `server.headersTimeout = 60s`、`keepAliveTimeout = 65s`（65 > 60 避免竞态）。
 *   3. 只监听回环地址，除非显式 allowExternal。
 *   4. `/v1/**` **完全不参与** Host/Origin/Token 校验（ADR-20）。
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PROXY_PREFIX, CONTROL_PREFIX, SGW_VERSION, classifyNodeError } from '@sgw/shared';
import { loadConfig, detectSelfLoop, ConfigError, type SgwConfig } from './config/schema.ts';
import { applyUpstreamOverrides, resolveProbeAuthHeader } from './config/runtime.ts';
import { createLogger, type Logger } from './config/logger.ts';
import { createAgents, probeUpstream, type UpstreamAgents } from './transport/upstream.ts';
import { handleProxyRequest, sendGatewayError, assertErrorSpecsComplete, type ExchangeRecord } from './edge/proxy.ts';
import { handleControlRequest, buildHealthReport, sendJson, type ControlContext } from './control/routes.ts';
import { openDb, type Db } from './db/index.ts';
import { createRecorder, type Recorder } from './recorder/index.ts';
import { createEventBus, type EventBus } from './control/bus.ts';
import { createMaintenance, type Maintenance } from './control/maintenance.ts';
import { createTokenGuard, type TokenGuard } from './control/token.ts';
import { verifyUsageContract } from './observe/contract-probe.ts';
import type { RuntimeState } from './control/state.ts';

// ─────────────────────────────── 启动选项 ───────────────────────────────

export interface StartOptions {
  cwd?: string;
  configFile?: string;
  logger?: Logger;
  /** 测试用：内存数据库 */
  inMemoryDb?: boolean;
  /** 测试用：关闭维护定时器与后台探针 */
  quiet?: boolean;
}

export interface StartedServer {
  server: http.Server;
  config: SgwConfig;
  log: Logger;
  agents: UpstreamAgents;
  db: Db;
  recorder: Recorder;
  bus: EventBus;
  maintenance: Maintenance;
  tokenGuard: TokenGuard;
  state: RuntimeState;
  port: number;
  close: () => Promise<void>;
  /** 供回归脚本注入观察点 */
  onExchange?: (rec: ExchangeRecord) => void;
}

// ─────────────────────────────── 主函数 ───────────────────────────────

export async function start(opts: StartOptions = {}): Promise<StartedServer> {
  const cwd = opts.cwd ?? process.cwd();

  // ── 1. 配置 ──
  let cfg: SgwConfig;
  let configSource: string;
  let configWarnings: string[] = [];
  try {
    const loaded = await loadConfig({ cwd, ...(opts.configFile ? { envFile: opts.configFile } : {}) });
    cfg = loaded.config;
    configSource = loaded.source;
    configWarnings = loaded.warnings;
  } catch (e) {
    if (e instanceof ConfigError) {
      process.stderr.write(`\n\x1b[31m✗ 配置加载失败\x1b[0m\n${e.message}\n\n`);
      process.stderr.write('提示：sgw.config.ts 是可选的 —— 直接启动后，在仪表盘「设置 → 上游」里手动填写上游地址即可。\n\n');
      process.exit(2);
    }
    throw e;
  }

  const log = opts.logger ?? createLogger({
    level: cfg.logging.level,
    dir: path.join(cfg.dataDir, 'logs'),
    bindings: { app: 'sgw' },
  });

  // ── 2. 数据目录 ──
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const logDir = path.join(cfg.dataDir, 'logs');
  fs.mkdirSync(logDir, { recursive: true });

  // ── 3. 自检 ──
  const missingSpecs = assertErrorSpecsComplete();
  if (missingSpecs.length) log.error({ missingSpecs }, '错误分类缺少响应规格（开发期自检失败）');

  printBanner(cfg, configSource, log);

  // ── 4. 自环检测 ──
  const loops = detectSelfLoop(cfg);
  if (loops.length) {
    for (const l of loops) log.error(l);
    log.error('拒绝启动：上游指向本网关自己会导致请求无限循环。');
    process.exit(2);
  }

  // ── 5. 存储 + 记账 ──
  const db = openDb({ dataDir: cfg.dataDir, log, inMemory: opts.inMemoryDb === true });
  const recorder = createRecorder({
    db, log, dataDir: cfg.dataDir,
    sync: opts.quiet === true,      // 测试模式同步写，避免定时器导致的时序不确定
  });
  // ── 5b. 运行期上游设置（settings 表 > sgw.config.ts）──
  // ★ 顺序很重要：必须在建 state / 探针 / 代理之前应用，否则第一个请求还会用配置里的旧值。
  //   这一层是"上游地址不必写死在仓库里"的落地点：DB 里有值就覆盖配置文件。
  //   applyUpstreamOverrides 是**原地改** cfg.upstream，因此先把配置里的原始值快照下来。
  // 配置文件里的原始值快照（applyUpstreamOverrides 与热改都会**原地改** cfg.upstream，
  // 因此"配置文件里到底写的是什么"必须在覆盖之前留一份）
  const configUpstream = {
    baseUrl: cfg.upstream.baseUrl,
    stripPrefix: cfg.upstream.stripPrefix,
    pathMode: cfg.upstream.pathMode,
    probeModel: cfg.upstream.probeModel,
    probeAuth: cfg.upstream.probeAuth,
    replaceAuthFixed: cfg.upstream.replaceAuth !== false,
  };
  const startupOverrides = applyUpstreamOverrides(cfg, db, log);
  for (const w of configWarnings) {
    // 配置文件里没写地址、但 settings 表提供了 —— 那就不是"未配置"，别误报
    if (cfg.upstream.baseUrl && w.startsWith('未配置上游地址')) continue;
    log.warn(w);
  }
  if (!cfg.upstream.baseUrl) {
    log.warn(`未配置上游地址 —— /v1/** 会返回 502。请打开 http://127.0.0.1:${cfg.listen.port}/#/settings 手动填写（即时生效）。`);
  }

  // ── 6. 上游连接池 ──
  const agents = createAgents(cfg.upstream, log);

  // ── 7. 运行时状态与事件总线 ──
  const state: RuntimeState = {
    startedAt: Date.now(),
    upstreamBaseUrl: cfg.upstream.baseUrl,
    // 配置文件里的值快照（用于设置页提示"配置写的是 X，运行时生效的是 Y"，以及"清除"时回落）
    configUpstream,
    upstreamOverrides: startupOverrides.applied,
    upstreamStatus: { reachable: null, lastProbeAt: null, lastError: null },
    usageContract: { checked: false, complete: null, missingFields: [], checkedAt: null },
    exchangeCount: 0,
    lastExchange: null,
    lastCleanup: null,
    sawWebsocketAttempt: false,
    upstreamProbeStatus: null,
  };
  const bus = createEventBus(log);

  // ── 7b. 本地访问令牌（只作用于 /_sgw/**）──
  const tokenGuard = createTokenGuard({
    db, log,
    requireToken: cfg.security.requireToken,
    dataDir: cfg.dataDir,
  });

  let started: StartedServer;

  // 定期把 stats.tick 推给 SSE 订阅者
  const tickTimer = setInterval(() => {
    if (bus.subscriberCount === 0) return;
    bus.publish({
      type: 'stats.tick',
      data: { at: Date.now(), requestDelta: 0, tokenDelta: 0, errorDelta: 0 },
    });
  }, 1_000);
  tickTimer.unref?.();

  // ── 8. 运行期设置视图（recorder.settings 的窄投影）──
  const settingsView = () => {
    const s = recorder.settings();
    return {
      detailEnabled: s.detailEnabled,
      bodyEnabled: s.bodyEnabled,
      observeMaxBytes: cfg.edge.observeMaxBytes,
      graceDrainMs: cfg.edge.graceDrainMs,
      collectRequestForEstimate: true,
    };
  };

  // ── 9. 控制面上下文 ──
  const controlCtx: ControlContext = {
    cfg,
    log,
    db,
    recorder,
    bus,
    state,
    tokenGuard,
    uptimeSec: () => (Date.now() - state.startedAt) / 1000,
    maintenance: () => started.maintenance,
    restartedNeeded: () => false,
    // ★ 必须接线：/api/upstream/test 用它建连。"测试连通性"曾因漏传这里而挂起
    agents,
  };

  // ── 10. 请求分派（顺序敏感，见 docs/02 §7.1）──
  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';

    // ① 代理面：★ 不做任何 Host/Origin/Token 校验，也不读这些头（ADR-20）
    //    放在最前面还有一个现实理由：Codex 的流量最热，让它在分派链上最短。
    if (url === '/v1' || url.startsWith(PROXY_PREFIX)) {
      handleProxyRequest(req, res, {
        cfg,
        agents,
        log,
        recorder,
        upstreamBaseUrl: () => state.upstreamBaseUrl,
        settings: settingsView,
        onExchange: (rec) => {
          state.exchangeCount++;
          state.lastExchange = rec;
          started.onExchange?.(rec);
          bus.publish({ type: 'request.end', data: toRequestEvent(rec) });
        },
        onUsageIncomplete: (info) => {
          state.usageContract = {
            checked: true,
            complete: false,
            missingFields: info.missing,
            checkedAt: Date.now(),
          };
          bus.publish({
            type: 'alert',
            data: {
              level: 'error',
              code: 'UPSTREAM_USAGE_INCOMPLETE',
              message: `上游 usage 结构不完整（缺 ${info.missing.join(', ')}）—— 这会让 Codex 整轮对话失败。`
                + '这不是网关的问题，也不是你配置的问题，请把该信息反馈给中继管理员。',
            },
          });
        },
      });
      return;
    }

    // ② 控制面：需要 Host/Origin 校验（★ 只在这里校验）
    if (handleControlRequest(req, res, controlCtx)) return;

    // ③ SPA（构建产物存在则托管，否则占位页）
    //    分派口径（重要，避免把 API/代理路径误当页面）：
    //      - 静态资源：/assets/**（扩展名明确）
    //      - 页面导航：任意 GET 且 Accept 含 text/html（浏览器导航一定带它）
    //        → 交给 serveSpa 做"命中文件则返回文件，否则回落 index.html"
    //    这样深层路由（/#/requests 是 hash 路由，但用户也可能直接访问 /requests）
    //    也能拿到 index.html，而不是 404。
    if (req.method === 'GET') {
      const accept = String(req.headers.accept ?? '');
      const wantsHtml = accept.includes('text/html');
      const isAsset = url.startsWith('/assets/');
      const isRoot = url === '/' || url === '/index.html';
      if (isAsset || isRoot || wantsHtml) {
        if (serveSpa(req, res, cfg)) return;
        // 构建产物不存在时，至少给根路径一个可读的占位页
        if (isRoot) { sendPlaceholderPage(res, cfg); return; }
      }
    }

    // ④ 其余一律 404，**不转发到上游**
    sendJson(res, 404, {
      error: {
        code: 'NOT_FOUND',
        message: `${req.method} ${url} 未找到`,
        hint: `网关只代理 ${PROXY_PREFIX}**，管理接口在 ${CONTROL_PREFIX}/api/**。`,
      },
    });
  });

  // ── 11. 关键超时设置 ──
  server.requestTimeout = cfg.edge.requestTimeoutMs;   // 必须为 0（ADR-14）
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 65_000;
  server.maxHeadersCount = 2000;
  server.timeout = 0;

  // ── 12. WebSocket 升级：明确拒绝（ADR-17）──
  server.on('upgrade', (req, socket) => {
    state.sawWebsocketAttempt = true;
    const url = req.url ?? '/';
    log.warn({ url }, '收到 WebSocket 升级请求 —— 本网关只做 HTTP（ADR-17）');
    bus.publish({
      type: 'alert',
      data: {
        level: 'warn',
        code: 'WEBSOCKET_NOT_SUPPORTED',
        message: '检测到 Codex 尝试使用 WebSocket 传输。请从 config.toml 中删除 supports_websockets，或设为 false。',
      },
    });
    const body = JSON.stringify({
      error: {
        code: 'websocket_not_supported',
        message: '本网关不支持 WebSocket 传输',
        hint: '请从 Codex 的 config.toml 中删除 supports_websockets，或设为 false（默认即 false）。',
        source: 'sgw-gateway',
      },
    });
    socket.write(
      'HTTP/1.1 501 Not Implemented\r\n'
      + 'content-type: application/json; charset=utf-8\r\n'
      + `content-length: ${Buffer.byteLength(body)}\r\n`
      + 'x-sgw-error: websocket_not_supported\r\n'
      + 'connection: close\r\n\r\n'
      + body,
    );
    socket.destroy();
  });

  server.on('clientError', (err, socket) => {
    log.warn({ err: (err as Error).message }, '客户端协议错误');
    if ('destroy' in socket) {
      if (!socket.destroyed) {
        socket.end('HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\nconnection: close\r\n\r\n');
      }
      socket.destroy();
    }
  });

  // ── 13. 监听 ──
  const port = await listen(server, cfg.listen.host, cfg.listen.port, log);

  // ── 14. 维护任务 ──
  const maintenance = createMaintenance({
    log,
    recorder,
    logDir,
    logKeepDays: 7,
    ...(opts.quiet ? { intervalMs: 24 * 3_600_000 } : {}),
    recheckUsageContract: async () => {
      // ★ 逐次读取**当前生效**的上游设置（可能刚被设置页热改过），而不是启动时的快照
      const model = cfg.upstream.probeModel;
      if (!state.upstreamBaseUrl || !model) {
        log.debug({ hasBaseUrl: !!state.upstreamBaseUrl, hasModel: !!model },
          '跳过 usage 契约探针（上游地址或探针模型未配置 —— 可在设置页手动填写）');
        return;
      }
      const auth = resolveProbeAuthHeader(cfg, db);
      if (!auth.value) {
        log.debug('没有可用的探针凭据（Codex 尚未发过请求且未配置 probeAuth），跳过 usage 契约探针');
        return;
      }
      const r = await verifyUsageContract({
        baseUrl: state.upstreamBaseUrl,
        model,
        authorizationHeader: auth.value,
        agents,
        log,
        stripPrefix: cfg.upstream.stripPrefix,
        pathMode: cfg.upstream.pathMode,
      });
      state.usageContract = {
        checked: r.checked,
        complete: r.complete,
        missingFields: r.missingFields,
        checkedAt: r.checkedAt,
      };
      if (r.note) log.warn({ note: r.note }, 'usage 契约探针提示');
      else log.info({ complete: r.complete }, 'usage 契约探针：结构完整');
    },
  });

  started = {
    server, config: cfg, log, agents, db, recorder, bus, maintenance, tokenGuard, state, port,
    async close() {
      clearInterval(tickTimer);
      maintenance.stop();
      bus.closeAll('server-closing');
      recorder.close();
      await new Promise<void>((resolve) => {
        server.close(() => { resolve(); });
        server.closeAllConnections?.();
      });
      agents.destroy();
      db.close();
    },
  };

  recorder.cleanup();

  // ── 15. 启动提示 ──
  log.info({ port, host: cfg.listen.host }, `SGW 已启动 —— http://${displayHost(cfg.listen.host)}:${port}`);
  if (cfg.security.requireToken) {
    log.info(`仪表盘：http://${displayHost(cfg.listen.host)}:${port}/?token=${tokenGuard.token()}`);
    log.info('（首次访问会把这个令牌存入浏览器 localStorage；之后不再需要带在链接里）');
  } else {
    log.warn('本地访问令牌未启用 —— 同机任意进程都可读取用量与正文（security.requireToken = false）');
  }
  log.info({
    baseUrl: state.upstreamBaseUrl || '(未配置 —— 可在设置页填写)',
    stripPrefix: cfg.upstream.stripPrefix,
    pathMode: cfg.upstream.pathMode,
    upstreamOverrides: state.upstreamOverrides,
    probeModel: cfg.upstream.probeModel || '(未配置 —— 契约探针跳过)',
    detailEnabled: recorder.settings().detailEnabled,
    bodyEnabled: recorder.settings().bodyEnabled,
  }, '上游与记账已配置');

  // ── 16. 后台探测（不阻塞启动）──
  if (!opts.quiet && state.upstreamBaseUrl) void probeOnce();

  return started;

  async function probeOnce(): Promise<void> {
    if (!state.upstreamBaseUrl) return;
    const r = await probeUpstream(state.upstreamBaseUrl, agents, 5_000);
    state.upstreamStatus = { reachable: r.reachable, lastProbeAt: Date.now(), lastError: r.error };
    state.upstreamProbeStatus = r.status;
    if (r.reachable) {
      log.info({ status: r.status }, `上游连通性 OK（/models 返回 ${r.status}；401/403 也说明端点存在）`);
      if (r.status === 404) {
        log.warn('上游 /models 返回 404 —— 可能路径前缀配置不对。'
          + '试试把 upstream.stripPrefix 设为 "" 或 "/v1"，或把 pathMode 设为 "absolute"。');
      }
    } else {
      log.warn({ error: r.error }, '上游连通性探测失败 —— 请求到达时仍会尝试转发，但请检查配置');
    }
  }
}

// ─────────────────────────────── 辅助 ───────────────────────────────

function toRequestEvent(rec: ExchangeRecord): import('@sgw/shared').RequestEvent {
  return {
    id: rec.id,
    startedAt: rec.startedAt,
    method: rec.method,
    path: rec.path,
    query: null,
    endpoint: rec.endpoint,
    status: rec.status,
    errorClass: rec.errorClass,
    streamed: false,
    upstreamRequestId: rec.upstreamRequestId,
    responseId: rec.responseId,
    model: rec.model,
    codexSessionId: rec.codexSessionId,
    codexThreadId: rec.codexThreadId,
    codexClientRequestId: null,
    codexOriginator: rec.codexOriginator,
    codexSubagent: null,
    timing: {
      enqueuedAt: rec.startedAt,
      completedAt: rec.startedAt + rec.timings.totalMs,
      totalMs: Math.round(rec.timings.totalMs),
      ...(rec.timings.upstreamHeadersMs !== null ? { upstreamHeadersMs: rec.timings.upstreamHeadersMs } : {}),
      ...(rec.timings.firstTokenMs !== null ? { firstTokenMs: rec.timings.firstTokenMs } : {}),
    },
    usage: rec.usage,
    observeShape: rec.observeShape as import('@sgw/shared').ObserveShape,
    observeNote: rec.observeNote,
    bytesIn: rec.bytesIn,
    bytesOut: rec.bytesOut,
    truncated: { request: false, response: rec.observation?.truncated ?? false },
    bodyRef: null,
    keyFingerprint: null,
  };
}

const SPA_DIR_CANDIDATES = [
  'apps/web/dist',
  'apps/web/dist/client',
];

function serveSpa(req: http.IncomingMessage, res: http.ServerResponse, cfg: SgwConfig): boolean {
  const url = (req.url ?? '/').split('?')[0] ?? '/';
  for (const rel of SPA_DIR_CANDIDATES) {
    const dir = path.resolve(process.cwd(), rel);
    if (!fs.existsSync(path.join(dir, 'index.html'))) continue;

    const relPath = url === '/' ? 'index.html' : url.replace(/^\/+/, '');
    const full = path.join(dir, relPath);
    // 防目录穿越
    if (!full.startsWith(dir)) return false;

    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      sendStaticFile(res, full);
      return true;
    }
    if (url === '/' || url === '/index.html' || !path.extname(url)) {
      sendStaticFile(res, path.join(dir, 'index.html'));
      return true;
    }
  }
  void cfg;
  return false;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

function sendStaticFile(res: http.ServerResponse, file: string): void {
  const ext = path.extname(file).toLowerCase();
  const body = fs.readFileSync(file);
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'content-length': String(body.length),
    // index.html 不缓存（否则前端更新后看不到新版），带 hash 的 assets 可长缓存
    'cache-control': ext === '.html' ? 'no-store' : 'public, max-age=31536000, immutable',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

function displayHost(host: string): string {
  if (host === '::1') return '[::1]';
  return host;
}

function listen(server: http.Server, host: string, port: number, log: Logger): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        log.error(`端口 ${port} 已被占用。请关闭占用进程，或改用其他端口（listen.port）。`);
        log.error(`排查：netstat -ano | findstr :${port}`);
      } else if (err.code === 'EACCES') {
        log.error(`没有权限绑定 ${host}:${port}。请改用 1024 以上的端口。`);
      } else {
        log.error({ code: err.code, err: err.message }, '监听失败');
      }
      reject(err);
    });
    server.listen(port, host, () => {
      const addr = server.address();
      const actual = typeof addr === 'object' && addr ? addr.port : port;
      resolve(actual);
    });
  });
}

function printBanner(cfg: SgwConfig, configSource: string, log: Logger): void {
  const lines = [
    '',
    `  SGW · Self Gateway  v${SGW_VERSION}`,
    '  本地 AI 用量观测网关 —— 请求原样穿透，旁路记账',
    '',
    `  配置文件      ${configSource}`,
    `  监听          http://${displayHost(cfg.listen.host)}:${cfg.listen.port}`,
    `  上游          ${cfg.upstream.baseUrl || '(未配置 —— 请在仪表盘「设置 → 上游」手动填写，改完即时生效)'}`,
    `  数据目录      ${cfg.dataDir}`,
    '',
    '  铁律：不改请求/响应字节 · 不引入延迟 · 数据不出本机',
    '',
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
  void log;
}

function sendPlaceholderPage(res: http.ServerResponse, cfg: SgwConfig): void {
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="color-scheme" content="dark light">
<title>SGW · Self Gateway</title>
<style>
  :root{--bg:#0A0A0C;--fg:#E6E6EC;--dim:#77778A;--accent:#22D3EE;--surface:#121216;--border:#2E2E36}
  @media (prefers-color-scheme: light){:root{--bg:#FAFAFB;--fg:#1F1F26;--dim:#96969F;--surface:#fff;--border:#E1E1E6}}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);
       font:14px/1.6 ui-sans-serif,system-ui,"Segoe UI","Microsoft YaHei UI",sans-serif}
  main{max-width:680px;padding:40px}
  h1{font-size:20px;margin:0 0 4px;letter-spacing:-.02em}
  h1 span{color:var(--accent)}
  p{color:var(--dim);margin:14px 0}
  .card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:16px 20px;margin:18px 0}
  code{font-family:ui-monospace,Consolas,monospace;background:color-mix(in oklab,var(--accent) 12%,transparent);
       padding:2px 6px;border-radius:4px;font-size:12px}
  table{border-collapse:collapse;width:100%;font-size:13px}
  td{padding:5px 0;vertical-align:top}
  td:first-child{color:var(--dim);width:130px}
  .badge{display:inline-block;font-size:11px;padding:2px 8px;border-radius:999px;
         border:1px dashed var(--accent);color:var(--accent)}
</style></head>
<body><main>
  <h1>SGW · <span>Self Gateway</span></h1>
  <p>网关正在运行。前端仪表盘尚未构建。</p>
  <div class="card">
    <table>
      <tr><td>上游</td><td><code>${escapeHtml(cfg.upstream.baseUrl || '(未配置 —— 请打开仪表盘设置页填写)')}</code></td></tr>
      <tr><td>监听</td><td><code>${escapeHtml(cfg.listen.host)}:${cfg.listen.port}</code></td></tr>
      <tr><td>健康检查</td><td><a href="${CONTROL_PREFIX}/api/health"><code>${CONTROL_PREFIX}/api/health</code></a></td></tr>
      <tr><td>统计摘要</td><td><a href="${CONTROL_PREFIX}/api/stats/summary"><code>${CONTROL_PREFIX}/api/stats/summary</code></a></td></tr>
    </table>
  </div>
  <p>把 Codex 的 <code>base_url</code> 指向 <code>http://127.0.0.1:${cfg.listen.port}/v1</code> 即可开始观测。
     注意使用 <code>127.0.0.1</code> 而非 <code>localhost</code>。</p>
  <p>构建仪表盘：<code>pnpm --filter @sgw/web build</code></p>
</main></body></html>`;
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': String(Buffer.byteLength(html)),
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'self'; connect-src 'self'",
    'x-content-type-options': 'nosniff',
  });
  res.end(html);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c
  ));
}

export { buildHealthReport, classifyNodeError, sendGatewayError };

// ─────────────────────────────── 直接运行 ───────────────────────────────

const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try { return import.meta.url === pathToFileURL(entry).href; } catch { return false; }
})();

if (invokedDirectly) {
  const started = await start();
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    started.log.info({ signal }, '收到退出信号，正在关闭…');
    const t = setTimeout(() => {
      started.log.warn('优雅关闭超时，强制退出');
      process.exit(1);
    }, 5_000);
    t.unref();
    try {
      await started.close();
      started.log.info('已关闭');
      process.exit(0);
    } catch (e) {
      started.log.error({ err: (e as Error).message }, '关闭时出错');
      process.exit(1);
    }
  };
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('uncaughtException', (err) => {
    started.log.error({ code: (err as NodeJS.ErrnoException).code, err: err.message }, '未捕获异常');
  });
  process.on('unhandledRejection', (reason) => {
    started.log.error({ err: String(reason) }, '未处理的 Promise 拒绝');
  });
}
