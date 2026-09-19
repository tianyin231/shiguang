import {
  db,
  all,
  get,
  put,
  transaction,
  uid,
  now,
  event,
  settings,
} from "./db";
import { generate, ApiError } from "./providers";
import { saveImage, deleteFiles, commitImage } from "./storage";
import { injectMemory } from "./memory";
import {
  drawingFields,
  imageParameters,
  promptWithNegative,
} from "../shared/drawing";
import type {
  Task,
  Provider,
  Model,
  ImageAsset,
  GenerateInput,
  Estimate,
  GenerationParams,
  Price,
  Session,
} from "../shared/types";

interface TaskRow {
  id: string;
  device_id: string;
  provider_id: string;
  model_id: string;
  status: Task["status"];
  data: string;
  owner: string | null;
  cancel_requested: number;
  lease_until: number;
}
export function taskList(deviceId: string): Task[] {
  return (
    db
      .prepare(
        "SELECT data FROM tasks WHERE device_id=? ORDER BY created_at DESC",
      )
      .all(deviceId) as { data: string }[]
  ).map((r) => JSON.parse(r.data));
}
export function taskRow(id: string, deviceId?: string) {
  return db
    .prepare(
      `SELECT * FROM tasks WHERE id=?${deviceId ? " AND device_id=?" : ""}`,
    )
    .get(...(deviceId ? [id, deviceId] : [id])) as unknown as
    TaskRow | undefined;
}
export function writeTask(task: Task, deviceId: string) {
  task.updatedAt = now();
  db.prepare(
    "UPDATE tasks SET status=?,priority=?,updated_at=?,data=? WHERE id=?",
  ).run(
    task.status,
    task.priority,
    task.updatedAt,
    JSON.stringify(task),
    task.id,
  );
  event(deviceId, "task", task);
}
function log(t: Task, text: string) {
  t.logs.push({ at: now(), text });
  t.logs = t.logs.slice(-50);
}
function retainUncertainCost(task: Task, deviceId: string) {
  if (!task.uncertainCharge) return;
  db.prepare("INSERT INTO charges VALUES(?,?,?,?,?,?,?,?,?)").run(
    uid(),
    deviceId,
    task.modelId,
    "uncertain",
    task.reservation,
    task.currency,
    task.actualCost !== null ? "provider" : "estimate",
    now(),
    JSON.stringify({
      taskId: task.id,
      note: "中断请求的费用记录，未知扣费按估算保留，请核对供应商",
    }),
  );
  task.uncertainCharge = false;
  task.actualCost = null;
  task.costSource = "estimate";
}
export function imagePrice(price: Price, params: GenerationParams) {
  const [w, h] = params.size.split("x").map(Number);
  const factor =
    price.type === "megapixel"
      ? (params.imageSize
          ? (parseInt(params.imageSize) * 1024) ** 2
          : (w || 1024) * (h || 1024)) / 1e6
      : 1;
  return price.type === "token"
    ? (price.unit / 1e6) * 1500 + (price.outputUnit / 1e6) * 4000
    : price.unit * factor * (price.qualityMultiplier[params.quality] ?? 1);
}
export function costUsage(deviceId: string, currency: string) {
  const tasks = taskList(deviceId).filter((t) => t.currency === currency);
  const settled = tasks
    .filter((t) => t.status === "succeeded")
    .reduce((n, t) => n + (t.actualCost ?? t.estimatedCost), 0);
  const reserved = tasks
    .filter(
      (t) => ["queued", "running"].includes(t.status) || t.uncertainCharge,
    )
    .reduce((n, t) => n + t.reservation, 0);
  const row = db
    .prepare(
      "SELECT COALESCE(SUM(amount),0) AS n FROM charges WHERE device_id=? AND currency=?",
    )
    .get(deviceId, currency) as { n: number };
  return {
    settled: settled + row.n,
    reserved,
    total: settled + row.n + reserved,
  };
}
function plans(deviceId: string, input: GenerateInput) {
  if (!get("projects", input.projectId, deviceId))
    throw new ApiError(404, "项目不存在");
  const session = get<Session>("sessions", input.sessionId, deviceId);
  if (!session || session.projectId !== input.projectId)
    throw new ApiError(400, "会话不属于当前项目");
  const ref = input.referenceId
    ? get<ImageAsset>("images", input.referenceId, deviceId)
    : undefined;
  if (input.referenceId && !ref) throw new ApiError(404, "参考图不存在");
  if (input.maskId && !get("images", input.maskId, deviceId))
    throw new ApiError(404, "遮罩不存在");
  const variants = input.variants.length ? input.variants : [input.prompt];
  const total =
    input.modelIds.length *
    input.sizes.length *
    input.qualities.length *
    variants.length *
    input.count;
  if (total > 128) throw new ApiError(400, "每批最多 128 个任务，请减少组合");
  const result: {
    model: Model;
    prompt: string;
    params: GenerationParams;
    cost: number;
    fallback: boolean;
  }[] = [];
  for (const modelId of input.modelIds) {
    const model = get<Model>("models", modelId, deviceId);
    if (!model) throw new ApiError(404, "模型不存在");
    const provider = get<Provider>("providers", model.providerId, deviceId)!;
    const supported = imageParameters(model);
    for (const field of drawingFields) {
      if (field.key === "negativePrompt") continue;
      if (input[field.key] !== undefined && !supported.includes(field.api))
        throw new ApiError(
          400,
          `${model.name} 未启用${field.label}，请在模型能力设置中确认支持后开启`,
        );
    }
    if (
      provider.adapter === "gemini" &&
      (Object.keys(input.extraParams || {}).length ||
        drawingFields.some(
          (f) =>
            !["negativePrompt", "imageSize"].includes(f.key) &&
            input[f.key] !== undefined,
        ))
    )
      throw new ApiError(
        400,
        "Gemini 原生生图支持比例和分辨率档位；其他供应商参数请使用兼容适配器",
      );
    if (provider.adapter === "anthropic")
      throw new ApiError(400, "Anthropic 原生模型不能生图，请选择图像模型");
    const edit =
      !!ref &&
      model.capabilities.includes("image2image") &&
      model.verified.image2image !== false;
    if (!edit && !model.capabilities.includes("text2image"))
      throw new ApiError(400, `${model.name} 未标记文生图能力`);
    if (ref && !edit && !input.allowFallback)
      throw new ApiError(
        400,
        `${model.name} 不支持图生图，请明确启用文本降级或更换模型`,
      );
    if (
      input.maskId &&
      (!edit ||
        !model.capabilities.includes("mask") ||
        provider.adapter === "gemini")
    )
      throw new ApiError(400, "此模型或适配器不支持遮罩局部重绘");
    for (const prompt of variants)
      for (const size of input.sizes)
        for (const quality of input.qualities)
          for (let n = 0; n < input.count; n++) {
            const params: GenerationParams = {
              size,
              quality,
              negativePrompt: input.negativePrompt?.trim() || undefined,
              seedMode: input.seedMode || "increment",
              background: input.background,
              inputFidelity: edit ? input.inputFidelity : undefined,
              steps: input.steps,
              cfgScale: input.cfgScale,
              sampler: input.sampler,
              strength: edit ? input.strength : undefined,
              imageSize: input.imageSize,
              extraParams: input.extraParams,
              ...(input.seed !== undefined
                ? {
                    seed:
                      input.seed +
                      (input.seedMode === "fixed" ? 0 : result.length),
                  }
                : {}),
              referenceId: edit ? ref?.id : undefined,
              maskId: input.maskId,
            };
            result.push({
              model,
              prompt,
              params,
              cost: imagePrice(model.price, params),
              fallback: !!ref && !edit,
            });
          }
  }
  return result;
}
export function estimate(deviceId: string, input: GenerateInput): Estimate {
  const tasks = plans(deviceId, input);
  const totals: Record<string, number> = {};
  const warnings = new Set<string>();
  for (const item of tasks) {
    totals[item.model.price.currency] =
      (totals[item.model.price.currency] || 0) + item.cost;
    if (
      !item.model.price.unit &&
      get<Provider>("providers", item.model.providerId)?.adapter !== "demo"
    )
      warnings.add(`${item.model.name} 尚未填写价格，费用暂按 0 估算`);
    if (item.fallback)
      warnings.add(
        `${item.model.name} 将根据参考图元数据重新文生图，不会上传参考图`,
      );
    if (input.seed !== undefined && !item.model.supportsSeed)
      warnings.add(`${item.model.name} 未启用 seed 支持，seed 不发送给供应商`);
    if (
      input.negativePrompt?.trim() &&
      (get<Provider>("providers", item.model.providerId)?.adapter ===
        "gemini" ||
        !imageParameters(item.model).includes("negative_prompt"))
    )
      warnings.add(`${item.model.name} 的负面提示词将作为文字约束附在提示词中`);
    if (
      item.params.size !== "auto" &&
      !item.model.sizes.includes(item.params.size)
    )
      warnings.add(
        `${item.model.name} 的 ${item.params.size} 未登记为支持尺寸，请以供应商实际支持为准`,
      );
    if (
      item.params.quality !== "auto" &&
      !item.model.qualities.includes(item.params.quality)
    )
      warnings.add(
        `${item.model.name} 的 ${item.params.quality} 未登记为支持画质，请以供应商实际支持为准`,
      );
    if (
      item.params.quality !== "auto" &&
      item.model.price.qualityMultiplier[item.params.quality] === undefined
    )
      warnings.add(
        `${item.model.name} 尚未设置 ${item.params.quality} 的价格倍率，当前沿用基础单价，可在模型页调整`,
      );
    if (item.params.imageSize)
      warnings.add(
        `${item.model.name} 使用原生 ${item.params.imageSize} 档位，像素尺寸只用于推算比例；按像素计费时面积为粗估`,
      );
    if (
      get<Provider>("providers", item.model.providerId)?.adapter === "gemini" &&
      item.params.quality !== "auto"
    )
      warnings.add(
        `${item.model.name} 使用 Gemini 原生协议，不发送 quality，请使用原生分辨率档位`,
      );
  }
  return {
    count: tasks.length,
    totals,
    warnings: [...warnings],
    items: tasks.map((t) => ({
      modelId: t.model.id,
      amount: t.cost,
      currency: t.model.price.currency,
    })),
  };
}
export function enqueue(deviceId: string, input: GenerateInput): Task[] {
  return transaction(() => {
    const cached = db
      .prepare("SELECT data FROM requests WHERE device_id=? AND key=?")
      .get(deviceId, input.idempotencyKey) as { data: string } | undefined;
    if (cached)
      return JSON.parse(cached.data).map((id: string) =>
        JSON.parse(taskRow(id, deviceId)!.data),
      );
    const items = plans(deviceId, input);
    const costs = estimate(deviceId, input);
    const config = settings(deviceId);
    if (
      input.taskBudget !== undefined &&
      items.some((t) => t.cost > input.taskBudget!)
    )
      throw new ApiError(402, "单次预算不足，任务未提交");
    // 不对不同币种作隐式汇率换算，各币种分别判断。
    for (const [currency, amount] of Object.entries(costs.totals)) {
      if (input.batchBudget !== undefined && amount > input.batchBudget)
        throw new ApiError(402, `${currency} 批次预算不足，任务未提交`);
      const cap = config.totalBudgets[currency];
      if (
        cap !== undefined &&
        costUsage(deviceId, currency).total + amount > cap
      )
        throw new ApiError(
          402,
          `${currency} 总预算不足（含正在执行的预占费用）`,
        );
    }
    const batchId = uid();
    const tasks: Task[] = items.map((item) => {
      const memory = injectMemory(
        deviceId,
        input.projectId,
        input.sessionId,
        item.prompt,
        input.referenceId,
      );
      const t: Task = {
        id: uid(),
        projectId: input.projectId,
        sessionId: input.sessionId,
        providerId: item.model.providerId,
        modelId: item.model.id,
        modelName: item.model.name,
        batchId,
        status: "queued",
        priority: input.priority,
        attempts: 0,
        maxRetries: input.retries,
        createdAt: now(),
        updatedAt: now(),
        prompt: item.prompt,
        ...memory,
        effectivePrompt: promptWithNegative(
          memory.effectivePrompt,
          item.params,
          get<Provider>("providers", item.model.providerId)?.adapter ===
            "gemini"
            ? { ...item.model, imageParameters: [] }
            : item.model,
        ),
        params: item.params,
        estimatedCost: item.cost,
        actualCost: null,
        costSource: "estimate",
        currency: item.model.price.currency,
        price: item.model.price,
        timeout: input.timeout,
        concurrency: input.concurrency,
        logs: [],
        imageIds: [],
        parentImageId: input.referenceId,
        fallback: item.fallback,
        reservation: item.cost,
      };
      log(t, item.fallback ? "已排队：根据元数据文本降级生成" : "已排队");
      db.prepare(
        "INSERT INTO tasks(id,device_id,provider_id,model_id,project_id,batch_id,status,priority,available_at,created_at,updated_at,data) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      ).run(
        t.id,
        deviceId,
        t.providerId,
        t.modelId,
        t.projectId,
        batchId,
        t.status,
        t.priority,
        now(),
        t.createdAt,
        t.updatedAt,
        JSON.stringify(t),
      );
      event(deviceId, "task", t);
      return t;
    });
    db.prepare("INSERT INTO requests VALUES(?,?,?)").run(
      deviceId,
      input.idempotencyKey,
      JSON.stringify(tasks.map((t) => t.id)),
    );
    return tasks;
  });
}
export function cancelTask(id: string, deviceId: string) {
  return transaction(() => {
    const row = taskRow(id, deviceId);
    if (!row) throw new ApiError(404, "任务不存在");
    const task: Task = JSON.parse(row.data);
    if (!["queued", "running"].includes(task.status)) return task;
    db.prepare("UPDATE tasks SET cancel_requested=1 WHERE id=?").run(id);
    if (task.status === "queued") {
      retainUncertainCost(task, deviceId);
      task.status = "cancelled";
      task.reservation = 0;
    } else {
      log(task, "已请求取消，正在终止连接");
    }
    writeTask(task, deviceId);
    return task;
  });
}
export function retryTask(id: string, deviceId: string) {
  return transaction(() => {
    const row = taskRow(id, deviceId);
    if (!row) throw new ApiError(404, "任务不存在");
    const task: Task = JSON.parse(row.data);
    if (!["dead", "failed", "cancelled"].includes(task.status))
      throw new ApiError(409, "只能重试已结束的失败或取消任务");
    const cap = settings(deviceId).totalBudgets[task.currency];
    if (
      cap !== undefined &&
      costUsage(deviceId, task.currency).total + task.estimatedCost > cap
    )
      throw new ApiError(402, "总预算不足，无法重试");
    retainUncertainCost(task, deviceId);
    task.status = "queued";
    task.attempts = 0;
    task.error = undefined;
    task.uncertainCharge = false;
    task.reservation = task.estimatedCost;
    log(task, "用户重新入队");
    db.prepare(
      "UPDATE tasks SET cancel_requested=0,available_at=?,owner=NULL,lease_until=0 WHERE id=?",
    ).run(now(), id);
    writeTask(task, deviceId);
    return task;
  });
}

