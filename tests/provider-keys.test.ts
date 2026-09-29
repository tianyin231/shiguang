import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import supertest from "supertest";
import type { Model, Provider, Snapshot, Task } from "../shared/types";

const tempPrefix = path.resolve(os.tmpdir(), "provider-keys-test-");
const temp = await mkdtemp(tempPrefix);
process.env.DATA_DIR = path.join(temp, "data");
process.env.OUTPUT_DIR = path.join(temp, "images");
process.env.WORKER_CONCURRENCY = "2";
const { createApp } = await import("../server/app");
const { db } = await import("../server/db");
const { startWorker } = await import("../server/queue");
const { getProviderKey } = await import("../server/provider-keys");
const app = createApp();
const image = await sharp({
  create: { width: 32, height: 24, channels: 3, background: "#ba7145" },
})
  .png()
  .toBuffer();
type Device = {
  client: ReturnType<typeof supertest.agent>;
  token: string;
  id: string;
  projectId: string;
  sessionId: string;
};
type Fixture = { provider: Provider; model: Model };
const received: { key: string; prompt: string; route: string }[] = [];
let mock: Server;
let server: Server;
let worker: ReturnType<typeof startWorker> | undefined;
let mockBase = "";
let base = "";
let owner: Device;
let other: Device;
const secret = () => "sk-test-" + randomUUID();

async function newDevice(): Promise<Device> {
  const client = supertest.agent(app);
  const config = await client.get("/api/config").expect(200);
  const state: Snapshot = (await client.get("/api/state").expect(200)).body;
  assert.equal(typeof config.body.deviceId, "string");
  return {
    client,
    token: config.body.deviceToken,
    id: config.body.deviceId,
    projectId: state.projects[0].id,
    sessionId: state.sessions[0].id,
  };
}

async function createProvider(
  device: Device,
  apiKey: string,
): Promise<Fixture> {
  const response = await device.client
    .post("/api/config")
    .send({
      baseUrl: mockBase,
      adapter: "openai",
      name: "测试供应商",
      apiKey,
      selectedModels: ["gpt-image-test"],
    })
    .expect(200);
  assert.ok(!JSON.stringify(response.body).includes(apiKey));
  const provider = response.body.providers.find(
    (item: Provider) => item.id === response.body.activeProviderId,
  );
  assert.equal(provider.apiKey, undefined);
  const models: Model[] = (
    await device.client
      .get("/api/models")
      .query({ providerId: provider.id })
      .expect(200)
  ).body;
  return { provider, model: models[0] };
}

function keyEntry(fixture: Fixture, apiKey: string) {
  return {
    providerId: fixture.provider.id,
    baseUrl: fixture.provider.baseUrl,
    adapter: fixture.provider.adapter,
    apiKey,
  };
}

function job(device: Device, fixture: Fixture, prompt = "本地测试") {
  return {
    projectId: device.projectId,
    sessionId: device.sessionId,
    modelIds: [fixture.model.id],
    prompt,
    sizes: ["32x24"],
    qualities: ["auto"],
    count: 1,
    retries: 0,
    timeout: 5,
    idempotencyKey: randomUUID(),
  };
}

async function waitTask(
  device: Device,
  id: string,
  predicate: (task: Task) => boolean,
) {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    const tasks: Task[] = (await device.client.get("/api/tasks").expect(200))
      .body;
    const task = tasks.find((item) => item.id === id);
    if (task && predicate(task)) return task;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  throw new Error("任务未在期限内到达预期状态");
}

async function databaseBytes() {
  const directory = path.join(temp, "data");
  const names = (await readdir(directory)).filter((name) =>
    name.startsWith("workbench.sqlite"),
  );
  return Buffer.concat(
    await Promise.all(
      names.map((name) => readFile(path.join(directory, name))),
    ),
  );
}

async function assertNotPersisted(apiKey: string) {
  for (const table of ["providers", "tasks", "events", "requests", "charges"]) {
    assert.ok(
      !JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all()).includes(
        apiKey,
      ),
      `${table} 不应保存原始 Key`,
    );
  }
  assert.ok(
    !(await databaseBytes()).includes(Buffer.from(apiKey)),
    "活动 SQLite 和 WAL 不应包含原始 Key",
  );
}

