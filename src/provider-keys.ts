import type { Adapter, Config, Provider } from "../shared/types";

export interface BrowserProviderKey {
  providerId: string;
  apiKey: string;
  baseUrl: string;
  adapter: Adapter;
}

type KeyTarget = Pick<Provider, "id" | "baseUrl" | "adapter">;
type KeyContext = Pick<Config, "deviceId" | "providers">;
export type BrowserKeyStatus =
  "saved" | "missing" | "different-endpoint" | "unavailable";
export const PROVIDER_KEY_PREFIX = "workbench-provider-key:v1:";
let context: KeyContext | null = null;
let syncQueue: Promise<void> = Promise.resolve();

export function configureProviderKeys(config: Config) {
  context = { deviceId: config.deviceId, providers: config.providers };
}

function endpoint(baseUrl: string) {
  try {
    return new URL(baseUrl.trim()).href.replace(/\/+$/, "");
  } catch {
    return baseUrl.trim().replace(/\/+$/, "");
  }
}

function storageKey(deviceId: string, providerId: string) {
  return `${PROVIDER_KEY_PREFIX}${encodeURIComponent(deviceId)}:${encodeURIComponent(providerId)}`;
}

function readKey(
  deviceId: string,
  providerId: string,
): BrowserProviderKey | null {
  const raw = localStorage.getItem(storageKey(deviceId, providerId));
  if (!raw) return null;
  const value = JSON.parse(raw) as BrowserProviderKey;
  if (
    value.providerId !== providerId ||
    typeof value.apiKey !== "string" ||
    typeof value.baseUrl !== "string" ||
    !value.apiKey.trim()
  )
    return null;
  return value;
}

function matches(key: BrowserProviderKey, target: KeyTarget) {
  return (
    key.providerId === target.id &&
    key.adapter === target.adapter &&
    endpoint(key.baseUrl) === endpoint(target.baseUrl)
  );
}

export function getBrowserProviderKey(
  deviceId: string | undefined,
  target: KeyTarget,
): string {
  if (!deviceId) return "";
  try {
    const key = readKey(deviceId, target.id);
    return key && matches(key, target) ? key.apiKey : "";
  } catch {
    throw new Error(
      "无法读取此浏览器保存的 Key，请检查网站存储权限或重新填写。",
    );
  }
}

export function browserProviderKeyStatus(
  deviceId: string | undefined,
  target: KeyTarget,
): { status: BrowserKeyStatus; hint: string } {
  if (!deviceId) return { status: "missing", hint: "此浏览器尚未保存 Key" };
  try {
    const key = readKey(deviceId, target.id);
    if (!key) return { status: "missing", hint: "此浏览器尚未保存 Key" };
    if (!matches(key, target))
      return {
        status: "different-endpoint",
        hint: "接口已变更，请重新填写 Key",
      };
    return {
      status: "saved",
      hint: `已存于此浏览器 · ••••${key.apiKey.slice(-4)}`,
    };
  } catch {
    return { status: "unavailable", hint: "此浏览器的 Key 存储不可用" };
  }
}

export function assertBrowserKeyStorage() {
  const probe = `${PROVIDER_KEY_PREFIX}probe:${crypto.randomUUID()}`;
  try {
    localStorage.setItem(probe, "1");
    if (localStorage.getItem(probe) !== "1") throw new Error();
    localStorage.removeItem(probe);
  } catch {
    throw new Error(
      "浏览器无法保存 Key，请允许网站存储并检查剩余空间。当前输入仍保留，连接尚未保存。",
    );
  }
}

export function saveBrowserProviderKey(
  deviceId: string,
  target: KeyTarget,
  apiKey: string,
) {
  if (!deviceId) throw new Error("设备信息尚未就绪，请刷新后重试。");
  const value: BrowserProviderKey = {
    providerId: target.id,
    apiKey: apiKey.trim(),
    baseUrl: target.baseUrl,
    adapter: target.adapter,
  };
  if (!value.apiKey) return;
  const serialized = JSON.stringify(value);
  try {
    const name = storageKey(deviceId, target.id);
    localStorage.setItem(name, serialized);
    if (localStorage.getItem(name) !== serialized) throw new Error();
  } catch {
    throw new Error(
      "Key 未能保存到此浏览器。请允许网站存储并检查剩余空间；当前输入仍保留，请重试保存。",
    );
  }
}

