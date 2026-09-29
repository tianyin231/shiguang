import type express from "express";
import { z } from "zod";
import type { Provider } from "../shared/types";
import { all, db, event, get, put, transaction } from "./db";
import { ApiError } from "./providers";

export const PROVIDER_KEY_TTL_MS = 60 * 60 * 1000;
type Endpoint = Pick<Provider, "baseUrl" | "adapter">;
type CachedKey = Endpoint & { apiKey: string; expiresAt: number };
const keys = new Map<string, Map<string, CachedKey>>();

export function sameProviderEndpoint(a: Endpoint, b: Endpoint) {
  const normalize = (url: string) =>
    new URL(url).toString().replace(/\/+$/, "");
  return (
    a.adapter === b.adapter && normalize(a.baseUrl) === normalize(b.baseUrl)
  );
}

export function requiresProviderKey(provider: Provider) {
  // 旧明文只用于判断是否需要鉴权，不得作为调用凭证。
  return (
    provider.adapter !== "demo" &&
    (provider.requiresKey === true || Boolean(provider.apiKey))
  );
}

export function clearProviderKeys(deviceId?: string, providerId?: string) {
  if (!deviceId) keys.clear();
  else if (!providerId) keys.delete(deviceId);
  else {
    const entries = keys.get(deviceId);
    entries?.delete(providerId);
    if (!entries?.size) keys.delete(deviceId);
  }
}

export function cacheProviderKey(
  deviceId: string,
  provider: Provider,
  apiKey: string,
) {
  const entries = keys.get(deviceId) ?? new Map<string, CachedKey>();
  entries.set(provider.id, {
    baseUrl: provider.baseUrl,
    adapter: provider.adapter,
    apiKey,
    expiresAt: Date.now() + PROVIDER_KEY_TTL_MS,
  });
  keys.set(deviceId, entries);
}

export function getProviderKey(
  deviceId: string,
  provider: Provider,
  touch = false,
) {
  const entry = keys.get(deviceId)?.get(provider.id);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    clearProviderKeys(deviceId, provider.id);
    return undefined;
  }
  // 运行中任务可能仍持有旧端点副本，不能让它清掉用户刚保存的新端点凭证。
  if (!sameProviderEndpoint(entry, provider)) return undefined;
  if (touch) entry.expiresAt = Date.now() + PROVIDER_KEY_TTL_MS;
  return entry.apiKey;
}

export function providerWithKey(
  deviceId: string,
  provider: Provider,
  required = true,
): Provider {
  const { apiKey: _legacyKey, ...metadata } = provider;
  const apiKey = getProviderKey(deviceId, provider, true);
  const requiresKey = requiresProviderKey(provider);
  if (required && requiresKey && !apiKey)
    throw new ApiError(
      409,
      "此连接需要 API Key，请从当前浏览器重新提供后再试；服务器不会永久保存个人 Key",
    );
  return { ...metadata, requiresKey, apiKey: apiKey || "" };
}

export function waitingForProviderKey(deviceId: string, provider: Provider) {
  return requiresProviderKey(provider) && !getProviderKey(deviceId, provider);
}

export function redactProviderKeys(deviceId: string, message: string) {
  for (const entry of keys.get(deviceId)?.values() ?? [])
    message = message.split(entry.apiKey).join("[redacted]");
  return message;
}

const sweeper = setInterval(() => {
  for (const [deviceId, entries] of keys)
    for (const [providerId, entry] of entries)
      if (entry.expiresAt <= Date.now())
        clearProviderKeys(deviceId, providerId);
}, 60_000);
sweeper.unref();

const keySchema = z.object({
  providerId: z.string().min(1),
  apiKey: z.string().min(1).max(10000),
  baseUrl: z.url(),
  adapter: z.enum(["openai", "gemini", "anthropic", "demo"]),
});
const keyBatchSchema = z.object({ keys: z.array(keySchema).max(100) });

function ownedProvider(deviceId: string, id: string) {
  const provider = get<Provider>("providers", id, deviceId);
  if (!provider) throw new ApiError(404, "连接不存在");
  return provider;
}