async function taskEvents(device: Device, taskId: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(base + "/api/events", {
      headers: { Authorization: "Bearer " + device.token },
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    let content = "";
    while (
      !content.includes(taskId) ||
      !content.includes('"status":"failed"')
    ) {
      const { value, done } = await reader.read();
      if (done) break;
      content += new TextDecoder().decode(value);
    }
    assert.ok(content.includes(taskId));
    return content;
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

before(async () => {
  mock = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString();
    const input = raw ? JSON.parse(raw) : {};
    const key = String(req.headers.authorization || "").replace(/^Bearer /, "");
    received.push({ key, prompt: input.prompt || "", route: req.url || "" });
    res.setHeader("Content-Type", "application/json");
    if (req.url?.startsWith("/malformed/")) {
      res.end(key + " is not JSON");
    } else if (
      input.prompt === "echo-secret" ||
      req.url?.startsWith("/error/")
    ) {
      res.writeHead(401);
      res.end(
        JSON.stringify({ error: { message: "invalid API key: " + key } }),
      );
    } else if (req.url?.endsWith("/models")) {
      res.end(JSON.stringify({ data: [{ id: "gpt-image-test" }] }));
    } else if (req.url?.endsWith("/images/generations")) {
      res.end(
        JSON.stringify({ data: [{ b64_json: image.toString("base64") }] }),
      );
    } else {
      res.writeHead(404);
      res.end(JSON.stringify({ error: "未知测试接口" }));
    }
  });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));
  mockBase = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.on("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  owner = await newDevice();
  other = await newDevice();
});

after(async () => {
  await worker?.stop();
  for (const instance of [server, mock]) {
    if (!instance) continue;
    instance.closeAllConnections();
    await new Promise<void>((resolve) => instance.close(() => resolve()));
  }
  db.close();
  const resolved = path.resolve(temp);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.ok(
    resolved.startsWith(tempPrefix) && resolved.length > tempPrefix.length,
  );
  await rm(resolved, { recursive: true, force: true });
});

test("临时 Key 可访问正确上游，配置和预览不写入数据库，空 Key 复用内存", async () => {
  const apiKey = secret();
  const fixture = await createProvider(owner, apiKey);
  await owner.client
    .post("/api/models/discover")
    .send({ providerId: fixture.provider.id })
    .expect(200);
  assert.equal(received.at(-1)?.key, apiKey);
  await owner.client
    .post("/api/config")
    .send({ ...fixture.provider, apiKey: "" })
    .expect(200);
  await owner.client
    .post("/api/models/preview")
    .send({ ...fixture.provider, apiKey: "" })
    .expect(200);
  assert.equal(received.at(-1)?.key, apiKey);
  const previewKey = secret();
  await owner.client
    .post("/api/models/preview")
    .send({ baseUrl: mockBase, adapter: "openai", apiKey: previewKey })
    .expect(200);
  assert.equal(received.at(-1)?.key, previewKey);
  await assertNotPersisted(apiKey);
  await assertNotPersisted(previewKey);
});

test("上游回显 Key 时，同步错误、后台任务、SSE 和磁盘均脱敏", async () => {
  const apiKey = secret();
  const fixture = await createProvider(owner, apiKey);
  const error = await owner.client
    .post("/api/models/preview")
    .send({ baseUrl: mockBase + "/error", adapter: "openai", apiKey })
    .expect(401);
  assert.ok(!JSON.stringify(error.body).includes(apiKey));
  const queued = await owner.client
    .post("/api/tasks")
    .send(job(owner, fixture, "echo-secret"))
    .expect(202);
  assert.ok(!JSON.stringify(queued.body).includes(apiKey));
  worker = startWorker();
  try {
    const failed = await waitTask(
      owner,
      queued.body[0].id,
      (task) => task.status === "failed",
    );
    assert.equal(failed.attempts, 1);
    assert.ok(!JSON.stringify(failed).includes(apiKey));
    assert.match(failed.error || "", /redacted/i);
    assert.ok(!(await taskEvents(owner, failed.id)).includes(apiKey));
    await assertNotPersisted(apiKey);
  } finally {
    await worker.stop();
    worker = undefined;
  }
});

