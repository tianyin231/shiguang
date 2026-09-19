import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer, type Server } from "node:http";
import supertest from "supertest";
import sharp from "sharp";
import type { Task, Model, ImageAsset } from "../shared/types";

const temp = await mkdtemp(path.join(os.tmpdir(), "workbench-test-"));
process.env.DATA_DIR = path.join(temp, "data");
process.env.OUTPUT_DIR = path.join(temp, "images");
process.env.WORKER_CONCURRENCY = "4";
const { createApp } = await import("../server/app");
const { startWorker, taskList } = await import("../server/queue");
const { db, now } = await import("../server/db");
const image = await sharp({
  create: { width: 64, height: 48, channels: 4, background: "#ba7145" },
})
  .png()
  .toBuffer();
let mock: Server;
let server: Server;
let worker: ReturnType<typeof startWorker>;
let worker2: ReturnType<typeof startWorker>;
let base = "";
let mockBase = "";
let active = 0;
let highest = 0;
let calls = 0;
let edits = 0;
let gotKey = "";
let gotMask = false;
let lastBody = "";
let rateLimited = false;
let failing = true;
const app = createApp();
const client = supertest.agent(app);
let deviceId = "";
let token = "";
let projectId = "";
let sessionId = "";
let providerId = "";
let model: Model;
before(async () => {
  mock = createServer(async (req, res) => {
    const buffers: Buffer[] = [];
    for await (const b of req) buffers.push(Buffer.from(b));
    const raw = Buffer.concat(buffers);
    lastBody = raw.toString();
    gotKey = String(req.headers.authorization || "");
    if (req.url === "/v1beta/models") {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({ models: [{ name: "models/gemini-image-test" }] }),
      );
      return;
    }
    if (req.url === "/v1beta/models/gemini-image-test:generateContent") {
      assert.equal(req.headers["x-goog-api-key"], "gemini-test-key");
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    inlineData: {
                      mimeType: "image/png",
                      data: image.toString("base64"),
                    },
                  },
                ],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 },
        }),
      );
      return;
    }
    if (req.url === "/v1/messages") {
      assert.equal(req.headers["x-api-key"], "anthropic-test-key");
      assert.equal(req.headers["anthropic-version"], "2023-06-01");
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          content: [{ type: "text", text: "暖橘灯光中的夜景工坊。" }],
          usage: { input_tokens: 15, output_tokens: 10 },
        }),
      );
      return;
    }
    if (req.url === "/v1/models") {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          data: [{ id: "gpt-image-test" }, { id: "chat-test" }],
        }),
      );
      return;
    }
    if (req.url === "/v1/chat/completions") {
      const data = JSON.parse(raw.toString());
      if (data.stream) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n');
        setTimeout(() => res.end("data: [DONE]\n\n"), 40);
        return;
      }
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          choices: [{ message: { content: "保留主体，改为暖橘夜景。" } }],
          usage: { prompt_tokens: 20, completion_tokens: 12 },
          cost: 0.002,
        }),
      );
      return;
    }
    if (req.url?.startsWith("/v1/images/")) {
      calls++;
      active++;
      highest = Math.max(highest, active);
      let released = false;
      res.on("close", () => {
        if (!released) {
          active--;
          released = true;
        }
      });
      if (lastBody.includes("RATE_ONCE") && !rateLimited) {
        rateLimited = true;
        res.writeHead(429, {
          "Content-Type": "application/json",
          "Retry-After": "0",
        });
        res.end(JSON.stringify({ error: { message: "rate limited" } }));
        return;
      }
      if (lastBody.includes("ALWAYS_FAIL") && failing) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "unavailable" } }));
        return;
      }
      if (req.url === "/v1/images/edits") {
        edits++;
        assert.match(req.headers["content-type"] || "", /multipart\/form-data/);
        assert.ok(raw.includes(Buffer.from('name="image"')));
        gotMask = raw.includes(Buffer.from('name="mask"'));
      }
      const delay = lastBody.includes("SLOW") ? 1500 : 90;
      setTimeout(() => {
        if (!res.destroyed) {
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              data: [{ b64_json: image.toString("base64") }],
              cost: 0.03,
            }),
          );
        }
      }, delay);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => mock.listen(0, "127.0.0.1", r));
  mockBase = `http://127.0.0.1:${(mock.address() as any).port}`;
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.on("listening", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(async () => {
  await worker?.stop();
  await worker2?.stop();
  server?.closeAllConnections();
  mock?.closeAllConnections();
  await Promise.all([
    new Promise<void>((r) => server?.close(() => r())),
    new Promise<void>((r) => mock?.close(() => r())),
  ]);
  db.close();
  await rm(temp, { recursive: true, force: true });
});
const requestBody = (overrides: Record<string, unknown> = {}) => ({
  projectId,
  sessionId,
  modelIds: [model.id],
  prompt: "温暖工坊",
  variants: [],
  count: 1,
  sizes: ["64x48"],
  qualities: ["auto"],
  concurrency: 2,
  retries: 0,
  timeout: 10,
  priority: 0,
  allowFallback: false,
  idempotencyKey: crypto.randomUUID(),
  ...overrides,
});
async function waitTask(
  id: string,
  states = ["succeeded", "failed", "dead", "cancelled"],
): Promise<Task> {
  const until = Date.now() + 15000;
  while (Date.now() < until) {
    const tasks = await client.get("/api/tasks");
    const t = tasks.body.find((v: Task) => v.id === id);
    if (t && states.includes(t.status)) return t;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("任务超时 " + id);
}

test("端到端持久化工作台", async (t) => {
  await t.test(
    "发现草稿不保存，仅加入勾选模型，支持直接保存和保留密钥",
    async () => {
      const previewClient = supertest.agent(app);
      await previewClient.get("/api/config").expect(200);
      const draft = {
        baseUrl: mockBase,
        apiKey: "preview-key",
        adapter: "openai",
      };
      const preview = await previewClient
        .post("/api/models/preview")
        .send(draft)
        .expect(200);
      assert.equal(preview.body.names.length, 2);
      assert.equal(gotKey, "Bearer preview-key");
      assert.equal(
        (await previewClient.get("/api/config")).body.providers.length,
        0,
      );
      assert.equal((await previewClient.get("/api/models")).body.length, 0);
      const saved = await previewClient
        .post("/api/config")
        .send({ ...draft, selectedModels: [preview.body.names[0]] })
        .expect(200);
      const id = saved.body.activeProviderId;
      assert.equal((await previewClient.get("/api/models")).body.length, 1);
      const blankKey = { ...draft, id, apiKey: "" };
      await previewClient
        .post("/api/models/preview")
        .send(blankKey)
        .expect(200);
      assert.equal(gotKey, "Bearer preview-key");
      await previewClient
        .post("/api/config")
        .send({ ...blankKey, selectedModels: preview.body.names })
        .expect(200);
      assert.equal((await previewClient.get("/api/models")).body.length, 2);
      const direct = await previewClient
        .post("/api/config")
        .send(draft)
        .expect(200);
      assert.equal(
        (
          await previewClient
            .get("/api/models")
            .query({ providerId: direct.body.activeProviderId })
        ).body.length,
        0,
      );
      await previewClient
        .post("/api/models/preview")
        .send({ ...draft, baseUrl: "invalid" })
        .expect(400);
      assert.equal(
        (await previewClient.get("/api/config")).body.providers.length,
        2,
      );
    },
  );
  await t.test("设备凭证、密钥持久化、多供应商和本地网关", async () => {
    const initial = await client.get("/api/config").expect(200);
    token = initial.body.deviceToken;
    assert.ok(token);
    assert.ok(initial.headers["set-cookie"][0].includes("HttpOnly"));
    deviceId = String(
      (db.prepare("SELECT id FROM devices WHERE token=?").get(token) as any).id,
    );
    const first = await client
      .post("/api/config")
      .send({
        name: "Local",
        baseUrl: mockBase,
        apiKey: "test-key",
        adapter: "openai",
        concurrency: 2,
      })
      .expect(200);
    providerId = first.body.activeProviderId;
    assert.ok(!JSON.stringify(first.body).includes('"apiKey"'));
    const restore = await supertest(app)
      .get("/api/config")
      .set("Authorization", "Bearer " + token)
      .expect(200);
    assert.equal(restore.body.activeProviderId, providerId);
    const second = await client
      .post("/api/config")
      .send({
        name: "Second",
        baseUrl: mockBase,
        apiKey: "other-key",
        adapter: "openai",
      })
      .expect(200);
    assert.notEqual(second.body.activeProviderId, providerId);
    await client.post("/api/config/active").send({ providerId }).expect(200);
    const state = await client.get("/api/state");
    projectId = state.body.projects[0].id;
    sessionId = state.body.sessions[0].id;
  });
  await t.test("自动模型发现、手动添加与价格能力编辑", async () => {
    const result = await client
      .post("/api/models/discover")
      .send({ providerId })
      .expect(200);
    assert.equal(gotKey, "Bearer test-key");
    assert.equal(result.body.added, 2);
    model = result.body.models.find((m: Model) => m.name === "gpt-image-test");
    const edit = await client
      .patch("/api/models/" + model.id)
      .send({
        capabilities: ["text2image", "image2image", "mask"],
        maxConcurrency: 2,
        price: {
          type: "image",
          unit: 0.04,
          outputUnit: 0,
          currency: "USD",
          qualityMultiplier: { high: 2 },
        },
      })
      .expect(200);
    model = edit.body;
    await client
      .post("/api/models")
      .send({ providerId, name: "manual-image" })
      .expect(201);
    await client
      .post("/api/models/" + model.id + "/probe")
      .send({ capability: "image2image" })
      .expect(400);
  });
  await t.test("预算预估、拒绝超预算、记忆注入及提交幂等", async () => {
    await client
      .post("/api/memories")
      .send({ projectId, scope: "project", content: "角色必须拥有蓝色短发" })
      .expect(200);
    const body = requestBody({ count: 3 });
    const est = await client.post("/api/tasks/estimate").send(body).expect(200);
    assert.equal(est.body.totals.USD, 0.12);
    await client
      .post("/api/tasks")
      .send({ ...body, batchBudget: 0.1 })
      .expect(402);
    const before = await client.get("/api/tasks");
    assert.equal(before.body.length, 0);
    const [a, b] = await Promise.all([
      client.post("/api/tasks").send(body),
      client.post("/api/tasks").send(body),
    ]);
    assert.equal(a.status, 202);
    assert.deepEqual(
      a.body.map((t: Task) => t.id),
      b.body.map((t: Task) => t.id),
    );
    assert.equal(a.body.length, 3);
    assert.match(a.body[0].effectivePrompt, /蓝色短发/);
    const stored = db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as any;
    assert.equal(stored.n, 3);
  });
  let parent: ImageAsset;
  await t.test(
    "两个 worker 并发领取、结果保存、缩略图、sidecar 和去重",
    async () => {
      worker = startWorker();
      worker2 = startWorker();
      const list = await client.get("/api/tasks");
      for (const task of list.body)
        assert.equal((await waitTask(task.id)).status, "succeeded");
      assert.equal(calls, 3);
      assert.ok(highest <= 2);
      const images = await client.get("/api/images");
      assert.equal(images.body.length, 3);
      parent = images.body[0];
      assert.equal(parent.width, 64);
      assert.equal(parent.height, 48);
      const sidecar = JSON.parse(await readFile(parent.sidecarPath, "utf8"));
      assert.match(sidecar.effectivePrompt, /蓝色短发/);
      assert.equal(sidecar.costSource, "provider");
      assert.equal(sidecar.cost, 0.03);
      assert.equal(images.body[0].path, images.body[1].path);
      await client
        .get(parent.url)
        .expect(200)
        .expect("Content-Type", /image\/png/);
      await client
        .get(parent.thumbnailUrl)
        .expect(200)
        .expect("Content-Type", /image\/webp/);
    },
  );
  await t.test("真实 multipart 图生图、遮罩与父子关系", async () => {
    const upload = await client
      .post("/api/images/upload")
      .field("projectId", projectId)
      .field("sessionId", sessionId)
      .attach("image", image, "mask.png")
      .expect(201);
    const result = await client
      .post("/api/tasks")
      .send(requestBody({ referenceId: parent.id, maskId: upload.body.id }))
      .expect(202);
    const finished = await waitTask(result.body[0].id);
    assert.equal(finished.status, "succeeded");
    assert.equal(edits, 1);
    assert.equal(gotMask, true);
    const state = await client.get("/api/state");
    const child = state.body.images.find(
      (i: ImageAsset) => i.id === finished.imageIds[0],
    );
    assert.equal(child.parentId, parent.id);
    assert.equal(child.sessionId, sessionId);
  });
  await t.test("能力不足时明确拒绝，用户允许后使用元数据降级", async () => {
    const manual = (await client.get("/api/models")).body.find(
      (m: Model) => m.name === "manual-image",
    );
    await client
      .patch("/api/models/" + manual.id)
      .send({ capabilities: ["text2image"] })
      .expect(200);
    const body = requestBody({ modelIds: [manual.id], referenceId: parent.id });
    await client.post("/api/tasks").send(body).expect(400);
    const result = await client
      .post("/api/tasks")
      .send({ ...body, allowFallback: true })
      .expect(202);
    const task = await waitTask(result.body[0].id);
    assert.equal(task.fallback, true);
    assert.equal(task.params.referenceId, undefined);
    assert.match(task.effectivePrompt, /参考图元数据/);
  });
  await t.test(
    "绘画参数真正到达上游，负面词支持原生和文字降级并落盘",
    async () => {
      const negative = "文字、水印、杂乱线条";
      const fallback = await client
        .post("/api/tasks")
        .send(
          requestBody({
            negativePrompt: negative,
            sizes: ["2048x1152"],
            qualities: ["max"],
          }),
        )
        .expect(202);
      const completed = await waitTask(fallback.body[0].id);
      assert.equal(completed.status, "succeeded");
      const fallbackBody = JSON.parse(lastBody);
      assert.match(fallbackBody.prompt, /负面约束/);
      assert.match(fallbackBody.prompt, /杂乱线条/);
      assert.equal(fallbackBody.negative_prompt, undefined);
      assert.equal(fallbackBody.size, "2048x1152");
      assert.equal(fallbackBody.quality, "max");
      const asset = (await client.get("/api/images")).body.find(
        (i: ImageAsset) => i.taskId === completed.id,
      );
      assert.equal(
        JSON.parse(await readFile(asset.sidecarPath, "utf8")).params
          .negativePrompt,
        negative,
      );

      await client
        .patch(`/api/models/${model.id}`)
        .send({
          supportsSeed: true,
          imageParameters: [
            "negative_prompt",
            "background",
            "input_fidelity",
            "steps",
            "cfg_scale",
            "sampler_name",
            "strength",
          ],
        })
        .expect(200);
      const native = await client
        .post("/api/tasks")
        .send(
          requestBody({
            negativePrompt: negative,
            steps: 28,
            cfgScale: 6.5,
            sampler: "Euler",
            background: "transparent",
            seed: 0,
            extraParams: { style: "natural" },
          }),
        )
        .expect(202);
      assert.equal((await waitTask(native.body[0].id)).status, "succeeded");
      const nativeBody = JSON.parse(lastBody);
      assert.equal(nativeBody.negative_prompt, negative);
      assert.ok(!nativeBody.prompt.includes("负面约束"));
      assert.equal(nativeBody.steps, 28);
      assert.equal(nativeBody.cfg_scale, 6.5);
      assert.equal(nativeBody.sampler_name, "Euler");
      assert.equal(nativeBody.background, "transparent");
      assert.equal(nativeBody.seed, 0);
      assert.equal(nativeBody.style, "natural");

      const edit = await client
        .post("/api/tasks")
        .send(
          requestBody({
            referenceId: parent.id,
            negativePrompt: negative,
            inputFidelity: "high",
            strength: 0.35,
            background: "transparent",
          }),
        )
        .expect(202);
      assert.equal((await waitTask(edit.body[0].id)).status, "succeeded");
      assert.match(lastBody, /name="image"/);
      assert.match(lastBody, /name="input_fidelity"\r\n\r\nhigh/);
      assert.match(lastBody, /name="strength"\r\n\r\n0.35/);
      assert.match(lastBody, /name="negative_prompt"/);
    },
  );
  await t.test(
    "固定和递增 Seed、扩展参数保留字段以及不支持的控制项",
    async () => {
      for (const mode of ["fixed", "increment"]) {
        const jobs = await client
          .post("/api/tasks")
          .send(requestBody({ count: 3, seed: 41, seedMode: mode }))
          .expect(202);
        assert.deepEqual(
          jobs.body.map((t: Task) => t.params.seed),
          mode === "fixed" ? [41, 41, 41] : [41, 42, 43],
        );
        for (const t of jobs.body)
          assert.equal((await waitTask(t.id)).status, "succeeded");
      }
      const beforeCalls = calls;
      for (const extra of [
        { n: 4 },
        { prompt: "覆盖提示词" },
        { image: "替换原图" },
        { seed: 3 },
        { num_images: 3 },
      ]) {
        await client
          .post("/api/tasks")
          .send(requestBody({ extraParams: extra }))
          .expect(400);
      }
      await client
        .patch(`/api/models/${model.id}`)
        .send({ imageParameters: [] })
        .expect(200);
      await client
        .post("/api/tasks")
        .send(requestBody({ steps: 20 }))
        .expect(400);
      assert.equal(calls, beforeCalls);
      await client
        .patch(`/api/models/${model.id}`)
        .send({
          supportsSeed: false,
          imageParameters: ["background", "input_fidelity"],
        })
        .expect(200);
    },
  );
  await t.test("429 自适应退避与成功重试", async () => {
    const result = await client
      .post("/api/tasks")
      .send(requestBody({ prompt: "RATE_ONCE", retries: 1 }))
      .expect(202);
    const task = await waitTask(result.body[0].id);
    assert.equal(task.status, "succeeded");
    assert.equal(task.attempts, 2);
    assert.ok(task.logs.some((l) => l.text.includes("重试")));
  });
  await t.test("运行中取消与死信保留", async () => {
    const result = await client
      .post("/api/tasks")
      .send(requestBody({ prompt: "SLOW" }))
      .expect(202);
    await waitTask(result.body[0].id, ["running"]);
    await client
      .post("/api/tasks/" + result.body[0].id + "/cancel")
      .expect(200);
    assert.equal((await waitTask(result.body[0].id)).status, "cancelled");
    const fail = await client
      .post("/api/tasks")
      .send(requestBody({ prompt: "ALWAYS_FAIL", retries: 0 }))
      .expect(202);
    assert.equal((await waitTask(fail.body[0].id)).status, "dead");
  });
  await t.test("服务重启后的待执行任务恢复，过期租约恢复", async () => {
    await worker.stop();
    await worker2.stop();
    const result = await client
      .post("/api/tasks")
      .send(requestBody())
      .expect(202);
    const id = result.body[0].id;
    const row = JSON.parse(
      (db.prepare("SELECT data FROM tasks WHERE id=?").get(id) as any).data,
    );
    row.status = "running";
    db.prepare(
      "UPDATE tasks SET status='running',lease_until=?,owner='old-worker',data=? WHERE id=?",
    ).run(now() - 1, JSON.stringify(row), id);
    worker = startWorker();
    const task = await waitTask(id);
    assert.equal(task.status, "succeeded");
    assert.ok(task.logs.some((l) => l.text.includes("租约失效")));
  });
  await t.test("画布保存、版本、冲突检测和项目分支导入", async () => {
    const canvas = {
      nodes: [
        {
          id: "parent",
          type: "work",
          position: { x: 0, y: 0 },
          data: { imageId: parent.id },
        },
        {
          id: "child",
          type: "work",
          position: { x: 300, y: 0 },
          data: { text: "继续迭代" },
        },
      ],
      edges: [{ id: "lineage", source: "parent", target: "child" }],
    };
    const save = await client
      .put("/api/projects/" + projectId + "/canvas")
      .send({ revision: 0, canvas })
      .expect(200);
    assert.equal(save.body.revision, 1);
    await client
      .put("/api/projects/" + projectId + "/canvas")
      .send({ revision: 0, canvas })
      .expect(409);
    const snapshot = await client
      .post("/api/projects/" + projectId + "/versions")
      .send({ name: "版本一" })
      .expect(200);
    const exported = await client
      .get("/api/projects/" + projectId + "/export")
      .expect(200);
    assert.equal(exported.body.project.canvas.edges[0].target, "child");
    await client.post("/api/projects/import").send(exported.body).expect(200);
    await client
      .post("/api/projects/" + projectId + "/restore/" + snapshot.body.id)
      .expect(200);
  });
  await t.test("多模态追问、会话压缩和预算持久化", async () => {
    const chatModel = (await client.get("/api/models")).body.find(
      (m: Model) => m.name === "chat-test",
    );
    await client.patch("/api/models/" + chatModel.id).send({
      capabilities: ["chat", "vision", "streaming"],
      price: {
        type: "token",
        unit: 1,
        outputUnit: 2,
        currency: "USD",
        qualityMultiplier: {},
      },
    });
    const answer = await client
      .post("/api/chat")
      .send({
        modelId: chatModel.id,
        sessionId,
        message: "换成夜景",
        imageId: parent.id,
      })
      .expect(200);
    assert.equal(answer.body.vision, true);
    assert.match(lastBody, /data:image\/png;base64/);
    assert.equal(answer.body.cost, 0.002);
    const compressed = await client
      .post("/api/sessions/" + sessionId + "/compress")
      .expect(200);
    assert.equal(compressed.body.messages.length, 0);
    assert.match(compressed.body.summary, /换成夜景/);
    const config = await client.get("/api/config");
    await client
      .put("/api/settings")
      .send({ ...config.body.settings, totalBudgets: { USD: 0 } })
      .expect(200);
    await client.post("/api/tasks").send(requestBody()).expect(402);
    await client
      .put("/api/settings")
      .send({ ...config.body.settings, totalBudgets: {} })
      .expect(200);
  });
  await t.test("SSE 持久事件、代理 SSE 透传、成本导出", async () => {
    const controller = new AbortController();
    const res = await fetch(base + "/api/events", {
      headers: { Authorization: "Bearer " + token },
      signal: controller.signal,
    });
    assert.match(res.headers.get("content-type") || "", /event-stream/);
    const reader = res.body!.getReader();
    let text = "";
    for (let i = 0; i < 3 && !text.includes("event: task"); i++)
      text += new TextDecoder().decode((await reader.read()).value);
    assert.ok(text.includes("event: ready"));
    assert.ok(text.includes("event: task"));
    controller.abort();
    const proxy = await client
      .post("/api/proxy/chat/completions")
      .send({
        model: "chat-test",
        messages: [{ role: "user", content: "Hi" }],
        stream: true,
      })
      .expect(200);
    assert.match(proxy.text, /hello/);
    assert.match(proxy.text, /\[DONE\]/);
    const costs = await client.get("/api/costs").expect(200);
    assert.ok(costs.body.totals.USD.settled > 0);
    const csv = await client.get("/api/costs/export").expect(200);
    assert.match(csv.text, /provider/);
  });
  await t.test("代理 multipart、实际计费、未知模型和代理预算熔断", async () => {
    await client
      .post("/api/proxy/images/generations")
      .send({ model: "unknown-model", prompt: "test" })
      .expect(400);
    await client
      .post("/api/proxy/images/edits")
      .field("model", model.name)
      .field("prompt", "edit")
      .attach("image", image, "reference.png")
      .expect(200);
    const charge = db
      .prepare(
        "SELECT amount,source FROM charges WHERE kind='proxy' ORDER BY created_at DESC LIMIT 1",
      )
      .get() as any;
    assert.equal(charge.amount, 0.03);
    assert.equal(charge.source, "provider");
    const config = await client.get("/api/config");
    await client
      .put("/api/settings")
      .send({ ...config.body.settings, totalBudgets: { USD: 0 } })
      .expect(200);
    await client
      .post("/api/proxy/images/generations")
      .send({ model: model.name, prompt: "test" })
      .expect(402);
    await client
      .put("/api/settings")
      .send({ ...config.body.settings, totalBudgets: {} })
      .expect(200);
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM proxy_leases").get() as any).n,
      0,
    );
  });
  await t.test("能力缓存按能力区分，手动重试保留原请求未知费用", async () => {
    const chatModel = (await client.get("/api/models")).body.find(
      (m: Model) => m.name === "chat-test",
    );
    await client
      .post("/api/models/" + chatModel.id + "/probe")
      .send({ capability: "chat", confirmCost: true })
      .expect(200);
    await client
      .post("/api/models/" + chatModel.id + "/probe")
      .send({ capability: "vision", confirmCost: true })
      .expect(400);
    const probe = await client
      .post("/api/models/" + chatModel.id + "/probe")
      .send({ capability: "vision", referenceId: parent.id, confirmCost: true })
      .expect(200);
    assert.ok(!probe.body.cached);
    assert.equal(probe.body.model.verified.vision, true);
    const failed = (await client.get("/api/tasks")).body.find(
      (t: Task) => t.prompt === "ALWAYS_FAIL",
    );
    failing = false;
    await client.post("/api/tasks/" + failed.id + "/retry").expect(200);
    assert.equal((await waitTask(failed.id)).status, "succeeded");
    const charges = db
      .prepare("SELECT data FROM charges WHERE kind='uncertain'")
      .all() as { data: string }[];
    assert.ok(charges.some((c) => JSON.parse(c.data).taskId === failed.id));
  });
  await t.test("Gemini 参考图和 Anthropic 视觉原生协议适配", async () => {
    const gemini = await client
      .post("/api/config")
      .send({
        name: "Gemini Mock",
        baseUrl: mockBase,
        apiKey: "gemini-test-key",
        adapter: "gemini",
      })
      .expect(200);
    const discovered = await client
      .post("/api/models/discover")
      .send({ providerId: gemini.body.activeProviderId })
      .expect(200);
    const native = discovered.body.models[0];
    await client
      .patch(`/api/models/${native.id}`)
      .send({ imageParameters: ["image_size"] })
      .expect(200);
    const job = await client
      .post("/api/tasks")
      .send(
        requestBody({
          modelIds: [native.id],
          referenceId: parent.id,
          sizes: ["1536x1152"],
          imageSize: "2K",
          negativePrompt: "不要文字",
        }),
      )
      .expect(202);
    assert.equal((await waitTask(job.body[0].id)).status, "succeeded");
    const nativeBody = JSON.parse(lastBody);
    assert.equal(
      nativeBody.contents[0].parts[1].inlineData.mimeType,
      "image/png",
    );
    assert.ok(nativeBody.contents[0].parts[1].inlineData.data.length > 0);
    assert.deepEqual(nativeBody.generationConfig.imageConfig, {
      aspectRatio: "4:3",
      imageSize: "2K",
    });
    assert.match(nativeBody.contents[0].parts[0].text, /不要文字/);
    const anthropic = await client
      .post("/api/config")
      .send({
        name: "Anthropic Mock",
        baseUrl: mockBase,
        apiKey: "anthropic-test-key",
        adapter: "anthropic",
      })
      .expect(200);
    const claude = await client
      .post("/api/models")
      .send({
        providerId: anthropic.body.activeProviderId,
        name: "claude-test",
      })
      .expect(201);
    const answer = await client
      .post("/api/chat")
      .send({
        modelId: claude.body.id,
        sessionId,
        message: "改为夜景",
        imageId: parent.id,
      })
      .expect(200);
    assert.equal(answer.body.vision, true);
    assert.match(lastBody, /"media_type":"image\/png"/);
    assert.match(answer.body.text, /暖橘/);
    await client
      .post("/api/tasks")
      .send(requestBody({ modelIds: [claude.body.id] }))
      .expect(400);
    await client.post("/api/config/active").send({ providerId }).expect(200);
  });
  await t.test("跨供应商批次遵守共享并发上限，名称可以省略", async () => {
    const extra = await client
      .post("/api/config")
      .send({ baseUrl: mockBase, adapter: "openai" })
      .expect(200);
    assert.ok(
      extra.body.providers.find(
        (p: any) => p.id === extra.body.activeProviderId,
      ).name,
    );
    const other = await client
      .post("/api/models")
      .send({
        providerId: extra.body.activeProviderId,
        name: "gpt-image-other",
      })
      .expect(201);
    highest = 0;
    const tasks = await client
      .post("/api/tasks")
      .send(
        requestBody({
          modelIds: [model.id, other.body.id],
          count: 2,
          concurrency: 1,
        }),
      )
      .expect(202);
    for (const task of tasks.body)
      assert.equal((await waitTask(task.id)).status, "succeeded");
    assert.ok(highest <= 1, `实际同时请求数 ${highest}`);
    await client.post("/api/config/active").send({ providerId }).expect(200);
  });
});