export function hasPendingLegacyCleanup(deviceId: string) {
  return Boolean(
    db
      .prepare("SELECT 1 FROM provider_key_cleanup WHERE device_id=?")
      .get(deviceId),
  );
}

function cleanLegacyStorage(deviceId: string) {
  try {
    // VACUUM 同时清除历史空闲页中的残留；TRUNCATE 清理旧 WAL 帧。
    db.exec("VACUUM");
    const result = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as {
      busy: number;
    };
    if (result.busy) throw new Error("数据库正被其他进程使用");
    db.prepare("DELETE FROM provider_key_cleanup WHERE device_id=?").run(
      deviceId,
    );
  } catch {
    throw new ApiError(
      503,
      "浏览器已保存 Key，但服务器数据库残留清理尚未完成；请稍后再次确认迁移",
    );
  }
}

export function registerProviderKeyRoutes(app: express.Express) {
  app.use("/api/provider-keys", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  app.post("/api/provider-keys", (req, res) => {
    const input = keyBatchSchema.parse(req.body);
    const providers = input.keys.map((key) => {
      const provider = ownedProvider(req.device.id, key.providerId);
      if (!sameProviderEndpoint(provider, key))
        throw new ApiError(
          409,
          "连接地址或类型已变化，请先保存连接设置再提供 Key",
        );
      return provider;
    });
    transaction(() => {
      for (const provider of providers)
        if (provider.adapter !== "demo" && !provider.requiresKey) {
          const updated: Provider = { ...provider, requiresKey: true };
          put("providers", req.device.id, updated);
        }
    });
    input.keys.forEach((key, index) =>
      cacheProviderKey(req.device.id, providers[index], key.apiKey),
    );
    event(req.device.id, "provider-keys", {});
    res.json({ ok: true });
  });
  app.delete("/api/provider-keys/:id", (req, res) => {
    ownedProvider(req.device.id, req.params.id);
    clearProviderKeys(req.device.id, req.params.id);
    event(req.device.id, "provider-keys", {});
    res.json({ ok: true });
  });
  app.get("/api/provider-keys/legacy", (req, res) => {
    // 浏览器持久保存已经成功，但上次数据库正被占用时，重试不再需要旧明文。
    if (hasPendingLegacyCleanup(req.device.id))
      cleanLegacyStorage(req.device.id);
    res.json({
      keys: all<Provider>("providers", req.device.id)
        .filter((provider) => provider.apiKey)
        .map((provider) => ({
          providerId: provider.id,
          apiKey: provider.apiKey,
          baseUrl: provider.baseUrl,
          adapter: provider.adapter,
        })),
    });
  });
  app.post("/api/provider-keys/legacy/ack", (req, res) => {
    const input = keyBatchSchema.parse(req.body);
    const providers = input.keys.map((key) => {
      const provider = ownedProvider(req.device.id, key.providerId);
      if (
        !sameProviderEndpoint(provider, key) ||
        (provider.apiKey && provider.apiKey !== key.apiKey)
      )
        throw new ApiError(
          409,
          "旧 Key 或连接已发生变化，请重新读取并保存到浏览器后确认",
        );
      return provider;
    });
    transaction(() => {
      for (const provider of providers) {
        if (!provider.apiKey) continue;
        db.prepare(
          "INSERT OR IGNORE INTO provider_key_cleanup(device_id) VALUES(?)",
        ).run(req.device.id);
        const { apiKey: _legacyKey, ...metadata } = provider;
        // 唯一允许删除旧凭证的写入入口；普通 put 会保留尚未迁移的旧值。
        db.prepare(
          "UPDATE providers SET data=? WHERE id=? AND device_id=?",
        ).run(
          JSON.stringify({
            ...metadata,
            requiresKey: provider.adapter !== "demo",
          }),
          provider.id,
          req.device.id,
        );
      }
    });
    if (hasPendingLegacyCleanup(req.device.id))
      cleanLegacyStorage(req.device.id);
    event(req.device.id, "provider-keys", {});
    res.json({ ok: true });
  });
}
