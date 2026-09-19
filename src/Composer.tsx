import { useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  ImagePlus,
  SlidersHorizontal,
  Sparkles,
  ChevronDown,
  Paintbrush,
  MessageCircle,
  Plus,
  LocateFixed,
  ArrowLeft,
  ArrowRight,
  Pencil,
} from "lucide-react";
import { useStore } from "./store";
import { api, post, money } from "./api";
import { Button, Field, Busy, Modal, useAction } from "./components";
import { DrawingControls } from "./DrawingControls";
import { drawingFields, imageParameters } from "../shared/drawing";
import type {
  GenerateInput,
  Estimate,
  ImageAsset,
  Task,
  Session,
  DrawingOptions,
} from "../shared/types";

export function Composer() {
  const s = useStore();
  const [modelIds, setModels] = useState<string[]>([]);
  const [count, setCount] = useState(2);
  const [concurrency, setConcurrency] = useState(2);
  const [retries, setRetries] = useState(1);
  const [timeout, setTimeoutValue] = useState(600);
  const [size, setSize] = useState("1536x864");
  const [quality, setQuality] = useState("auto");
  const [seed, setSeed] = useState("");
  const [drawingOptions, setDrawingOptions] = useState<DrawingOptions>({});
  const [extraParams, setExtraParams] = useState("");
  const [variants, setVariants] = useState("");
  const [extraModels, setExtraModels] = useState(false);
  const [extraSizes, setExtraSizes] = useState("");
  const [extraQualities, setExtraQualities] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [budget, setBudget] = useState("");
  const [taskBudget, setTaskBudget] = useState("");
  const [allowFallback, setFallback] = useState(false);
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [estimateError, setEstimateError] = useState("");
  const [priority, setPriority] = useState(0);
  const [maskOpen, setMaskOpen] = useState(false);
  const [chatModel, setChatModel] = useState("");
  const [mobileOpen, setMobileOpen] = useState(true);
  const [lastBatchId, setLastBatchId] = useState("");
  const [editSettingsOpen, setEditSettingsOpen] = useState(false);
  const [comparison, setComparison] = useState<ImageAsset | null>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const action = useAction();
  const requestId = useRef(crypto.randomUUID());
  const models = s.data.models.filter(
    (m) =>
      m.providerId === s.config?.activeProviderId &&
      (m.capabilities.includes("text2image") ||
        m.capabilities.includes("image2image")),
  );
  const chats = s.data.models.filter((m) => m.capabilities.includes("chat"));
  const selected = models.find((m) => m.id === modelIds[0]);
  const prompt = s.reference ? s.editPrompts[s.reference.id] || "" : s.prompt;
  const negativePrompt = s.reference
    ? (s.editNegativePrompts[s.reference.id] ??
      s.reference.params.negativePrompt ??
      "")
    : s.negativePrompt;
  let parsedExtra: Record<string, unknown> | undefined;
  let extraError = "";
  if (extraParams.trim()) {
    try {
      const value = JSON.parse(extraParams);
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error();
      parsedExtra = value;
    } catch {
      extraError = "供应商扩展参数需要合法的 JSON 对象";
    }
  }
  const provider = s.config?.providers.find(
    (p) => p.id === selected?.providerId,
  );
  const isDemo = provider?.adapter === "demo";
  const batchId =
    lastBatchId ||
    s.data.tasks.find(
      (t) =>
        t.projectId === s.projectId &&
        t.sessionId === s.sessionId &&
        (s.reference ? t.parentImageId === s.reference.id : !t.parentImageId),
    )?.batchId;
  const batchTasks = s.data.tasks.filter(
    (t) =>
      t.projectId === s.projectId &&
      t.batchId === batchId &&
      (s.reference ? t.parentImageId === s.reference.id : !t.parentImageId),
  );
  const batchDone = batchTasks.filter((t) => t.status === "succeeded").length;
  const batchPending = batchTasks.filter(
    (t) => t.status === "queued" || t.status === "running",
  ).length;
  const batchFailed = batchTasks.filter(
    (t) => t.status === "failed" || t.status === "dead",
  ).length;
  const batchImages = s.data.images.filter((i) =>
    batchTasks.some((t) => t.id === i.taskId),
  );
  const batchImage = batchImages[0];
  useEffect(() => {
    setLastBatchId("");
  }, [s.projectId, s.sessionId, s.reference?.id]);
  useEffect(() => {
    if (!s.composerFocus) return;
    setMobileOpen(true);
    const frame = requestAnimationFrame(() => {
      promptRef.current?.focus({ preventScroll: true });
      if (s.reference)
        editorRef.current?.scrollTo({ top: 0, behavior: "smooth" });
      (s.reference ? editorRef.current : promptRef.current)?.scrollIntoView({
        behavior: "smooth",
        block: s.reference ? "start" : "center",
      });
      s.set({ composerFocus: 0 });
    });
    return () => cancelAnimationFrame(frame);
  }, [s.composerFocus]);
  useEffect(() => {
    const first = models.find((m) => m.isDefault) || models[0];
    setModels(first ? [first.id] : []);
  }, [s.config?.activeProviderId, models.map((m) => m.id).join(",")]);
  useEffect(() => {
    if (!s.reference) return;
    const editable = models.filter(
      (m) =>
        m.capabilities.includes("image2image") &&
        m.verified.image2image !== false,
    );
    const originalModelId = s.data.tasks.find(
      (t) => t.id === s.reference?.taskId,
    )?.modelId;
    const preferred =
      editable.find((m) => m.id === originalModelId) ||
      editable.find((m) => m.name === s.reference?.model) ||
      editable.find((m) => m.id === modelIds[0]) ||
      editable[0] ||
      models[0];
    setModels(preferred ? [preferred.id] : []);
    setCount(1);
    const originalSize =
      s.reference.params.size || `${s.reference.width}x${s.reference.height}`;
    setSize(originalSize);
    setQuality(s.reference.params.quality || "auto");
    setSeed("");
    setDrawingOptions({});
    setExtraParams("");
    setAdvanced(false);
    setEditSettingsOpen(false);
    setComparison(null);
    setMaskOpen(false);
  }, [
    s.reference?.id,
    s.config?.activeProviderId,
    models.map((m) => m.id).join(","),
  ]);
  useEffect(() => {
    if (s.config) {
      setConcurrency(s.config.settings.concurrency);
      setRetries(s.config.settings.retries);
      setTimeoutValue(s.config.settings.timeout);
    }
  }, [s.config?.settings]);
  useEffect(() => {
    if (!chats.some((m) => m.id === chatModel))
      setChatModel(chats[0]?.id || "");
  }, [chats.map((m) => m.id).join(",")]);
  useEffect(() => {
    setFallback(false);
  }, [s.reference?.id, modelIds.join(",")]);
  useEffect(() => {
    setDrawingOptions((current) => {
      const next = { ...current };
      for (const field of drawingFields) {
        if (field.key === "negativePrompt") continue;
        if (
          models
            .filter((m) => modelIds.includes(m.id))
            .some((m) => !imageParameters(m).includes(field.api))
        )
          delete next[field.key];
      }
      return next;
    });
  }, [modelIds.join(",")]);
  useEffect(() => {
    const task = s.generationPreset;
    if (!task) return;
    const round = s.data.tasks.filter(
      (t) =>
        t.batchId === task.batchId &&
        t.prompt === task.prompt &&
        t.providerId === task.providerId,
    );
    const roundModels = [...new Set(round.map((t) => t.modelId))];
    setModels(roundModels.length ? roundModels : [task.modelId]);
    setSize(task.params.size);
    setQuality(task.params.quality);
    const seeds = round.flatMap((t) =>
      t.params.seed === undefined ? [] : [t.params.seed],
    );
    setSeed(seeds.length ? String(Math.min(...seeds)) : "");
    const {
      size: _size,
      quality: _quality,
      seed: _seed,
      referenceId: _reference,
      maskId: _mask,
      negativePrompt: _negative,
      extraParams: extra,
      ...drawing
    } = task.params;
    setDrawingOptions(drawing);
    setExtraParams(extra ? JSON.stringify(extra, null, 2) : "");
    setCount(
      s.data.tasks.filter(
        (t) =>
          t.batchId === task.batchId &&
          t.prompt === task.prompt &&
          t.modelId === task.modelId &&
          t.params.size === task.params.size &&
          t.params.quality === task.params.quality,
      ).length || 1,
    );
    setVariants("");
    setExtraSizes(
      [...new Set(round.map((t) => t.params.size))]
        .filter((v) => v !== task.params.size)
        .join(","),
    );
    setExtraQualities(
      [...new Set(round.map((t) => t.params.quality))]
        .filter((v) => v !== task.params.quality)
        .join(","),
    );
    setExtraModels(roundModels.length > 1);
    setConcurrency(task.concurrency);
    setRetries(task.maxRetries);
    setTimeoutValue(task.timeout);
    setPriority(task.priority);
    setEditSettingsOpen(true);
    s.set({ generationPreset: null });
    s.toast("已填入提示词和参数，检查后点击生成");
  }, [s.generationPreset]);
  const input = (): GenerateInput => ({
    ...drawingOptions,
    negativePrompt,
    ...(parsedExtra ? { extraParams: parsedExtra } : {}),
    projectId: s.projectId,
    sessionId: s.sessionId,
    modelIds,
    prompt: prompt.trim() || " ",
    variants: s.reference
      ? []
      : variants
          .split("\n")
          .map((v) => v.trim())
          .filter(Boolean),
    count,
    sizes: [
      size,
      ...(s.reference ? "" : extraSizes)
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean),
    ].filter((v, i, a) => a.indexOf(v) === i),
    qualities: [
      quality,
      ...(s.reference ? "" : extraQualities)
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean),
    ].filter((v, i, a) => a.indexOf(v) === i),
    ...(seed !== "" ? { seed: Number(seed) } : {}),
    concurrency,
    retries,
    timeout,
    priority,
    ...(s.reference ? { referenceId: s.reference.id } : {}),
    ...(s.maskId ? { maskId: s.maskId } : {}),
    ...(budget !== "" ? { batchBudget: Number(budget) } : {}),
    ...(taskBudget !== "" ? { taskBudget: Number(taskBudget) } : {}),
    allowFallback,
    idempotencyKey: requestId.current,
  });
  const serialized = JSON.stringify({ ...input(), idempotencyKey: "estimate" });
  useEffect(() => {
    requestId.current = crypto.randomUUID();
    setEstimate(null);
    setEstimateError("");
    if (!modelIds.length || extraError) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      api<Estimate>("/tasks/estimate", {
        method: "POST",
        body: serialized,
        signal: controller.signal,
      })
        .then(setEstimate)
        .catch((e) => {
          if (!controller.signal.aborted) setEstimateError(e.message);
        });
    }, 350);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [serialized, extraError]);
  const fallbackNeeded =
    !!s.reference &&
    modelIds.some((id) => {
      const m = s.data.models.find((v) => v.id === id);
      return (
        !m?.capabilities.includes("image2image") ||
        m.verified.image2image === false
      );
    });
  const canMask =
    !!s.reference &&
    selected?.capabilities.includes("mask") &&
    !fallbackNeeded &&
    provider?.adapter !== "gemini";
  const blockedReason = !modelIds.length
    ? "先连接供应商，并选择一个可生图的模型"
    : !prompt.trim() && (s.reference || !variants.trim())
      ? s.reference
        ? "写下要修改的内容，例如：保留角色，改成夜景"
        : "先描述想生成的画面，也可以点选画布中的示例"
      : fallbackNeeded && !allowFallback
        ? "此模型无法读取原图，请更换模型，或明确选择仅按文字重画"
        : estimateError || extraError
          ? estimateError || extraError
          : !estimate
            ? "正在估算本轮费用…"
            : "";
  async function upload(file: File) {
    const form = new FormData();
    form.set("image", file);
    form.set("projectId", s.projectId);
    form.set("sessionId", s.sessionId);
    const image = await api<ImageAsset>("/images/upload", {
      method: "POST",
      body: form,
    });
    s.beginEdit(image);
    await s.refresh();
  }
  return (
    <aside
      className={`composer ${mobileOpen ? "open" : "closed"} ${s.reference ? "editing-image" : ""}`}
    >
      <button
        className="composer-mobile-toggle"
        aria-expanded={mobileOpen}
        onClick={() => setMobileOpen(!mobileOpen)}
      >
        {s.reference ? "二次生图 · 修改这张图" : "打开生成面板"}
        <ChevronDown size={18} />
      </button>
      <div className="composer-inner" ref={editorRef}>
        <div className="composer-title">
          <h2>{s.reference ? "修改这张图" : "开始一轮创作"}</h2>
          {s.reference ? (
            <button
              className="text-button edit-exit"
              onClick={() => s.set({ reference: null, maskId: "" })}
            >
              <ArrowLeft size={13} />
              返回文字生图
            </button>
          ) : (
            <span className="pill subtle">从文字生成图片</span>
          )}
        </div>
        {s.reference && (
          <section className="edit-source" aria-label="本轮原图">
            <div className="edit-step-title">
              <strong>1. 本轮修改的原图</strong>
              <span>原图会保留</span>
            </div>
            <div className="edit-source-card">
              <img src={s.reference.thumbnailUrl} alt="本轮修改的原图" />
              <div>
                <strong>{s.reference.model}</strong>
                <small>
                  {s.reference.width} × {s.reference.height}
                </small>
                <button
                  className="text-button"
                  onClick={() => s.set({ page: "gallery" })}
                >
                  从图库换一张
                </button>
                <button
                  className="text-button"
                  onClick={() => uploadRef.current?.click()}
                >
                  上传另一张
                </button>
              </div>
            </div>
            <details className="source-prompt">
              <summary>查看原图提示词</summary>
              <p>{s.reference.prompt || "上传的图片，没有原始提示词。"}</p>
            </details>
          </section>
        )}
        {isDemo && s.reference && (
          <div className="edit-demo-note" role="note">
            <strong>演示模式不会实际修改图片</strong>
            <p>每次返回同一张示例图，只演示操作流程。</p>
            <button
              className="text-button"
              onClick={() => s.set({ page: "settings" })}
            >
              连接自己的模型，实际改图
              <ArrowRight size={13} />
            </button>
          </div>
        )}
        {!s.reference && (
          <>
            <Field label="1. 选择模型">
              <select
                value={modelIds[0] || ""}
                onChange={(e) => setModels([e.target.value])}
              >
                <option value="" disabled>
                  先连接供应商并发现模型
                </option>
                {models.map((m) => (
                  <option value={m.id} key={m.id}>
                    {m.favorite ? "★ " : ""}
                    {m.name}
                  </option>
                ))}
              </select>
            </Field>
            {!models.length && (
              <div className="composer-setup">
                <p>先完成连接，再选择模型开始生成。</p>
                <Button
                  onClick={() =>
                    s.set({
                      page: s.config?.activeProviderId ? "models" : "settings",
                    })
                  }
                >
                  {s.config?.activeProviderId
                    ? "去添加或发现模型"
                    : "去连接供应商"}
                </Button>
              </div>
            )}
            <button
              className="text-button"
              onClick={() => setExtraModels(!extraModels)}
            >
              多模型对比{extraModels ? " −" : " +"}
            </button>
            {extraModels && (
              <div className="model-checks">
                {models.map((m) => (
                  <label key={m.id}>
                    <input
                      type="checkbox"
                      checked={modelIds.includes(m.id)}
                      onChange={(e) =>
                        setModels(
                          e.target.checked
                            ? [...modelIds, m.id]
                            : modelIds.filter((id) => id !== m.id),
                        )
                      }
                    />
                    {m.name}
                  </label>
                ))}
              </div>
            )}
          </>
        )}
        <Field
          label={s.reference ? "2. 写下修改要求" : "2. 描述你想看见的画面"}
          hint={
            s.reference ? "只写要改变的地方，无需重写原图提示词。" : undefined
          }
        >
          <textarea
            ref={promptRef}
            className="prompt-input"
            value={prompt}
            onChange={(e) => s.setPrompt(e.target.value)}
            placeholder={
              s.reference
                ? "例如：保留人物、构图和厚涂风格，把午后改成灯笼亮起的夜晚……"
                : "一间秋日的木质工坊，柔和的暖阳穿过窗棂，厚涂质感，画面安静而清晰……"
            }
          />
        </Field>
        <div className="prompt-foot">
          <span>
            <Sparkles size={12} />
            相关记忆自动加入
          </span>
          <span>{prompt.length} 字</span>
        </div>
        <div className="drawing-chips style-presets" aria-label="风格快捷词">
          <span>加入风格</span>
          {[
            [
              "厚涂 CG",
              "2.5D 游戏 CG 插画，大色块厚涂，干净利落的边缘，明确的光影层次。",
            ],
            [
              "新中式",
              "新中式奇幻，温润木色，克制的装饰，宁静复古的东方氛围。",
            ],
            ["电影感", "电影级构图，清晰的主体，富有层次的自然光影。"],
            ["水彩", "手绘水彩，纸张质感，轻盈通透的色彩。"],
          ].map(([label, text]) => (
            <button
              key={label}
              onClick={() =>
                s.setPrompt([prompt.trim(), text].filter(Boolean).join("\n"))
              }
            >
              {label}
            </button>
          ))}
        </div>
        <Field
          label="负面提示词"
          hint={
            selected &&
            provider?.adapter !== "gemini" &&
            imageParameters(selected).includes("negative_prompt")
              ? isDemo
                ? "演示模式会保存参数，返回固定示例图。"
                : "作为独立负面参数发送给模型。"
              : "当前模型使用文字约束：负面词会附在提示词中一起发送。"
          }
        >
          <textarea
            rows={3}
            value={negativePrompt}
            onChange={(e) => s.setNegativePrompt(e.target.value)}
            placeholder="不希望出现的内容，例如：文字、水印、模糊、杂乱背景…"
          />
        </Field>
        <div
          className="drawing-chips negative-presets"
          aria-label="负面词快捷添加"
        >
          {[
            "文字、水印、Logo",
            "模糊、低清晰度",
            "杂乱背景、过度细节",
            "多余手指、肢体畸形",
          ].map((text) => (
            <button
              key={text}
              onClick={() =>
                s.setNegativePrompt(
                  [
                    ...new Set([
                      ...negativePrompt
                        .split(/[，,、\n]/)
                        .map((v) => v.trim())
                        .filter(Boolean),
                      ...text.split("、"),
                    ]),
                  ].join("、"),
                )
              }
            >
              + {text}
            </button>
          ))}
        </div>
        {s.reference && (
          <div className="iteration-guide">
            <div>
              {[
                [
                  "改成夜景",
                  "保持人物、构图与绘画风格，将环境改成灯笼亮起的温暖夜景。",
                ],
                ["尝试新构图", "保持人物设定、画风与配色，尝试新的画面构图。"],
                [
                  "调整配色",
                  "保持人物与构图，将配色调整为暖橘色、深木色和灰绿色，光影清晰。",
                ],
              ].map(([label, text]) => (
                <button key={label} onClick={() => s.setPrompt(text)}>
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}
        {!s.reference && (
          <button
            className="reference-upload"
            onClick={() => uploadRef.current?.click()}
          >
            <ImagePlus size={19} />
            <span>
              上传图片来修改<small>已有作品？点图片上的“修改这张图”</small>
            </span>
            <Plus size={16} />
          </button>
        )}
        <input
          ref={uploadRef}
          type="file"
          hidden
          accept="image/*"
          onChange={(e) => {
            if (e.target.files?.[0])
              void action.run(() => upload(e.target.files![0]));
            e.target.value = "";
          }}
        />
        {canMask && (
          <Button variant="ghost" onClick={() => setMaskOpen(true)}>
            <Paintbrush size={14} />
            {s.maskId ? "已指定局部重绘区域 · 修改" : "可选：只修改局部区域"}
          </Button>
        )}
        {s.maskId && (
          <button className="text-button" onClick={() => s.set({ maskId: "" })}>
            取消局部区域，修改整张图
          </button>
        )}
        {s.reference && selected && !fallbackNeeded && !isDemo && (
          <p className="edit-capability">
            {selected.verified.image2image
              ? "原图和修改要求将一起发送给模型。"
              : "将尝试发送原图和修改要求；此模型的图生图能力尚未验证。"}
          </p>
        )}
        {fallbackNeeded && (
          <div className="warning">
            <strong>当前模型无法读取原图</strong>
            <p>
              请在生成设置中更换支持图生图的模型。也可明确选择仅按原图提示词和修改要求重新画，原图细节不会传给模型。
            </p>
            <button
              className="text-button"
              onClick={() => setEditSettingsOpen(true)}
            >
              更换图生图模型
            </button>
            <label>
              <input
                type="checkbox"
                checked={allowFallback}
                onChange={(e) => setFallback(e.target.checked)}
              />
              我同意仅按文字重画，不发送原图
            </label>
          </div>
        )}
        <details
          className={
            s.reference
              ? "edit-generation-settings"
              : "text-generation-settings"
          }
          open={!s.reference || editSettingsOpen}
        >
          {s.reference && (
            <summary
              onClick={(e) => {
                e.preventDefault();
                setEditSettingsOpen(!editSettingsOpen);
              }}
            >
              生成设置
              <small>
                {selected?.name || "未选择模型"} · {count} 张
              </small>
              <ChevronDown size={14} />
            </summary>
          )}
          <div className="generation-settings-body">
            {s.reference && (
              <Field label="图生图模型">
                <select
                  value={modelIds[0] || ""}
                  onChange={(e) => s.reference && setModels([e.target.value])}
                >
                  <option value="" disabled>
                    请选择模型
                  </option>
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                      {m.capabilities.includes("image2image") &&
                      m.verified.image2image !== false
                        ? " · 可尝试图生图"
                        : " · 仅按文字重画"}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {s.reference && !models.length && (
              <Button
                onClick={() =>
                  s.set({
                    page: s.config?.activeProviderId ? "models" : "settings",
                  })
                }
              >
                去连接或添加模型
              </Button>
            )}
            <DrawingControls
              model={selected}
              editing={!!s.reference}
              gemini={provider?.adapter === "gemini"}
              size={size}
              setSize={setSize}
              quality={quality}
              setQuality={setQuality}
              options={drawingOptions}
              setOptions={setDrawingOptions}
              seed={seed}
              setSeed={setSeed}
              extra={extraParams}
              setExtra={setExtraParams}
              onModels={() => s.set({ page: "models" })}
            />
            <div className="count-control">
              <label>
                {s.reference
                  ? "新版本张数"
                  : extraModels || extraSizes || extraQualities || variants
                    ? "3. 每个组合的张数"
                    : "3. 生成张数"}
              </label>
              <div className="stepper">
                <button
                  aria-label="减少生成张数"
                  disabled={count === 1}
                  onClick={() => setCount(Math.max(1, count - 1))}
                >
                  −
                </button>
                <span>{count}</span>
                <button
                  aria-label="增加生成张数"
                  disabled={count === 32}
                  onClick={() => setCount(Math.min(32, count + 1))}
                >
                  +
                </button>
              </div>
            </div>
            <div className="slider-field">
              <div>
                <label>同时生成</label>
                <strong>{concurrency} 个任务</strong>
              </div>
              <input
                type="range"
                min="1"
                max="12"
                value={concurrency}
                onChange={(e) => setConcurrency(Number(e.target.value))}
              />
            </div>
            <button
              className="advanced-toggle"
              onClick={() => setAdvanced(!advanced)}
            >
              <SlidersHorizontal size={15} />
              更多生成选项
              <ChevronDown size={14} />
            </button>
            {advanced && (
              <div className="advanced-options">
                <div className="field-grid">
                  <Field label="优先级">
                    <input
                      type="number"
                      min="0"
                      max="10"
                      value={priority}
                      onChange={(e) => setPriority(Number(e.target.value))}
                    />
                  </Field>
                  <Field label="失败重试">
                    <input
                      type="number"
                      min="0"
                      max="5"
                      value={retries}
                      onChange={(e) => setRetries(Number(e.target.value))}
                    />
                  </Field>
                  <Field label="超时（秒）">
                    <input
                      type="number"
                      min="5"
                      max="1800"
                      value={timeout}
                      onChange={(e) => setTimeoutValue(Number(e.target.value))}
                    />
                  </Field>
                  <Field label="单次预算">
                    <input
                      type="number"
                      min="0"
                      placeholder="不限"
                      value={taskBudget}
                      onChange={(e) => setTaskBudget(e.target.value)}
                    />
                  </Field>
                  <Field label="每币种批次预算">
                    <input
                      type="number"
                      min="0"
                      placeholder="不限"
                      value={budget}
                      onChange={(e) => setBudget(e.target.value)}
                    />
                  </Field>
                </div>
                {!s.reference && (
                  <>
                    <Field label="额外尺寸（逗号分隔）">
                      <input
                        value={extraSizes}
                        onChange={(e) => setExtraSizes(e.target.value)}
                        placeholder="1024x1024,1024x1536"
                      />
                    </Field>
                    <Field label="额外质量（逗号分隔）">
                      <input
                        value={extraQualities}
                        onChange={(e) => setExtraQualities(e.target.value)}
                        placeholder="low,high"
                      />
                    </Field>
                    <Field label="提示词变体（每行一条，替代上方提示词）">
                      <textarea
                        value={variants}
                        onChange={(e) => setVariants(e.target.value)}
                        placeholder="第一种光线与构图…&#10;第二种色调与构图…"
                      />
                    </Field>
                  </>
                )}
              </div>
            )}
          </div>
        </details>
        {!s.reference && (
          <div className="estimate">
            <div>
              <span>本轮预估{estimate ? ` · ${estimate.count} 张` : ""}</span>
              <strong>
                {estimate
                  ? Object.entries(estimate.totals)
                      .map(([c, v]) => money(v, c))
                      .join(" + ")
                  : "—"}
              </strong>
            </div>
            <small>按你的价格表估算，实际以供应商账单为准</small>
          </div>
        )}
        {estimate?.warnings.map((w) => (
          <p className="inline-warning" key={w}>
            {w}
          </p>
        ))}
        {estimateError && <p className="inline-warning">{estimateError}</p>}
        {extraError && <p className="inline-warning">{extraError}</p>}
        {s.reference && (
          <section className="edit-results" aria-label="本轮原图的新版本">
            <strong className="edit-step-title">
              3. {batchImages.length ? "查看新版本" : "生成新版本"}
            </strong>
            {batchImages.length ? (
              <>
                <p>选择一个新版本继续修改，或留在本轮原图上再试一次。</p>
                {batchImages.map((result, index) => (
                  <div className="edit-result-card" key={result.id}>
                    <button
                      className="edit-result-preview"
                      aria-label={`对比第 ${index + 1} 个新版本与原图`}
                      onClick={() => setComparison(result)}
                    >
                      <img
                        src={result.thumbnailUrl}
                        alt={`新版本 ${index + 1}`}
                      />
                    </button>
                    <div>
                      <button
                        className="text-button"
                        onClick={() => setComparison(result)}
                      >
                        对比原图
                      </button>
                      <button
                        className="edit-continue"
                        onClick={() => s.beginEdit(result)}
                      >
                        <Pencil size={13} />
                        继续修改这个版本
                      </button>
                    </div>
                  </div>
                ))}
              </>
            ) : (
              <p>
                {batchPending
                  ? "正在根据这张原图生成，新版本会出现在这里。"
                  : "点击下方“生成新版本”。新图会保存在画布，并连到本轮原图。"}
              </p>
            )}
          </section>
        )}
        <details className="chat-assist" open={!s.reference}>
          <summary className="section-mini-title">
            <MessageCircle size={15} />
            {s.reference ? "可选：润色修改要求" : "可选：用对话模型润色描述"}
            <ChevronDown size={14} />
          </summary>
          <small>只修改文字；要出图，请点击下方生成按钮。</small>
          {chats.length ? (
            <>
              <select
                aria-label="对话模型"
                value={chatModel}
                onChange={(e) => setChatModel(e.target.value)}
              >
                {chats.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
              <Button
                disabled={action.busy || !prompt.trim()}
                onClick={() =>
                  action.run(async () => {
                    const answer = await post<{
                      text: string;
                      fallback: boolean;
                      cost: number;
                      currency: string;
                    }>("/chat", {
                      modelId: chatModel,
                      sessionId: s.sessionId,
                      message: prompt,
                      imageId: s.reference?.id,
                    });
                    s.setPrompt(answer.text);
                    window.dispatchEvent(
                      new CustomEvent("canvas-add-note", {
                        detail: { type: "chat", text: answer.text },
                      }),
                    );
                    await s.refresh();
                    s.toast(
                      answer.fallback
                        ? "使用了参考图元数据，模型未启用视觉能力"
                        : "提示词已更新",
                    );
                  })
                }
              >
                让模型帮我完善
              </Button>
            </>
          ) : (
            <small>
              暂无对话模型。仍可直接输入修改要求，使用参考图继续生成。
            </small>
          )}
        </details>
        {!s.reference && (
          <div className="session-control">
            <select
              aria-label="当前会话"
              value={s.sessionId}
              onChange={(e) => s.set({ sessionId: e.target.value })}
            >
              {s.data.sessions
                .filter((v) => v.projectId === s.projectId)
                .map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.title} ·{" "}
                    {new Date(v.createdAt).toLocaleTimeString("zh-CN", {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </option>
                ))}
            </select>
            <button
              title="新建会话"
              className="icon-btn"
              onClick={() =>
                action.run(async () => {
                  const session = await post<Session>("/sessions", {
                    projectId: s.projectId,
                  });
                  await s.refresh();
                  s.set({ sessionId: session.id });
                })
              }
            >
              <Plus size={14} />
            </button>
          </div>
        )}
      </div>
      <div className="composer-footer">
        {batchTasks.length > 0 && (
          <section
            className="batch-progress"
            aria-label="最近一轮生成进度"
            aria-live="polite"
          >
            <div>
              <strong>{batchPending ? "正在生成" : "最近一轮"}</strong>
              <span>
                已完成 {batchDone}/{batchTasks.length}
              </span>
            </div>
            <progress
              max={batchTasks.length}
              value={batchTasks.length - batchPending}
              aria-label="本轮任务完成进度"
            />
            <div>
              <small>
                {batchPending
                  ? `${batchPending} 个任务排队或生成中`
                  : batchFailed
                    ? `${batchFailed} 个任务失败，可在任务页重试`
                    : batchDone === batchTasks.length
                      ? "结果已保存，可继续修改"
                      : "本轮已结束，含取消的任务"}
              </small>
              {batchImage ? (
                <button
                  className="text-button"
                  onClick={() =>
                    s.set({ canvasFocusId: "image-" + batchImage.id })
                  }
                >
                  <LocateFixed size={13} />
                  查看结果
                </button>
              ) : (
                <button
                  className="text-button"
                  onClick={() => s.set({ page: "tasks" })}
                >
                  查看任务
                </button>
              )}
            </div>
          </section>
        )}
        <div>
          <span>{estimate ? `本轮 ${estimate.count} 张` : "本轮预估"}</span>
          <strong>
            {estimate
              ? Object.entries(estimate.totals)
                  .map(([c, v]) => money(v, c))
                  .join(" + ")
              : "—"}
          </strong>
        </div>
        <Button
          variant="primary"
          className="generate-button"
          disabled={action.busy || !!blockedReason}
          aria-describedby="generation-hint"
          onClick={() =>
            action.run(async () => {
              const tasks = await post<Task[]>("/tasks", input());
              setLastBatchId(tasks[0]?.batchId || "");
              requestId.current = crypto.randomUUID();
              s.toast(
                s.reference
                  ? `${tasks.length} 个新版本已加入队列，原图保持不变`
                  : `${tasks.length} 个任务已加入队列`,
              );
              await s.refresh();
            })
          }
        >
          {action.busy ? <Busy /> : <Sparkles size={17} />}
          {action.busy
            ? "正在提交…"
            : s.reference
              ? fallbackNeeded
                ? "按文字重新生成"
                : "生成新版本"
              : "开始生成"}
          <ArrowUp size={18} />
        </Button>
        <p id="generation-hint" className="generation-hint">
          {blockedReason ||
            (s.reference
              ? isDemo
                ? "演示模式：返回固定示例图，不产生费用"
                : fallbackNeeded
                  ? "只发送文字，无法保留原图细节"
                  : "发送本轮原图 + 修改要求，生成独立的新图片"
              : "生成后自动保存，在画布查看结果")}
        </p>
      </div>
      {maskOpen && s.reference && (
        <MaskEditor image={s.reference} onClose={() => setMaskOpen(false)} />
      )}
      {comparison && s.reference && (
        <Modal title="原图与新版本" wide onClose={() => setComparison(null)}>
          <p className="muted">修改要求：{comparison.prompt}</p>
          {isDemo && (
            <p className="inline-warning">
              这两张是固定的演示示例图，真实模型才会按要求修改画面。
            </p>
          )}
          <div className="edit-comparison">
            <figure>
              <img src={s.reference.url} alt="本轮原图" />
              <figcaption>本轮原图</figcaption>
            </figure>
            <figure>
              <img src={comparison.url} alt="新版本" />
              <figcaption>新版本</figcaption>
            </figure>
          </div>
          <div className="row">
            <Button
              onClick={() => {
                s.set({ canvasFocusId: "image-" + comparison.id });
                setComparison(null);
              }}
            >
              在画布查看
            </Button>
            <Button variant="primary" onClick={() => s.beginEdit(comparison)}>
              继续修改这个版本
            </Button>
          </div>
        </Modal>
      )}
    </aside>
  );
}
function MaskEditor({
  image,
  onClose,
}: {
  image: ImageAsset;
  onClose: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [brush, setBrush] = useState(45);
  const s = useStore();
  const action = useAction();
  const init = () => {
    const c = canvas.current;
    if (c) {
      const ctx = c.getContext("2d")!;
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = "#111";
      ctx.fillRect(0, 0, c.width, c.height);
    }
  };
  useEffect(init, []);
  function draw(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    const c = e.currentTarget;
    const r = c.getBoundingClientRect();
    const ctx = c.getContext("2d")!;
    ctx.globalCompositeOperation = "destination-out";
    ctx.beginPath();
    ctx.arc(
      ((e.clientX - r.left) * c.width) / r.width,
      ((e.clientY - r.top) * c.height) / r.height,
      (brush * c.width) / r.width / 2,
      0,
      Math.PI * 2,
    );
    ctx.fill();
  }
  return (
    <Modal title="涂抹要重新绘制的区域" wide onClose={onClose}>
      <p className="muted">
        擦开的区域会被重绘；灰色覆盖区域保留。遮罩会作为新文件保存。
      </p>
      <div className="mask-stage">
        <img src={image.url} />
        <canvas
          ref={canvas}
          width={image.width}
          height={image.height}
          onPointerDown={(e) => {
            drawing.current = true;
            e.currentTarget.setPointerCapture(e.pointerId);
            draw(e);
          }}
          onPointerMove={draw}
          onPointerUp={() => (drawing.current = false)}
          onPointerCancel={() => (drawing.current = false)}
        />
      </div>
      <div className="row">
        <label>
          画笔大小{" "}
          <input
            type="range"
            min="8"
            max="120"
            value={brush}
            onChange={(e) => setBrush(+e.target.value)}
          />
        </label>
        <Button onClick={init}>重置</Button>
        <Button
          variant="primary"
          disabled={action.busy}
          onClick={() =>
            action.run(async () => {
              const blob = await new Promise<Blob>((resolve) =>
                canvas.current!.toBlob((b) => resolve(b!), "image/png"),
              );
              const form = new FormData();
              form.set("image", blob, "mask.png");
              form.set("prompt", "局部重绘遮罩");
              form.set("projectId", s.projectId);
              form.set("sessionId", s.sessionId);
              const mask = await api<ImageAsset>("/images/upload", {
                method: "POST",
                body: form,
              });
              s.set({ maskId: mask.id });
              await s.refresh();
              onClose();
            })
          }
        >
          使用遮罩
        </Button>
      </div>
    </Modal>
  );
}