test("成功状态的畸形上游 JSON 不把 Key 或解析器截断片段写入探测错误", async () => {
  const apiKey = secret();
  const fixture = await createProvider(owner, apiKey);
  await owner.client
    .post("/api/config")
    .send({ ...fixture.provider, baseUrl: mockBase + "/malformed", apiKey })
    .expect(200);
  const response = await owner.client
    .post(`/api/models/${fixture.model.id}/probe`)
    .send({ capability: "chat", confirmCost: true, refresh: true })
    .expect(502);
  assert.match(response.body.error, /JSON/);
  const stored = db
    .prepare("SELECT data FROM models WHERE id=?")
    .get(fixture.model.id) as { data: string };
  assert.equal(JSON.parse(stored.data).probeError, response.body.error);
  assert.ok(!response.body.error.includes(apiKey.slice(0, 16)));
  assert.ok(
    !(await databaseBytes()).includes(Buffer.from(apiKey.slice(0, 16))),
  );
  await assertNotPersisted(apiKey);
});

test("设备隔离阻止读取、使用和覆盖别人的供应商凭证", async () => {
  const ownerKey = secret();
  const otherKey = secret();
  const fixture = await createProvider(owner, ownerKey);
  const ownOther = await createProvider(other, otherKey);
  const priorCalls = received.length;
  await other.client
    .post("/api/models/discover")
    .send({ providerId: fixture.provider.id })
    .expect(400);
  await other.client
    .post("/api/provider-keys")
    .send({ keys: [keyEntry(fixture, otherKey)] })
    .expect(404);
  await other.client
    .delete(`/api/provider-keys/${fixture.provider.id}`)
    .expect(404);
  const legacy = await other.client
    .get("/api/provider-keys/legacy")
    .expect(200);
  assert.ok(!JSON.stringify(legacy.body).includes(ownerKey));
  assert.equal(received.length, priorCalls);
  await owner.client
    .post("/api/models/discover")
    .send({ providerId: fixture.provider.id })
    .expect(200);
  assert.equal(received.at(-1)?.key, ownerKey);
  await other.client
    .post("/api/models/discover")
    .send({ providerId: ownOther.provider.id })
    .expect(200);
  assert.equal(received.at(-1)?.key, otherKey);
});

test("端点和适配器绑定拒绝旧凭证同步，修改端点后不转发原 Key", async () => {
  const apiKey = secret();
  const fixture = await createProvider(owner, apiKey);
  for (const mismatch of [
    { baseUrl: mockBase + "/other" },
    { adapter: "gemini" },
  ]) {
    const response = await owner.client
      .post("/api/provider-keys")
      .send({ keys: [{ ...keyEntry(fixture, secret()), ...mismatch }] });
    assert.ok(response.status >= 400 && response.status < 500);
  }
  await owner.client
    .post("/api/models/discover")
    .send({ providerId: fixture.provider.id })
    .expect(200);
  assert.equal(received.at(-1)?.key, apiKey);
  await owner.client
    .post("/api/config")
    .send({ ...fixture.provider, baseUrl: mockBase + "/changed", apiKey: "" })
    .expect(200);
  const priorCalls = received.length;
  const missing = await owner.client
    .post("/api/models/discover")
    .send({ providerId: fixture.provider.id })
    .expect(409);
  assert.match(missing.body.error, /Key|密钥|凭证/);
  assert.equal(received.length, priorCalls);
});

