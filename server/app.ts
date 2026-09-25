import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import multer from "multer";
import { z } from "zod";
import path from "node:path";
import {
  db,
  uid,
  now,
  all,
  get,
  put,
  remove,
  event,
  settings,
  deviceByToken,
  createDevice,
  transaction,
  type Device,
} from "./db";
import {
  defaultModel,
  discover,
  ApiError,
  chat,
  chatRequest,
  upstream,
} from "./providers";
import {
  saveImage,
  writableDirectory,
  updateSidecar,
  deleteFiles,
  dataUrl,
  commitImage,
} from "./storage";
import {
  enqueue,
  estimate,
  taskList,
  taskRow,
  cancelTask,
  retryTask,
  costUsage,
  imagePrice,
  writeTask,
} from "./queue";
import { injectMemory } from "./memory";
import { registerVideoRoutes } from "./video";
import {
  generationSchema,
  providerSchema,
  modelPatchSchema,
  settingsSchema,
  canvasSchema,
} from "./validation";
import type {
  Provider,
  Model,
  Project,
  Session,
  Memory,
  ImageAsset,
  Task,
  Canvas,
} from "../shared/types";

declare global {
  namespace Express {
    interface Request {
      device: Device;
    }
  }
}
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});
const id = (req: Request, key = "id") => String(req.params[key]);
const safeProvider = (p: Provider) => {
  const { apiKey, ...value } = p;
  return { ...value, keyHint: apiKey ? "••••" + apiKey.slice(-4) : "" };
};
const cookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.COOKIE_SECURE === "true",
  maxAge: 90 * 86400000,
  path: "/",
};
function config(req: Request) {
  return {
    providers: all<Provider>("providers", req.device.id).map(safeProvider),
    activeProviderId: (
      db
        .prepare("SELECT active_provider_id FROM devices WHERE id=?")
        .get(req.device.id) as { active_provider_id: string | null }
    ).active_provider_id,
    settings: settings(req.device.id),
  };
}
function createProject(
  deviceId: string,
  name: string,
  canvas: Canvas = { nodes: [], edges: [] },
): { project: Project; session: Session } {
  const project: Project = {
    id: uid(),
    name,
    canvas,
    revision: 0,
    createdAt: now(),
  };
  put("projects", deviceId, project);
  const session: Session = {
    id: uid(),
    projectId: project.id,
    title: "创作会话",
    messages: [],
    summary: "",
    createdAt: now(),
  };
  put("sessions", deviceId, session, { project_id: project.id });
  return { project, session };
}
function provider(req: Request, providerId?: string) {
  const value = get<Provider>(
    "providers",
    providerId || req.device.active_provider_id || "",
    req.device.id,
  );
  if (!value) throw new ApiError(400, "请先配置供应商");
  return value;
}
function owned<T>(
  req: Request,
  table: Parameters<typeof get>[0],
  key = id(req),
): T {
  const value = get<T>(table, key, req.device.id);
  if (!value) throw new ApiError(404, "记录不存在");
  return value;
}

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.use("/api/proxy", express.raw({ type: () => true, limit: "60mb" }));
  app.use(express.json({ limit: "12mb" }));
  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  app.use("/api", (req, res, next) => {
    const cookie = req.headers.cookie
      ?.split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith("workbench_device="))
      ?.slice("workbench_device=".length);
    const token =
      req.get("Authorization")?.replace(/^Bearer /, "") || cookie || "";
    let d = deviceByToken(token);
    if (!d && req.path === "/config") {
      d = createDevice();
      createProject(d.id, "我的第一幅作品");
    }
    if (!d) {
      res.status(401).json({ error: "设备会话已退出，请刷新页面重新连接" });
      return;
    }
    req.device = d;
    db.prepare("UPDATE devices SET last_seen=? WHERE id=?").run(now(), d.id);
    if (req.path === "/config")
      res.cookie("workbench_device", d.token, cookieOptions);
    next();
  });
  registerVideoRoutes(app);
  app.get("/api/config", (req, res) =>
    res.json({ ...config(req), deviceToken: req.device.token }),
  );
  app.post("/api/config", async (req, res) => {
    const input = providerSchema.parse(req.body);
    const selectedModels = z
      .array(z.string().min(1).max(200))
      .max(5000)
      .optional()
      .parse(req.body.selectedModels);
    const old = input.id
      ? owned<Provider>(req, "providers", input.id)
      : undefined;
    const value: Provider = {
      ...input,
      name: input.name || old?.name || new URL(input.baseUrl).hostname,
      id: old?.id || uid(),
      apiKey: input.apiKey || old?.apiKey || "",
      createdAt: old?.createdAt || now(),
      adaptiveLimit: input.concurrency,
      cooldownUntil: 0,
    };
    put("providers", req.device.id, value);
    const models = all<Model>("models", req.device.id);
    for (const name of new Set(selectedModels || [])) {
      if (!models.some((m) => m.providerId === value.id && m.name === name)) {
        put(
          "models",
          req.device.id,
          defaultModel(value.id, name, value.adapter),
          {
            provider_id: value.id,
          },
        );
      }
    }
    db.prepare("UPDATE devices SET active_provider_id=? WHERE id=?").run(
      value.id,
      req.device.id,
    );
    res.json({ ...config(req), deviceToken: req.device.token });
  });
  app.post("/api/config/active", (req, res) => {
    const p = owned<Provider>(
      req,
      "providers",
      z.string().parse(req.body.providerId),
    );
    db.prepare("UPDATE devices SET active_provider_id=? WHERE id=?").run(
      p.id,
      req.device.id,
    );
    res.json(config(req));
  });
  app.put("/api/settings", async (req, res) => {
    const input = settingsSchema.parse(req.body);
    input.outputDir = await writableDirectory(input.outputDir);
    db.prepare("UPDATE devices SET settings=? WHERE id=?").run(
      JSON.stringify(input),
      req.device.id,
    );
    res.json(input);
  });
  app.post("/api/logout", (req, res) => {
    db.prepare("UPDATE devices SET token=? WHERE id=?").run(
      uid() + uid(),
      req.device.id,
    );
    res.clearCookie("workbench_device", { path: "/" }).json({ ok: true });
  });
  app.get("/api/state", (req, res) =>
    res.json({
      models: all<Model>("models", req.device.id),
      projects: all<Project>("projects", req.device.id),
      sessions: all<Session>("sessions", req.device.id),
      tasks: taskList(req.device.id),
      images: all<ImageAsset>("images", req.device.id),
      memories: all<Memory>("memories", req.device.id),
    }),
  );
  app.get("/api/models", (req, res) =>
    res.json(
      all<Model>("models", req.device.id).filter(
        (m) => !req.query.providerId || m.providerId === req.query.providerId,
      ),
    ),
  );
  app.post("/api/models/preview", async (req, res) => {
    const input = providerSchema.parse(req.body);
    const old = input.id
      ? owned<Provider>(req, "providers", input.id)
      : undefined;
    const draft: Provider = {
      ...input,
      id: old?.id || "preview",
      apiKey: input.apiKey || old?.apiKey || "",
      createdAt: old?.createdAt || now(),
      adaptiveLimit: input.concurrency,
      cooldownUntil: 0,
    };
    res.json({ names: await discover(draft, AbortSignal.timeout(30000)) });
  });
  app.post("/api/models/discover", async (req, res) => {
    const p = provider(req, req.body.providerId);
    const names = await discover(p, AbortSignal.timeout(30000));
    const models = all<Model>("models", req.device.id);
    let added = 0;
    for (const name of names)
      if (!models.some((m) => m.providerId === p.id && m.name === name)) {
        const model = defaultModel(p.id, name, p.adapter);
        put("models", req.device.id, model, { provider_id: p.id });
        added++;
      }
    event(req.device.id, "models", {});
    res.json({
      added,
      models: all<Model>("models", req.device.id).filter(
        (m) => m.providerId === p.id,
      ),
    });
  });
  app.post("/api/models", (req, res) => {
    const p = provider(req, req.body.providerId);
    const name = z.string().min(1).max(200).parse(req.body.name);
    if (
      all<Model>("models", req.device.id).some(
        (m) => m.providerId === p.id && m.name === name,
      )
    )
      throw new ApiError(409, "此供应商已存在同名模型");
    const model = {
      ...defaultModel(p.id, name, p.adapter),
      ...modelPatchSchema.parse(req.body),
    };
    put("models", req.device.id, model, { provider_id: p.id });
    res.status(201).json(model);
  });
  app.patch("/api/models/:id", (req, res) => {
    const old = owned<Model>(req, "models");
    const patch = modelPatchSchema.parse(req.body);
    if (patch.isDefault)
      for (const m of all<Model>("models", req.device.id).filter(
        (m) => m.providerId === old.providerId,
      )) {
        m.isDefault = false;
        put("models", req.device.id, m, { provider_id: m.providerId });
      }
    const value = { ...old, ...patch };
    put("models", req.device.id, value, { provider_id: value.providerId });
    res.json(value);
  });
  app.post("/api/models/:id/probe", async (req, res) => {
    if (req.body.confirmCost !== true)
      throw new ApiError(400, "能力探测可能产生费用，需要 confirmCost=true");
    const capability = z
      .enum(["text2image", "image2image", "vision", "chat"])
      .parse(req.body.capability);
    const m = owned<Model>(req, "models");
    if (
      req.body.refresh !== true &&
      m.verified[capability] !== undefined &&
      m.probeAt &&
      now() - m.probeAt < 86400000
    ) {
      res.json({ cached: true, model: m });
      return;
    }
    if (capability === "chat" || capability === "vision") {
      const p = provider(req, m.providerId);
      const ref = req.body.referenceId
        ? owned<ImageAsset>(req, "images", req.body.referenceId)
        : undefined;
      if (capability === "vision" && !ref)
        throw new ApiError(400, "视觉探测需要一张参考图");
      try {
        const answer = await billedChat(
          req.device.id,
          m,
          p,
          {
            model: m.name,
            max_tokens: 128,
            messages: [
              {
                role: "user",
                content: ref
                  ? [
                      { type: "text", text: "用一句话描述此图。" },
                      {
                        type: "image_url",
                        image_url: { url: await dataUrl(ref) },
                      },
                    ]
                  : "只回复 OK。",
              },
            ],
          },
          AbortSignal.timeout(60000),
          "probe",
        );
        m.verified[capability] = !!answer.text;
        m.probeAt = now();
        m.probeError = undefined;
        put("models", req.device.id, m, { provider_id: m.providerId });
        res.json({ model: m, reply: answer.text });
      } catch (e) {
        if (e instanceof ApiError && [401, 403, 404, 405].includes(e.status))
          m.verified[capability] = false;
        m.probeAt = now();
        m.probeError = (e as Error).message;
        put("models", req.device.id, m, { provider_id: m.providerId });
        throw e;
      }
    } else {
      if (capability === "image2image" && !req.body.referenceId)
        throw new ApiError(400, "图生图探测需要一张参考图");
      if (!m.capabilities.includes(capability)) m.capabilities.push(capability);
      delete m.verified[capability];
      put("models", req.device.id, m, { provider_id: m.providerId });
      const jobs = enqueue(
        req.device.id,
        generationSchema.parse({
          ...req.body,
          modelIds: [m.id],
          prompt: "一枚简单的暖橘色圆形，无文字。",
          count: 1,
          retries: 0,
          idempotencyKey: uid(),
        }),
      );
      res.status(202).json({ tasks: jobs });
    }
  });
  app.post("/api/projects", (req, res) => {
    res
      .status(201)
      .json(
        createProject(
          req.device.id,
          z.string().min(1).max(100).parse(req.body.name),
        ),
      );
  });
  app.put("/api/projects/:id/canvas", (req, res) => {
    const canvas = canvasSchema.parse(req.body.canvas) as Canvas;
    const revision = z.number().int().parse(req.body.revision);
    const project = transaction(() => {
      const current = owned<Project>(req, "projects");
      if (current.revision !== revision)
        throw new ApiError(409, "画布已在另一个窗口更新，请重新载入后保存");
      current.canvas = canvas;
      current.revision++;
      put("projects", req.device.id, current);
      return current;
    });
    res.json(project);
  });
  app.post("/api/projects/:id/versions", (req, res) => {
    const p = owned<Project>(req, "projects");
    const version = {
      id: uid(),
      projectId: p.id,
      name: String(req.body.name || "手动快照").slice(0, 100),
      createdAt: now(),
      canvas: p.canvas,
    };
    put("versions", req.device.id, version, {
      project_id: p.id,
      created_at: version.createdAt,
    });
    res.json(version);
  });
  app.get("/api/projects/:id/versions", (req, res) => {
    owned(req, "projects");
    res.json(
      all<{ projectId: string }>("versions", req.device.id).filter(
        (v) => v.projectId === id(req),
      ),
    );
  });
  app.post("/api/projects/:id/restore/:version", (req, res) => {
    const p = owned<Project>(req, "projects");
    const v = owned<{ id: string; projectId: string; canvas: Canvas }>(
      req,
      "versions",
      id(req, "version"),
    );
    if (v.projectId !== p.id) throw new ApiError(400, "版本不属于该项目");
    p.canvas = v.canvas;
    p.revision++;
    put("projects", req.device.id, p);
    res.json(p);
  });
  app.get("/api/projects/:id/export", (req, res) => {
    const p = owned<Project>(req, "projects");
    res.attachment("project.json").json({
      schemaVersion: 1,
      project: p,
      memories: all<Memory>("memories", req.device.id).filter(
        (m) => m.projectId === p.id,
      ),
      images: all<ImageAsset>("images", req.device.id)
        .filter((i) => i.projectId === p.id)
        .map(({ path, thumbnailPath, sidecarPath, ...image }) => image),
    });
  });
  app.post("/api/projects/import", (req, res) => {
    const input = z
      .object({
        schemaVersion: z.literal(1),
        project: z.object({ name: z.string().min(1), canvas: canvasSchema }),
        memories: z
          .array(
            z.object({
              content: z.string(),
              scope: z.enum(["project", "session", "image"]),
            }),
          )
          .optional(),
      })
      .parse(req.body);
    const canvas = input.project.canvas as Canvas;
    // 导入文件不包含图片二进制，跨设备缺失资源显示占位，避免伪造路径。
    const created = createProject(
      req.device.id,
      input.project.name + " · 副本",
      canvas,
    );
    for (const memory of input.memories || []) {
      const m: Memory = {
        id: uid(),
        projectId: created.project.id,
        scope: "project",
        content: memory.content,
        enabled: true,
        createdAt: now(),
      };
      put("memories", req.device.id, m, { project_id: m.projectId });
    }
    res.json(created);
  });
  app.post("/api/sessions", (req, res) => {
    const p = owned<Project>(req, "projects", req.body.projectId);
    const s: Session = {
      id: uid(),
      projectId: p.id,
      title: String(req.body.title || "新的会话").slice(0, 100),
      summary: "",
      messages: [],
      createdAt: now(),
    };
    put("sessions", req.device.id, s, { project_id: p.id });
    res.json(s);
  });
  app.post("/api/sessions/:id/compress", (req, res) => {
    const s = owned<Session>(req, "sessions");
    s.summary = (
      s.summary +
      "\n" +
      s.messages.map((m) => `${m.role}: ${m.content}`).join("\n")
    ).slice(-5000);
    s.messages = [];
    put("sessions", req.device.id, s, { project_id: s.projectId });
    res.json(s);
  });
  app.delete("/api/sessions/:id/context", (req, res) => {
    const s = owned<Session>(req, "sessions");
    s.messages = [];
    s.summary = "";
    put("sessions", req.device.id, s, { project_id: s.projectId });
    res.json(s);
  });
  app.post("/api/chat", async (req, res) => {
    const input = z
      .object({
        modelId: z.string(),
        sessionId: z.string(),
        message: z.string().min(1).max(20000),
        imageId: z.string().optional(),
      })
      .parse(req.body);
    const m = owned<Model>(req, "models", input.modelId);
    const s = owned<Session>(req, "sessions", input.sessionId);
    const p = provider(req, m.providerId);
    if (!m.capabilities.includes("chat"))
      throw new ApiError(400, "模型未标记对话能力");
    const image = input.imageId
      ? owned<ImageAsset>(req, "images", input.imageId)
      : undefined;
    const vision =
      !!image &&
      m.capabilities.includes("vision") &&
      m.verified.vision !== false;
    const memory = injectMemory(
      req.device.id,
      s.projectId,
      s.id,
      input.message,
      image?.id,
    );
    const messages = [
      {
        role: "system",
        content:
          "你是图像创作助手。结合上下文改写用户的生图提示词，只返回可直接生成的提示词。",
      },
      ...s.messages.slice(-8),
      {
        role: "user",
        content: vision
          ? [
              { type: "text", text: memory.effectivePrompt },
              { type: "image_url", image_url: { url: await dataUrl(image!) } },
            ]
          : memory.effectivePrompt,
      },
    ];
    const answer = await billedChat(
      req.device.id,
      m,
      p,
      { model: m.name, messages, max_tokens: 2048 },
      AbortSignal.timeout(180000),
    );
    if (!answer.text) throw new ApiError(502, "模型没有返回文本");
    const cost = answer.settledCost;
    s.messages.push(
      { role: "user", content: input.message },
      { role: "assistant", content: answer.text },
    );
    put("sessions", req.device.id, s, { project_id: s.projectId });
    res.json({
      text: answer.text,
      vision,
      fallback: !!image && !vision,
      cost,
      currency: m.price.currency,
      session: s,
    });
  });
  app.get("/api/memories", (req, res) =>
    res.json(all<Memory>("memories", req.device.id)),
  );
  app.post("/api/memories", (req, res) => {
    const input = z
      .object({
        id: z.string().optional(),
        projectId: z.string(),
        sessionId: z.string().optional(),
        imageId: z.string().optional(),
        scope: z.enum(["project", "session", "image"]),
        content: z.string().min(1).max(12000),
        enabled: z.boolean().default(true),
      })
      .parse(req.body);
    owned(req, "projects", input.projectId);
    if (input.id) owned(req, "memories", input.id);
    if (input.scope === "session") {
      const s = owned<Session>(req, "sessions", input.sessionId || "");
      if (s.projectId !== input.projectId)
        throw new ApiError(400, "会话不属于此项目");
    }
    if (input.scope === "image") owned(req, "images", input.imageId || "");
    const value: Memory = { ...input, id: input.id || uid(), createdAt: now() };
    put("memories", req.device.id, value, { project_id: value.projectId });
    res.json(value);
  });
  app.delete("/api/memories/:id", (req, res) => {
    remove("memories", id(req), req.device.id);
    res.json({ ok: true });
  });
  app.post("/api/tasks/estimate", (req, res) =>
    res.json(estimate(req.device.id, generationSchema.parse(req.body))),
  );
  app.post("/api/tasks", (req, res) =>
    res
      .status(202)
      .json(enqueue(req.device.id, generationSchema.parse(req.body))),
  );
  app.get("/api/tasks", (req, res) => res.json(taskList(req.device.id)));
  app.post("/api/tasks/:id/cancel", (req, res) =>
    res.json(cancelTask(id(req), req.device.id)),
  );
  app.post("/api/tasks/:id/retry", (req, res) =>
    res.json(retryTask(id(req), req.device.id)),
  );
  app.patch("/api/tasks/:id", (req, res) => {
    const row = taskRow(id(req), req.device.id);
    if (!row) throw new ApiError(404, "任务不存在");
    const t: Task = JSON.parse(row.data);
    t.priority = z.number().int().min(0).max(10).parse(req.body.priority);
    writeTask(t, req.device.id);
    res.json(t);
  });
  app.get("/api/events", (req, res) => {
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    let cursor = Number(req.get("Last-Event-ID") || req.query.after || 0);
    res.write("event: ready\ndata: {}\n\n");
    const timer = setInterval(() => {
      const rows = db
        .prepare(
          "SELECT * FROM events WHERE device_id=? AND id>? ORDER BY id LIMIT 100",
        )
        .all(req.device.id, cursor) as unknown as {
        id: number;
        type: string;
        data: string;
      }[];
      for (const row of rows) {
        cursor = row.id;
        res.write(`id: ${row.id}\nevent: ${row.type}\ndata: ${row.data}\n\n`);
      }
      if (!rows.length) res.write(": heartbeat\n\n");
    }, 800);
    res.on("close", () => clearInterval(timer));
  });
  app.get("/api/images", (req, res) =>
    res.json(all<ImageAsset>("images", req.device.id)),
  );
  app.post("/api/images/upload", upload.single("image"), async (req, res) => {
    if (!req.file) throw new ApiError(400, "请选择图片");
    const p = owned<Project>(req, "projects", req.body.projectId);
    const s = owned<Session>(req, "sessions", req.body.sessionId);
    if (s.projectId !== p.id) throw new ApiError(400, "会话与项目不匹配");
    const image = await saveImage(req.device.id, req.file.buffer, {
      projectId: p.id,
      sessionId: s.id,
      prompt: String(req.body.prompt || req.file.originalname),
      effectivePrompt: "",
      modelName: "本地导入",
      params: { size: "auto", quality: "auto" },
      currency: "USD",
      costSource: "estimate",
    });
    try {
      transaction(() => commitImage(req.device.id, image));
    } catch (e) {
      await deleteFiles(image, all<ImageAsset>("images", req.device.id));
      throw e;
    }
    event(req.device.id, "images", [image.id]);
    res.status(201).json(image);
  });
  app.get("/api/images/:id/file", (req, res) => {
    const image = owned<ImageAsset>(req, "images");
    if (req.query.download) res.attachment(path.basename(image.path));
    res.sendFile(image.path);
  });
  app.get("/api/images/:id/thumbnail", (req, res) =>
    res.sendFile(owned<ImageAsset>(req, "images").thumbnailPath),
  );
  app.patch("/api/images/:id", async (req, res) => {
    const old = owned<ImageAsset>(req, "images");
    const patch = z
      .object({
        rating: z.number().int().min(0).max(5).optional(),
        favorite: z.boolean().optional(),
        discarded: z.boolean().optional(),
      })
      .parse(req.body);
    const image = { ...old, ...patch };
    await updateSidecar(image);
    put("images", req.device.id, image, {
      project_id: image.projectId,
      sha: image.sha,
    });
    res.json(image);
  });
  app.post("/api/images/gc", async (req, res) => {
    const items = all<ImageAsset>("images", req.device.id);
    const tasks = taskList(req.device.id);
    let count = 0;
    for (const image of items.filter(
      (i) =>
        i.discarded &&
        (!req.body.projectId || i.projectId === req.body.projectId),
    )) {
      if (
        tasks.some(
          (t) =>
            ["queued", "running"].includes(t.status) &&
            (t.params.referenceId === image.id || t.params.maskId === image.id),
        )
      )
        continue;
      const remaining = all<ImageAsset>("images", req.device.id).filter(
        (i) => i.id !== image.id,
      );
      await deleteFiles(image, remaining);
      remove("images", image.id, req.device.id);
      count++;
    }
    event(req.device.id, "images", {});
    res.json({ deleted: count });
  });
  app.get("/api/costs", (req, res) => {
    const tasks = taskList(req.device.id);
    const charges = db
      .prepare(
        "SELECT * FROM charges WHERE device_id=? ORDER BY created_at DESC",
      )
      .all(req.device.id);
    const currencies = [
      ...new Set([
        ...tasks.map((t) => t.currency),
        ...charges.map((c) => String(c.currency)),
      ]),
    ];
    res.json({
      totals: Object.fromEntries(
        currencies.map((c) => [c, costUsage(req.device.id, c)]),
      ),
      tasks,
      charges,
    });
  });
  app.get("/api/costs/export", (req, res) => {
    const csv = (v: unknown) => '"' + String(v ?? "").replace(/"/g, '""') + '"';
    const rows = [
      [
        "id",
        "kind",
        "model",
        "batch",
        "status",
        "cost",
        "currency",
        "source",
        "created_at",
      ],
    ];
    for (const t of taskList(req.device.id))
      rows.push([
        t.id,
        "image",
        t.modelName,
        t.batchId,
        t.status,
        String(
          t.status === "succeeded" ? (t.actualCost ?? t.estimatedCost) : 0,
        ),
        t.currency,
        t.costSource,
        new Date(t.createdAt).toISOString(),
      ]);
    for (const c of db
      .prepare("SELECT * FROM charges WHERE device_id=?")
      .all(req.device.id))
      rows.push([
        String(c.id),
        String(c.kind),
        String(c.model_id),
        "",
        "",
        String(c.amount),
        String(c.currency),
        String(c.source),
        new Date(Number(c.created_at)).toISOString(),
      ]);
    res
      .set("Content-Type", "text/csv; charset=utf-8")
      .attachment("workbench-costs.csv")
      .send("\uFEFF" + rows.map((r) => r.map(csv).join(",")).join("\r\n"));
  });
  app.post("/api/demo", async (req, res) => {
    let p = all<Provider>("providers", req.device.id).find(
      (p) => p.adapter === "demo",
    );
    if (!p) {
      p = {
        id: uid(),
        name: "本地演示",
        baseUrl: "http://localhost",
        adapter: "demo",
        apiKey: "",
        proxyUrl: "",
        concurrency: 4,
        adaptiveLimit: 4,
        cooldownUntil: 0,
        createdAt: now(),
      };
      put("providers", req.device.id, p);
      for (const name of ["demo-image", "demo-chat"]) {
        const m = defaultModel(p.id, name, "demo");
        m.verified = { text2image: true, image2image: true };
        if (name === "demo-chat") m.capabilities = ["chat", "vision"];
        put("models", req.device.id, m, { provider_id: p.id });
      }
    }
    db.prepare("UPDATE devices SET active_provider_id=? WHERE id=?").run(
      p.id,
      req.device.id,
    );
    res.json(config(req));
  });
  app.all(
    /^\/api\/proxy\/(models|images\/generations|images\/edits|chat\/completions)$/,
    async (req, res) => {
      const route = String(req.params[0]);
      if (
        (route === "models" && req.method !== "GET") ||
        (route !== "models" && req.method !== "POST")
      )
        throw new ApiError(405, "请求方法不支持");
      const p = provider(req, req.get("X-Provider-Id"));
      if (p.adapter === "demo")
        throw new ApiError(400, "演示供应商不提供原始转发");
      const jsonBody = req.is("application/json")
        ? JSON.parse(req.body.toString("utf8") || "{}")
        : undefined;
      if (p.adapter !== "openai" && route.startsWith("images/"))
        throw new ApiError(
          400,
          "原生供应商的图像请求请使用 /api/tasks 统一适配",
        );
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(new Error("代理请求超时")),
        600000,
      );
      res.on("close", () => {
        if (!res.writableEnded) controller.abort();
      });
      if (route === "models") {
        try {
          res.json({
            data: (await discover(p, controller.signal)).map((name) => ({
              id: name,
              object: "model",
            })),
          });
        } finally {
          clearTimeout(timer);
        }
        return;
      }
      const proxyId = uid();
      let chargeId: string | undefined;
      try {
        const fields: Record<string, unknown> = jsonBody || {};
        if (req.is("multipart/form-data")) {
          const form = await new globalThis.Request("http://localhost", {
            method: "POST",
            headers: { "Content-Type": req.get("content-type")! },
            body: new Uint8Array(req.body),
          }).formData();
          for (const key of ["model", "size", "quality", "n"])
            fields[key] = form.get(key);
        }
        const model = all<Model>("models", req.device.id).find(
          (m) => m.providerId === p.id && m.name === fields.model,
        );
        if (!model)
          throw new ApiError(
            400,
            "请先在模型管理中添加此模型并配置价格，代理才能预占预算",
          );
        const amount = route.startsWith("images/")
          ? imagePrice(model.price, {
              size: String(fields.size || "1024x1024"),
              quality: String(fields.quality || "auto"),
            }) * Math.max(1, Number(fields.n) || 1)
          : chatEstimate(model, fields);
        chargeId = reserveCharge(req.device.id, model, amount, "proxy");
        transaction(() => {
          db.prepare("DELETE FROM proxy_leases WHERE expires<?").run(now());
          const count = db
            .prepare(
              "SELECT COUNT(*) AS n FROM proxy_leases WHERE provider_id=?",
            )
            .get(p.id) as { n: number };
          const jobs = db
            .prepare(
              "SELECT COUNT(*) AS n FROM tasks WHERE provider_id=? AND status='running'",
            )
            .get(p.id) as { n: number };
          if (count.n + jobs.n >= Math.min(p.concurrency, p.adaptiveLimit))
            throw new ApiError(429, "代理并发已满，请稍后重试", 1000);
          db.prepare("INSERT INTO proxy_leases VALUES(?,?,?)").run(
            proxyId,
            p.id,
            now() + 610000,
          );
        });
        const adapted =
          route === "chat/completions" && jsonBody
            ? chatRequest(p, jsonBody)
            : { route: "/" + route, body: undefined };
        let response;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            response = await upstream(p, adapted.route, {
              method: req.method,
              body: adapted.body ? JSON.stringify(adapted.body) : req.body,
              contentType: adapted.body
                ? "application/json"
                : req.get("content-type"),
              signal: controller.signal,
              idempotencyKey: proxyId,
            });
            break;
          } catch (e) {
            if (
              !(e instanceof ApiError) ||
              !(e.status === 429 || e.status >= 500) ||
              attempt === 2
            )
              throw e;
            if (e.status >= 500) {
              chargeId = undefined;
              chargeId = reserveCharge(
                req.device.id,
                model,
                amount,
                "proxy-uncertain-retry",
              );
            }
            await new Promise((r) =>
              setTimeout(r, Math.max(e.retryAfter, 1000 * 2 ** attempt)),
            );
          }
        }
        if (!response) throw new ApiError(502, "上游未返回响应");
        res.status(response.status).set({
          "Content-Type":
            response.headers.get("content-type") || "application/json",
          "Cache-Control": "no-cache",
          "X-Accel-Buffering": "no",
          "X-Provider-Format": p.adapter,
        });
        if (response.headers.get("content-type")?.includes("event-stream")) {
          // 保留原始 SSE 字节，只旁路解析计费字段；没有 usage 时保留预估。
          let pending = "";
          const decoder = new TextDecoder();
          let usage: Record<string, unknown> = {};
          if (response.body)
            for await (const chunk of response.body) {
              if (controller.signal.aborted) break;
              res.write(Buffer.from(chunk));
              pending += decoder.decode(chunk, { stream: true });
              const lines = pending.split("\n");
              pending = lines.pop() || "";
              for (const line of lines) {
                if (!line.startsWith("data:")) continue;
                try {
                  const value = JSON.parse(line.slice(5));
                  usage = {
                    ...usage,
                    ...value.message?.usage,
                    ...value.usage,
                    ...value.usageMetadata,
                  };
                  settleCharge(chargeId, model, { ...value, usage }, amount);
                } catch {}
              }
            }
        } else {
          const bytes = Buffer.from(await response.arrayBuffer());
          try {
            settleCharge(chargeId, model, JSON.parse(bytes.toString()), amount);
          } catch {}
          res.write(bytes);
        }
        res.end();
      } catch (e) {
        if (chargeId && e instanceof ApiError && e.status < 500)
          db.prepare("DELETE FROM charges WHERE id=?").run(chargeId);
        if (!res.headersSent) throw e;
        res.end();
      } finally {
        clearTimeout(timer);
        db.prepare("DELETE FROM proxy_leases WHERE id=?").run(proxyId);
      }
    },
  );
  app.use("/api", (_req, res) => res.status(404).json({ error: "API 不存在" }));
  app.use((error: Error, req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    const status =
      error instanceof ApiError
        ? error.status
        : error instanceof z.ZodError || error instanceof SyntaxError
          ? 400
          : error instanceof multer.MulterError
            ? 413
            : 500;
    const message =
      error instanceof z.ZodError
        ? error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; ")
        : error.message;
    res.status(status).json({ error: message || "服务器错误" });
  });
  return app;
}
function reserveCharge(
  deviceId: string,
  model: Model,
  amount: number,
  kind: string,
) {
  return transaction(() => {
    if (!Number.isFinite(amount) || amount < 0)
      throw new ApiError(400, "费用参数无效");
    const cap = settings(deviceId).totalBudgets[model.price.currency];
    if (
      cap !== undefined &&
      costUsage(deviceId, model.price.currency).total + amount > cap
    )
      throw new ApiError(402, "总预算不足");
    const id = uid();
    db.prepare("INSERT INTO charges VALUES(?,?,?,?,?,?,?,?,?)").run(
      id,
      deviceId,
      model.id,
      kind,
      amount,
      model.price.currency,
      "estimate",
      now(),
      "{}",
    );
    return id;
  });
}
function chatEstimate(model: Model, body: Record<string, unknown>) {
  let imageCount = 0;
  const content = JSON.stringify(body.messages || [], (_key, value) => {
    if (typeof value === "string" && value.startsWith("data:image/")) {
      imageCount++;
      return "[参考图]";
    }
    return value;
  });
  return (
    (model.price.unit * (Math.ceil(content.length / 2) + imageCount * 1500) +
      model.price.outputUnit *
        Math.max(
          1,
          Number(body.max_tokens || body.max_completion_tokens) || 2048,
        )) /
    1e6
  );
}
function settleCharge(id: string, model: Model, value: any, fallback: number) {
  const raw = value.actual_cost ?? value.cost ?? value.usage?.cost;
  const actual =
    typeof raw === "number" && Number.isFinite(raw) && raw >= 0
      ? raw
      : undefined;
  const usage = value.usage || value.usageMetadata || {};
  const input =
    Number(
      usage.prompt_tokens ?? usage.input_tokens ?? usage.promptTokenCount,
    ) || 0;
  const output =
    Number(
      usage.completion_tokens ??
        usage.output_tokens ??
        usage.candidatesTokenCount,
    ) || 0;
  const amount =
    actual ??
    (model.price.type === "token" && (input || output)
      ? (input * model.price.unit + output * model.price.outputUnit) / 1e6
      : fallback);
  db.prepare("UPDATE charges SET amount=?,source=?,data=? WHERE id=?").run(
    amount,
    actual !== undefined ? "provider" : "estimate",
    JSON.stringify({ inputTokens: input, outputTokens: output }),
    id,
  );
  return amount;
}
async function billedChat(
  deviceId: string,
  model: Model,
  p: Provider,
  body: Record<string, unknown>,
  signal: AbortSignal,
  kind = "chat",
) {
  const amount = chatEstimate(model, body);
  const id = reserveCharge(deviceId, model, amount, kind);
  try {
    const answer = await chat(p, body, signal);
    const settledCost = settleCharge(
      id,
      model,
      {
        cost: answer.cost,
        usage: {
          input_tokens: answer.inputTokens,
          output_tokens: answer.outputTokens,
        },
      },
      amount,
    );
    return { ...answer, settledCost };
  } catch (e) {
    if (e instanceof ApiError && e.status < 500)
      db.prepare("DELETE FROM charges WHERE id=?").run(id);
    throw e;
  }
}
