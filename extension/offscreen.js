/**
 * 离屏文档（Offscreen Document）。
 *
 * MV3 的 Service Worker 运行在 Worker 全局作用域里，没有 window，也不能 new Worker()，
 * 而 bergamot 的 WASM 运行时必须有 DOM 侧的 Worker 能力。所以把引擎放在这里，
 * Service Worker 通过长连接端口转发请求。
 *
 * 关键前提：离屏文档比 Service Worker 长寿。SW 空闲约 30s 就会被 Chrome 回收，
 * 端口随之断开，但本文档内存里已经解压好的模型（几十 MB）还活着。
 * 所以断开之后必须由这里主动重连回去（重连这个动作本身就会把 SW 唤醒），
 * 否则 background 只能关掉重建，下一次翻译要重新从 Cache Storage 读包、解压、
 * 做 SHA-256 校验、重启 worker、重编译 WASM —— 对「隔一会儿再翻一次」这种最常见的
 * 间歇使用场景，每次都要白付一遍这个代价。
 */

import { createEngine } from './lib/engine.js';
import { HOST } from './lib/protocol.js';

/** 重连退避：从 150ms 起指数增长，封顶 3s。
 *  正常情况下第一次就能连上（顺带唤醒 SW），退避只是为了异常时不要打爆 SW。 */
const RECONNECT_BASE_DELAY = 150;
const RECONNECT_MAX_DELAY = 3000;
/** 连接存活超过这个时长才算「健康」，断开后退避从零重新计。
 *  否则「连上就断、断了就连」的死循环会一直停在最小间隔上，形成风暴。 */
const HEALTHY_CONNECTION_MS = 2000;
/** 连续失败这么多次就彻底放弃：此时本文档已经是僵尸，
 *  background 等不到重连会主动 close 掉重建，比无限重试更干净。 */
const RECONNECT_MAX_ATTEMPTS = 20;

const engine = createEngine();

/** 当前端口。重连后会被整体替换，所以任何地方都不要缓存它的引用，统一走 send()。 */
let port = null;
let portConnectedAt = 0;
let reconnectTimer = null;
let reconnectAttempts = 0;

/** 进度要回传给发起翻译的那个标签页；没有 tabId（如语言包管理页）时也必须广播，
 * 否则下载进度会全部丢失，界面看起来像卡死。 */
let progressTabId = null;

/**
 * 往指定端口发消息，端口已断开时静默丢弃。
 *
 * SW 被回收的瞬间很可能正好有进度或结果要发，此时 postMessage 会抛
 * 「Attempting to use a disconnected port object」。不吞掉的话，异常会顺着
 * 引擎的进度回调打断整个下载循环，把一个「稍后重试就好」的时序问题放大成下载失败。
 */
function send(target, message) {
  try {
    target?.postMessage(message);
  } catch {
    /* 对端（Service Worker）已经不存在了，这条消息本来也无处可去 */
  }
}

const report = progress => {
  send(port, { type: 'progress', tabId: progressTabId, progress });
};

engine.setProgressHandler(report);

async function handle(op, payload) {
  switch (op) {
    case HOST.OPS.TRANSLATE: {
      const { text, source, target, tabId } = payload ?? {};
      progressTabId = tabId ?? null;
      try {
        const translated = await engine.translate({ text, source, target });
        // 顺带回报本次会话加载过的语言包，落盘由 Service Worker 完成
        return { text: translated, installed: engine.installed() };
      } finally {
        progressTabId = null;
      }
    }
    case HOST.OPS.PRELOAD:
      return engine.preload(payload.direction);
    case HOST.OPS.DELETE:
      return engine.remove(payload.direction);
    case HOST.OPS.CATALOG:
      return { catalog: await engine.catalog() };
    case HOST.OPS.STATUS:
      // 离屏文档拿不到 chrome.storage，这里只回报内存里的状态
      return { installed: engine.installed() };
    default:
      throw new Error(`未知的引擎操作：${op}`);
  }
}

function scheduleReconnect() {
  if (reconnectTimer !== null) return;
  if (reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) return;
  const delay = Math.min(RECONNECT_BASE_DELAY * 2 ** reconnectAttempts, RECONNECT_MAX_DELAY);
  reconnectAttempts += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function connect() {
  // 扩展被重新加载/更新之后，旧离屏文档的 runtime 已经失效，重连既无意义也不可能成功
  if (!chrome.runtime?.id) return;

  let next;
  try {
    next = chrome.runtime.connect({ name: HOST.PORT_NAME });
  } catch {
    scheduleReconnect();
    return;
  }

  port = next;
  portConnectedAt = Date.now();
  // 注意：这里不要把 reconnectAttempts 清零。清零的时机在 onDisconnect —— 只有活够了
  // HEALTHY_CONNECTION_MS 的连接才算健康；否则「连上就断」的抖动会永远停在最小间隔上。

  next.onMessage.addListener(async message => {
    const { id, op, payload } = message ?? {};
    try {
      const result = await handle(op, payload);
      // 必须回到「收到这条请求的那个端口」，而不是当前的 port：
      // 请求处理期间 SW 可能已经被杀过一轮，新 SW 的 serial 从 1 重新计数，
      // 把旧结果发到新端口上有可能正好撞上同号的新请求。
      send(next, { id, result });
    } catch (error) {
      send(next, { id, error: { message: error?.message ?? String(error), name: error?.name } });
    }
  });

  next.onDisconnect.addListener(() => {
    if (port === next) port = null;
    // 连接活了足够久说明是一次正常的 SW 回收，退避清零，尽快连回去把 SW 唤醒；
    // 连上就断则让间隔继续翻倍，避免把刚起来的 SW 又打下去。
    if (Date.now() - portConnectedAt >= HEALTHY_CONNECTION_MS) reconnectAttempts = 0;
    scheduleReconnect();
  });

  // 告诉 Service Worker 引擎已就绪。background 的 onConnect 里也会 notifyReady，
  // 这一条是幂等兜底：它保证「端口通了」和「处理器挂好了」这两件事都已完成。
  send(next, { type: 'ready' });
}

connect();