test("旧任务的端点副本续期不能清除新端点的 Key", async () => {
  const fixture = await createProvider(owner, secret());
  const newKey = secret();
  const response = await owner.client
    .post("/api/config")
    .send({
      ...fixture.provider,
      baseUrl: mockBase + "/changed",
      apiKey: newKey,
    })
    .expect(200);
  const updated: Provider = response.body.providers.find(
    (provider: Provider) => provider.id === fixture.provider.id,
  );
  assert.equal(getProviderKey(owner.id, updated), newKey);
  // 与任务 heartbeat 相同：旧副本尝试续期，只应读不到匹配凭证。
  assert.equal(getProviderKey(owner.id, fixture.provider, true), undefined);
  assert.equal(getProviderKey(owner.id, updated), newKey);
  await owner.client
    .post("/api/models/discover")
    .send({ providerId: updated.id })
    .expect(200);
  assert.equal(received.at(-1)?.key, newKey);
  assert.equal(received.at(-1)?.route, "/changed/v1/models");
  await assertNotPersisted(newKey);
});

test("缓存清除后队列等待不消耗重试，拒绝新提交，恢复凭证后继续原任务", async () => {
  const apiKey = secret();
  const fixture = await createProvider(owner, apiKey);
  const prompt = "等待浏览器恢复凭证";
  const queued = await owner.client
    .post("/api/tasks")
    .send(job(owner, fixture, prompt))
    .expect(202);
  await owner.client
    .delete(`/api/provider-keys/${fixture.provider.id}`)
    .expect(200);
  const missing = await owner.client
    .post("/api/tasks")
    .send(job(owner, fixture))
    .expect(409);
  assert.match(missing.body.error, /Key|密钥|凭证/);
  worker = startWorker();
  try {
    const waiting = await waitTask(
      owner,
      queued.body[0].id,
      (task) => task.waitingForKey === true,
    );
    assert.equal(waiting.status, "queued");
    assert.equal(waiting.attempts, 0);
    await new Promise((resolve) => setTimeout(resolve, 650));
    const stillWaiting = await waitTask(
      owner,
      waiting.id,
      (task) => task.waitingForKey === true,
    );
    assert.equal(stillWaiting.attempts, 0);
    assert.equal(
      received.filter((request) => request.prompt === prompt).length,
      0,
    );
    await owner.client
      .post("/api/provider-keys")
      .send({ keys: [keyEntry(fixture, apiKey)] })
      .expect(200);
    const complete = await waitTask(
      owner,
      waiting.id,
      (task) => task.status === "succeeded",
    );
    assert.equal(complete.attempts, 1);
    assert.ok(!complete.waitingForKey);
    assert.equal(
      received.filter((request) => request.prompt === prompt).length,
      1,
    );
    assert.equal(
      received.find((request) => request.prompt === prompt)?.key,
      apiKey,
    );
    await assertNotPersisted(apiKey);
  } finally {
    await worker.stop();
    worker = undefined;
  }
});

test("旧数据库 Key 仅所有者可迁移，错误确认不删除，成功确认清理活动数据库及 WAL", async () => {
  const legacyKey = secret();
  const foreignKey = secret();
  const fixture = await createProvider(owner, secret());
  const foreign = await createProvider(other, secret());
  for (const [value, apiKey] of [
    [fixture, legacyKey],
    [foreign, foreignKey],
  ] as const) {
    // 只在本测试的临时数据库模拟旧版保存格式。
    const row = db
      .prepare("SELECT data FROM providers WHERE id=?")
      .get(value.provider.id) as { data: string };
    db.prepare("UPDATE providers SET data=? WHERE id=?").run(
      JSON.stringify({ ...JSON.parse(row.data), apiKey }),
      value.provider.id,
    );
  }
  db.exec("PRAGMA wal_checkpoint(FULL)");
  assert.ok((await databaseBytes()).includes(Buffer.from(legacyKey)));
  const exported = await owner.client
    .get("/api/provider-keys/legacy")
    .expect(200);
  assert.match(exported.headers["cache-control"], /no-store/);
  assert.deepEqual(exported.body.keys, [keyEntry(fixture, legacyKey)]);
  const foreignExport = await other.client
    .get("/api/provider-keys/legacy")
    .expect(200);
  assert.deepEqual(foreignExport.body.keys, [keyEntry(foreign, foreignKey)]);
  const wrong = await owner.client
    .post("/api/provider-keys/legacy/ack")
    .send({ keys: [keyEntry(fixture, "incorrect-test-key")] });
  assert.ok(wrong.status >= 400 && wrong.status < 500);
  assert.deepEqual(
    (await owner.client.get("/api/provider-keys/legacy")).body.keys,
    exported.body.keys,
  );
  await owner.client
    .post("/api/provider-keys")
    .send({ keys: exported.body.keys })
    .expect(200);
  await owner.client
    .post("/api/provider-keys/legacy/ack")
    .send({ keys: exported.body.keys })
    .expect(200);
  assert.deepEqual(
    (await owner.client.get("/api/provider-keys/legacy")).body.keys,
    [],
  );
  await assertNotPersisted(legacyKey);
  assert.deepEqual(
    (await other.client.get("/api/provider-keys/legacy")).body.keys,
    foreignExport.body.keys,
  );
  await owner.client
    .post("/api/models/discover")
    .send({ providerId: fixture.provider.id })
    .expect(200);
  assert.equal(received.at(-1)?.key, legacyKey);
});

