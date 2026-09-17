/**
 * 让扩展里的翻译引擎原样跑在普通网页上的三个垫片。
 *
 * 引擎代码（lib/engine.js、vendor/*）一行都不改，它以为自己还在扩展里：
 * 1. `chrome.runtime.getURL` —— 引擎用它定位 WASM Worker。
 * 2. `fetch` —— 语言包挂在 storage.googleapis.com，网页里直连会被 CORS 挡掉，
 *    改走本机原生侧的 /proxy 代下载（原生 HTTP 客户端不受 CORS 约束）。
 * 3. `caches` —— 扩展用 Cache Storage 缓存语言包，这里换成原生侧落盘，
 *    「缓存 / 校验 / 删除」这套语义保持一致，且用户能直接看到缓存目录。
 */
(function () {
  'use strict';

  const origin = location.origin;
  const nativeFetch = globalThis.fetch.bind(globalThis);

  /**
   * 覆盖面挂垫片。
   *
   * 不能直接赋值：`caches` 在 Window 上是个只有 getter 的访问器属性，
   * 赋值在严格模式下直接抛 TypeError（页面里表现为 pageerror），垫片静默失效，
   * 然后浏览器自带的 Cache Storage 顶上 —— 看着能跑，其实缓存没落到我们的目录。
   * 用 defineProperty 定义同名的自有属性把它盖掉；万一被拦，记下来让宿主能报出来。
   */
  const failures = [];
  function override(name, value) {
    try {
      Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
    } catch (error) {
      failures.push(`${name}：${error.message}`);
    }
  }
  globalThis.__ltShimFailures = failures;

  override('chrome', {
    runtime: {
      getURL(path) {
        return new URL(String(path).replace(/^\/+/, ''), origin + '/').href;
      }
    }
  });

  const PACK_HOST = 'storage.googleapis.com';

  override('fetch', function (input, init) {
    let url = null;
    try {
      url = new URL(typeof input === 'string' ? input : input.url, origin);
    } catch {
      // 交给原生 fetch 去抛它自己的错
    }
    if (url && url.host === PACK_HOST) {
      return nativeFetch('/proxy?u=' + encodeURIComponent(url.href), init ?? {});
    }
    return nativeFetch(input, init);
  });

  function absoluteKey(input) {
    const raw = typeof input === 'string' ? input : input.url;
    return new URL(raw, origin).href;
  }

  function endpoint(name, path) {
    return '/cache/' + path + '?c=' + encodeURIComponent(name);
  }

  class DiskCache {
    constructor(name) {
      this.name = name;
    }

    async match(input) {
      const response = await nativeFetch(endpoint(this.name, 'get') + '&k=' + encodeURIComponent(absoluteKey(input)));
      if (!response.ok) return undefined;
      return new Response(await response.arrayBuffer());
    }

    async put(input, response) {
      const body = await response.arrayBuffer();
      const stored = await nativeFetch(endpoint(this.name, 'put') + '&k=' + encodeURIComponent(absoluteKey(input)), {
        method: 'PUT',
        body
      });
      if (!stored.ok) throw new Error('语言包缓存写入失败');
    }

    async delete(input) {
      await nativeFetch(endpoint(this.name, 'entry') + '&k=' + encodeURIComponent(absoluteKey(input)), { method: 'DELETE' });
      return true;
    }

    async keys() {
      return [];
    }

    async matchAll() {
      return [];
    }
  }

  const stores = new Map();

  override('caches', {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new DiskCache(name));
      return stores.get(name);
    },
    async delete(name) {
      stores.delete(name);
      await nativeFetch(endpoint(name, 'all'), { method: 'DELETE' });
      return true;
    },
    async has() {
      return true;
    },
    async keys() {
      return [];
    },
    async match() {
      return undefined;
    }
  });
})();
