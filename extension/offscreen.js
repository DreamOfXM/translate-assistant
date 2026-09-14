/**
 * 离屏文档（Offscreen Document）。
 *
 * MV3 的 Service Worker 运行在 Worker 全局作用域里，没有 window，也不能 new Worker()，
 * 而 bergamot 的 WASM 运行时必须有 DOM 侧的 Worker 能力。所以把引擎放在这里，
 * Service Worker 通过长连接端口转发请求。
 */

import { createEngine } from './lib/engine.js';
import { HOST } from './lib/protocol.js';

const engine = createEngine();
const port = chrome.runtime.connect({ name: HOST.PORT_NAME });

/** 进度要回传给发起翻译的那个标签页；没有 tabId（如语言包管理页）时也必须广播，
 * 否则下载进度会全部丢失，界面看起来像卡死。 */
let progressTabId = null;

const report = progress => {
  port.postMessage({ type: 'progress', tabId: progressTabId, progress });
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

port.onMessage.addListener(async ({ id, op, payload }) => {
  try {
    const result = await handle(op, payload);
    port.postMessage({ id, result });
  } catch (error) {
    port.postMessage({ id, error: { message: error?.message ?? String(error), name: error?.name } });
  }
});

// 告诉 Service Worker 引擎已就绪
port.postMessage({ type: 'ready' });