test("旧 Key 清理遇到读锁后保留迁移提示，释放锁可重试清除磁盘残留", async () => {
  const legacyKey = secret();
  const fixture = await createProvider(owner, secret());
  const stored = db
    .prepare("SELECT data FROM providers WHERE id=?")
    .get(fixture.provider.id) as { data: string };
  db.prepare("UPDATE providers SET data=? WHERE id=?").run(
    JSON.stringify({ ...JSON.parse(stored.data), apiKey: legacyKey }),
    fixture.provider.id,
  );
  db.exec("PRAGMA wal_checkpoint(FULL)");
  const reader = new DatabaseSync(path.join(temp, "data", "workbench.sqlite"));
  let readerOpen = true;
  try {
    reader.exec("BEGIN");
    reader.prepare("SELECT data FROM providers").all();
    // 在临时数据库保留旧快照，让 WAL 截断确定地遇到 busy，缩短测试锁超时。
    db.exec("PRAGMA busy_timeout=20");
    await owner.client
      .post("/api/provider-keys/legacy/ack")
      .send({ keys: [keyEntry(fixture, legacyKey)] })
      .expect(503);
    const config = await owner.client.get("/api/config").expect(200);
    assert.equal(
      config.body.providers.find(
        (item: Provider) => item.id === fixture.provider.id,
      ).legacyKeyAvailable,
      true,
    );
    const logical = db
      .prepare("SELECT data FROM providers WHERE id=?")
      .get(fixture.provider.id) as { data: string };
    assert.equal(JSON.parse(logical.data).apiKey, undefined);
    reader.exec("ROLLBACK");
    reader.close();
    readerOpen = false;
    const retried = await owner.client
      .get("/api/provider-keys/legacy")
      .expect(200);
    assert.deepEqual(retried.body.keys, []);
    await assertNotPersisted(legacyKey);
    const afterRetry = await owner.client.get("/api/config").expect(200);
    assert.ok(
      !afterRetry.body.providers.find(
        (item: Provider) => item.id === fixture.provider.id,
      ).legacyKeyAvailable,
    );
  } finally {
    if (readerOpen) reader.close();
    db.exec("PRAGMA busy_timeout=5000");
  }
});

test("退出设备同时使旧令牌失效并清除该设备内存 Key", async () => {
  const device = await newDevice();
  const apiKey = secret();
  const fixture = await createProvider(device, apiKey);
  await device.client
    .post("/api/models/discover")
    .send({ providerId: fixture.provider.id })
    .expect(200);
  assert.equal(received.at(-1)?.key, apiKey);
  await device.client.post("/api/logout").expect(200);
  await supertest(app)
    .get("/api/state")
    .set("Authorization", "Bearer " + device.token)
    .expect(401);
  // 从测试数据库取轮换后的设备令牌，以确认清掉的是内存 Key 而不只是浏览器 Cookie。
  const row = db
    .prepare("SELECT token FROM devices WHERE id=?")
    .get(device.id) as { token: string };
  const priorCalls = received.length;
  await supertest(app)
    .post("/api/models/discover")
    .set("Authorization", "Bearer " + row.token)
    .send({ providerId: fixture.provider.id })
    .expect(409);
  assert.equal(received.length, priorCalls);
  await assertNotPersisted(apiKey);
});