export function startWorker() {
  const owner = uid();
  const controllers = new Map<string, AbortController>();
  let stopped = false;
  let ticking = false;
  const max = Math.max(1, Number(process.env.WORKER_CONCURRENCY) || 6);
  function claim(): TaskRow | undefined {
    return transaction(() => {
      const expired = db
        .prepare("SELECT * FROM tasks WHERE status='running' AND lease_until<?")
        .all(now()) as unknown as TaskRow[];
      for (const row of expired) {
        const t: Task = JSON.parse(row.data);
        t.uncertainCharge = true;
        log(t, "上次 worker 租约失效；请求可能已计费");
        if (row.cancel_requested) {
          t.status = "cancelled";
        } else if (t.attempts <= t.maxRetries) {
          t.status = "queued";
        } else {
          t.status = "dead";
          t.error = "进程中断后已耗尽恢复重试次数";
        }
        db.prepare(
          "UPDATE tasks SET owner=NULL,lease_until=0,available_at=? WHERE id=?",
        ).run(now(), t.id);
        writeTask(t, row.device_id);
      }
      const candidates = db
        .prepare(
          "SELECT * FROM tasks WHERE status='queued' AND cancel_requested=0 AND available_at<=? ORDER BY priority DESC,created_at LIMIT 128",
        )
        .all(now()) as unknown as TaskRow[];
      for (const row of candidates) {
        const t: Task = JSON.parse(row.data);
        const p = get<Provider>("providers", row.provider_id);
        const model = get<Model>("models", row.model_id);
        if (!p || !model) continue;
        if (p.cooldownUntil > now()) continue;
        const running = db
          .prepare(
            "SELECT data FROM tasks WHERE status='running' AND provider_id=?",
          )
          .all(row.provider_id) as { data: string }[];
        const active = running.map((r) => JSON.parse(r.data) as Task);
        const proxyCount = (
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM proxy_leases WHERE provider_id=? AND expires>?",
            )
            .get(p.id, now()) as { n: number }
        ).n;
        if (
          active.length + proxyCount >=
            Math.min(p.concurrency, p.adaptiveLimit) ||
          active.filter((a) => a.modelId === t.modelId).length >=
            model.maxConcurrency ||
          (
            db
              .prepare(
                "SELECT COUNT(*) AS n FROM tasks WHERE batch_id=? AND status='running'",
              )
              .get(t.batchId) as { n: number }
          ).n >= t.concurrency
        )
          continue;
        if (t.uncertainCharge) {
          retainUncertainCost(t, row.device_id);
          t.reservation = t.estimatedCost;
          writeTask(t, row.device_id);
        }
        const cap = settings(row.device_id).totalBudgets[t.currency];
        if (
          cap !== undefined &&
          costUsage(row.device_id, t.currency).total > cap
        ) {
          t.status = "failed";
          t.error = "实际费用变化导致总预算超限，已熔断后续任务";
          t.reservation = 0;
          writeTask(t, row.device_id);
          continue;
        }
        t.status = "running";
        t.attempts++;
        t.error = undefined;
        log(t, `开始执行，第 ${t.attempts} 次请求`);
        db.prepare("UPDATE tasks SET owner=?,lease_until=? WHERE id=?").run(
          owner,
          now() + 30000,
          t.id,
        );
        writeTask(t, row.device_id);
        return { ...row, owner, data: JSON.stringify(t) };
      }
    });
  }
  async function execute(row: TaskRow) {
    let t: Task = JSON.parse(row.data);
    const p = get<Provider>("providers", row.provider_id)!;
    const model = get<Model>("models", row.model_id)!;
    const controller = new AbortController();
    controllers.set(t.id, controller);
    const begin = now();
    let assets: ImageAsset[] = [];
    let upstreamCompleted = false;
    const timeout = setTimeout(
      () => controller.abort(new Error("请求超时")),
      t.timeout * 1000,
    );
    const heartbeat = setInterval(() => {
      const latest = taskRow(t.id);
      if (latest?.owner !== owner) {
        controller.abort(new Error("任务租约已转移"));
        return;
      }
      if (latest.cancel_requested) controller.abort(new Error("任务已取消"));
      db.prepare("UPDATE tasks SET lease_until=? WHERE id=? AND owner=?").run(
        now() + 30000,
        t.id,
        owner,
      );
    }, 1000);
    try {
      const reference = t.params.referenceId
        ? get<ImageAsset>("images", t.params.referenceId, row.device_id)
        : undefined;
      const mask = t.params.maskId
        ? get<ImageAsset>("images", t.params.maskId, row.device_id)
        : undefined;
      const result = await generate(
        p,
        model,
        t.effectivePrompt,
        t.params,
        reference?.path,
        mask?.path,
        controller.signal,
        t.id,
      );
      upstreamCompleted = true;
      if (result.actualCost !== undefined) {
        t.actualCost = result.actualCost;
        t.costSource = "provider";
      } else if (t.price.type === "token")
        t.estimatedCost =
          ((result.inputTokens || 0) * t.price.unit +
            (result.outputTokens || 0) * t.price.outputUnit) /
            1e6 || t.estimatedCost;
      for (const buffer of result.buffers)
        assets.push(
          await saveImage(row.device_id, buffer, {
            ...t,
            actualCost:
              t.actualCost !== null
                ? t.actualCost / result.buffers.length
                : null,
            estimatedCost: t.estimatedCost / result.buffers.length,
          }),
        );
      transaction(() => {
        const current = taskRow(t.id);
        if (current?.owner !== owner) throw new Error("任务租约已转移");
        t.status = "succeeded";
        t.elapsedMs = now() - begin;
        t.imageIds = assets.map((a) => a.id);
        t.reservation = 0;
        t.uncertainCharge = false;
        for (const asset of assets) commitImage(row.device_id, asset);
        log(
          t,
          current.cancel_requested
            ? "取消前供应商已完成，已保存图片及费用"
            : "图片、缩略图和元数据已保存",
        );
        writeTask(t, row.device_id);
        event(row.device_id, "images", t.imageIds);
        const currentProvider = get<Provider>("providers", p.id)!;
        if (now() > currentProvider.cooldownUntil)
          currentProvider.adaptiveLimit = Math.min(
            currentProvider.concurrency,
            currentProvider.adaptiveLimit + 1,
          );
        put("providers", row.device_id, currentProvider);
        const latestModel = get<Model>("models", model.id)!;
        latestModel.verified[
          t.params.referenceId ? "image2image" : "text2image"
        ] = true;
        latestModel.probeAt = now();
        put("models", row.device_id, latestModel, { provider_id: p.id });
      });
    } catch (error) {
      const current = taskRow(t.id);
      if (current?.owner === owner) {
        const e = error as Error;
        const cancelled = !!current.cancel_requested;
        const retryable =
          (error instanceof ApiError &&
            (error.status === 429 || error.status >= 500)) ||
          (!(error instanceof ApiError) && !cancelled);
        const status = error instanceof ApiError ? error.status : 0;
        t.uncertainCharge = upstreamCompleted || status === 0 || status >= 500;
        t.elapsedMs = now() - begin;
        t.error = e.message || "网络请求失败";
        if (t.uncertainCharge && t.actualCost !== null)
          t.reservation = t.actualCost;
        if (cancelled) t.status = "cancelled";
        else if (
          retryable &&
          t.attempts <= t.maxRetries &&
          !upstreamCompleted
        ) {
          t.status = "queued";
          const delay = Math.max(
            Math.min(60000, 1000 * 2 ** t.attempts),
            error instanceof ApiError ? error.retryAfter : 0,
          );
          db.prepare("UPDATE tasks SET available_at=? WHERE id=?").run(
            now() + delay,
            t.id,
          );
          log(t, `${t.error}；${Math.ceil(delay / 1000)} 秒后重试`);
        } else {
          t.status = retryable ? "dead" : "failed";
          log(t, t.error);
        }
        if (!t.uncertainCharge && t.status !== "queued") t.reservation = 0;
        if (status === 429) {
          const latest = get<Provider>("providers", p.id)!;
          latest.adaptiveLimit = Math.max(
            1,
            Math.floor(latest.adaptiveLimit / 2),
          );
          latest.cooldownUntil =
            now() + Math.max(3000, (error as ApiError).retryAfter);
          put("providers", row.device_id, latest);
        }
        if ([404, 405].includes(status) && t.params.referenceId) {
          const latest = get<Model>("models", model.id)!;
          latest.verified.image2image = false;
          latest.probeError = t.error;
          latest.probeAt = now();
          put("models", row.device_id, latest, { provider_id: p.id });
        }
        writeTask(t, row.device_id);
      }
      const remaining = all<ImageAsset>("images", row.device_id);
      for (const asset of assets)
        if (!remaining.some((a) => a.id === asset.id))
          await deleteFiles(asset, remaining).catch(() => {});
    } finally {
      clearInterval(heartbeat);
      clearTimeout(timeout);
      controllers.delete(t.id);
      db.prepare(
        "UPDATE tasks SET owner=NULL,lease_until=0 WHERE id=? AND owner=?",
      ).run(t.id, owner);
    }
  }
  function tick() {
    if (stopped || ticking) return;
    ticking = true;
    try {
      while (controllers.size < max) {
        const row = claim();
        if (!row) break;
        void execute(row);
      }
    } catch (e) {
      console.error("worker:", (e as Error).message);
    } finally {
      ticking = false;
    }
  }
  const timer = setInterval(tick, 300);
  tick();
  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      for (const c of controllers.values())
        c.abort(new Error("worker 正在关闭"));
      while (controllers.size) await new Promise((r) => setTimeout(r, 50));
    },
    tick,
  };
}
