import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { Config, Provider } from "../shared/types";
import {
  assertBrowserKeyStorage,
  browserProviderKeyStatus,
  clearBrowserProviderKey,
  configureProviderKeys,
  getBrowserProviderKey,
  migrateLegacyProviderKeys,
  saveBrowserProviderKey,
  syncBrowserProviderKeys,
  type BrowserProviderKey,
} from "../src/provider-keys";

class TestStorage implements Storage {
  readonly data = new Map<string, string>();
  writeMode: "normal" | "throw" | "discard" = "normal";
  get length() {
    return this.data.size;
  }
  clear() {
    this.data.clear();
  }
  key(index: number) {
    return [...this.data.keys()][index] ?? null;
  }
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
  setItem(key: string, value: string) {
    if (this.writeMode === "throw") throw new Error("测试：存储额度已满");
    if (this.writeMode !== "discard") this.data.set(key, value);
  }
}

const originalStorage = Object.getOwnPropertyDescriptor(
  globalThis,
  "localStorage",
);
const originalFetch = globalThis.fetch;
let storage: TestStorage;
const provider: Provider = {
  id: "provider-one",
  name: "测试连接",
  baseUrl: "https://example.test/v1",
  adapter: "openai",
  proxyUrl: "",
  concurrency: 1,
  adaptiveLimit: 1,
  cooldownUntil: 0,
  createdAt: 0,
  legacyKeyAvailable: true,
};
const key: BrowserProviderKey = {
  providerId: provider.id,
  apiKey: "sk-browser-test-secret",
  baseUrl: provider.baseUrl,
  adapter: provider.adapter,
};
function config(deviceId = "device-one"): Config {
  return {
    deviceId,
    providers: [provider],
    activeProviderId: provider.id,
    settings: {
      outputDir: "",
      filenameTemplate: "",
      quotaMB: 1,
      totalBudgets: {},
      concurrency: 1,
      retries: 0,
      timeout: 5,
    },
  };
}

beforeEach(() => {
  storage = new TestStorage();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
  });
  globalThis.fetch = async () => {
    throw new Error("意外网络请求：测试只能使用模拟 fetch");
  };
  configureProviderKeys(config());
});

after(() => {
  globalThis.fetch = originalFetch;
  if (originalStorage)
    Object.defineProperty(globalThis, "localStorage", originalStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

test("浏览器 Key 按设备、地址和适配器绑定，只同步匹配的凭证", async () => {
  saveBrowserProviderKey("device-one", provider, key.apiKey);
  assert.equal(getBrowserProviderKey("device-one", provider), key.apiKey);
  assert.equal(
    getBrowserProviderKey("device-one", {
      ...provider,
      baseUrl: provider.baseUrl + "/",
    }),
    key.apiKey,
  );
  assert.equal(getBrowserProviderKey("device-two", provider), "");
  assert.equal(
    getBrowserProviderKey("device-one", { ...provider, adapter: "gemini" }),
    "",
  );
  const changed = { ...provider, baseUrl: "https://other.test/v1" };
  assert.equal(getBrowserProviderKey("device-one", changed), "");
  assert.equal(
    browserProviderKeyStatus("device-one", changed).status,
    "different-endpoint",
  );
  const requests: BrowserProviderKey[][] = [];
  globalThis.fetch = async (_input, options) => {
    requests.push(JSON.parse(String(options?.body)).keys);
    return Response.json({ ok: true });
  };
  configureProviderKeys({ ...config(), providers: [changed] });
  await syncBrowserProviderKeys();
  assert.equal(requests.length, 0);
  configureProviderKeys(config());
  await syncBrowserProviderKeys();
  assert.deepEqual(requests, [[key]]);
});

test("存储抛错或静默丢弃写入时，提示保存失败且不确认删除旧 Key", async () => {
  for (const mode of ["throw", "discard"] as const) {
    storage.writeMode = mode;
    assert.throws(() => assertBrowserKeyStorage(), /无法保存/);
    const paths: string[] = [];
    globalThis.fetch = async (input) => {
      paths.push(String(input));
      return Response.json({ keys: [key] });
    };
    await assert.rejects(migrateLegacyProviderKeys(), /未能保存/);
    assert.deepEqual(paths, ["/api/provider-keys/legacy"]);
    assert.equal(getBrowserProviderKey("device-one", provider), "");
  }
});

test("旧 Key 迁移先写入并读回浏览器，再确认；已有不同 Key 时不覆盖也不确认", async () => {
  const paths: string[] = [];
  globalThis.fetch = async (input, options) => {
    paths.push(String(input));
    if (String(input).endsWith("/ack")) {
      assert.equal(getBrowserProviderKey("device-one", provider), key.apiKey);
      assert.deepEqual(JSON.parse(String(options?.body)), { keys: [key] });
      return Response.json({ ok: true });
    }
    return Response.json({ keys: [key] });
  };
  assert.equal(await migrateLegacyProviderKeys(), 1);
  assert.deepEqual(paths, [
    "/api/provider-keys/legacy",
    "/api/provider-keys/legacy/ack",
  ]);
  saveBrowserProviderKey("device-one", provider, "different-browser-key");
  paths.length = 0;
  await assert.rejects(migrateLegacyProviderKeys(), /不同的 Key/);
  assert.equal(
    getBrowserProviderKey("device-one", provider),
    "different-browser-key",
  );
  assert.deepEqual(paths, ["/api/provider-keys/legacy"]);
});

test(
  "清除 Key 等待已发出的同步结束，防止旧同步请求重新填充服务器缓存",
  { timeout: 3000 },
  async () => {
    saveBrowserProviderKey("device-one", provider, key.apiKey);
    let started!: () => void;
    let release!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const releasedPromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const methods: string[] = [];
    globalThis.fetch = async (_input, options) => {
      methods.push(options?.method || "GET");
      if (options?.method === "POST") {
        started();
        await releasedPromise;
      }
      return Response.json({ ok: true });
    };
    const syncing = syncBrowserProviderKeys();
    await startedPromise;
    const clearing = clearBrowserProviderKey("device-one", provider.id);
    assert.equal(getBrowserProviderKey("device-one", provider), "");
    await Promise.resolve();
    assert.deepEqual(methods, ["POST"]);
    release();
    await Promise.all([syncing, clearing]);
    assert.deepEqual(methods, ["POST", "DELETE"]);
    await syncBrowserProviderKeys();
    assert.deepEqual(methods, ["POST", "DELETE"]);
  },
);