async function keyRequest<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const token = localStorage.getItem("workbench-token");
  const response = await fetch(`/api/provider-keys${path}`, {
    ...options,
    credentials: "include",
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!response.ok) {
    const failure = await response.json().catch(() => null);
    throw new Error(
      failure?.error || "同步浏览器 Key 失败，请检查服务器连接。",
    );
  }
  return response.status === 204 ? (undefined as T) : response.json();
}

export function syncBrowserProviderKeys(): Promise<void> {
  // 串行补充临时 Key，清除操作可以等待旧请求完成，避免旧 Key 被再次写回缓存。
  const pending = syncQueue
    .catch(() => {})
    .then(async () => {
      if (!context?.deviceId) return;
      const keys: BrowserProviderKey[] = [];
      for (const provider of context.providers) {
        if (provider.adapter === "demo") continue;
        const apiKey = getBrowserProviderKey(context.deviceId, provider);
        if (apiKey)
          keys.push({
            providerId: provider.id,
            apiKey,
            baseUrl: provider.baseUrl,
            adapter: provider.adapter,
          });
      }
      if (keys.length)
        await keyRequest("", {
          method: "POST",
          body: JSON.stringify({ keys }),
        });
    });
  syncQueue = pending;
  return pending;
}

export async function clearBrowserProviderKey(
  deviceId: string,
  providerId: string,
) {
  try {
    const name = storageKey(deviceId, providerId);
    localStorage.removeItem(name);
    if (localStorage.getItem(name) !== null) throw new Error();
  } catch {
    throw new Error("无法清除此浏览器的 Key，请检查网站存储权限后重试。");
  }
  await syncQueue.catch(() => {});
  try {
    await keyRequest(`/${encodeURIComponent(providerId)}`, {
      method: "DELETE",
    });
  } catch {
    throw new Error(
      "浏览器中的 Key 已清除，但服务器临时缓存清理失败，请再次点击清除 Key。",
    );
  }
}

export async function clearDeviceBrowserProviderKeys(deviceId: string) {
  const prefix = `${PROVIDER_KEY_PREFIX}${encodeURIComponent(deviceId)}:`;
  try {
    const names: string[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const name = localStorage.key(index);
      if (name?.startsWith(prefix)) names.push(name);
    }
    for (const name of names) {
      localStorage.removeItem(name);
      if (localStorage.getItem(name) !== null) throw new Error();
    }
  } catch {
    throw new Error(
      "无法清除此浏览器保存的 Key，退出尚未完成，请检查网站存储权限后重试。",
    );
  }
  await syncQueue.catch(() => {});
  if (context?.deviceId === deviceId) context = null;
}

export async function migrateLegacyProviderKeys(): Promise<number> {
  if (
    !context?.deviceId ||
    !context.providers.some((provider) => provider.legacyKeyAvailable)
  )
    return 0;
  const current = context;
  const { keys } = await keyRequest<{ keys: BrowserProviderKey[] }>("/legacy");
  if (!keys.length) return 0;
  for (const key of keys) {
    const provider = current.providers.find(
      (item) => item.id === key.providerId,
    );
    if (!provider || !matches(key, provider))
      throw new Error("连接信息已发生变化，旧 Key 尚未迁移，请刷新后重试。");
    const existing = getBrowserProviderKey(current.deviceId, provider);
    if (existing && existing !== key.apiKey)
      throw new Error(
        `「${provider.name}」在此浏览器已有不同的 Key，未覆盖本地内容，也未删除服务器旧 Key。请核对后重试迁移。`,
      );
    saveBrowserProviderKey(current.deviceId, provider, key.apiKey);
  }
  // 只有每个 Key 都完成持久写入及读回校验后，才让服务器删除对应的旧存储。
  await keyRequest("/legacy/ack", {
    method: "POST",
    body: JSON.stringify({ keys }),
  });
  return keys.length;
}
