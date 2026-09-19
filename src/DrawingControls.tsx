import { useState } from "react";
import type { DrawingOptions, Model } from "../shared/types";
import { aspectRatios, imageParameters } from "../shared/drawing";
import { Field } from "./components";

const ratioSizes: Record<string, string> = {
  "1:1": "1024x1024",
  "16:9": "1536x864",
  "9:16": "864x1536",
  "4:3": "1536x1152",
  "3:4": "1152x1536",
  "3:2": "1536x1024",
  "2:3": "1024x1536",
  "21:9": "1792x768",
  "4:5": "1024x1280",
  "5:4": "1280x1024",
};
export function DrawingControls({
  model,
  editing,
  gemini,
  size,
  setSize,
  quality,
  setQuality,
  options,
  setOptions,
  seed,
  setSeed,
  extra,
  setExtra,
  onModels,
}: {
  model?: Model;
  editing: boolean;
  gemini: boolean;
  size: string;
  setSize: (s: string) => void;
  quality: string;
  setQuality: (s: string) => void;
  options: DrawingOptions;
  setOptions: (o: DrawingOptions) => void;
  seed: string;
  setSeed: (s: string) => void;
  extra: string;
  setExtra: (s: string) => void;
  onModels: () => void;
}) {
  const [customQuality, setCustomQuality] = useState(false);
  const supported = model ? imageParameters(model) : [];
  const supports = (key: string) =>
    supported.includes(key) && (!gemini || key === "image_size");
  const [width, height] = size === "auto" ? ["", ""] : size.split("x");
  const ratio =
    aspectRatios.find((r) => {
      const [w, h] = r.split(":").map(Number);
      return Math.abs(Number(width) / Number(height) - w / h) < 0.005;
    }) || "custom";
  const qualities = [
    ...new Set([
      "auto",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "standard",
      "hd",
      ...(model?.qualities || []),
    ]),
  ];
  const qLabels: Record<string, string> = {
    auto: "自动",
    low: "低 · 更快",
    medium: "中 · 均衡",
    high: "高 · 精细",
    xhigh: "超高 · xhigh",
    max: "最高 · max",
    standard: "标准 · standard",
    hd: "高清 · hd",
  };
  const update = (key: keyof DrawingOptions, value: unknown) =>
    setOptions({ ...options, [key]: value === "" ? undefined : value });
  const scale = (longEdge: number) => {
    const w = Number(width) || 1,
      h = Number(height) || 1;
    setSize(
      `${Math.max(16, Math.round(((w / Math.max(w, h)) * longEdge) / 16) * 16)}x${Math.max(16, Math.round(((h / Math.max(w, h)) * longEdge) / 16) * 16)}`,
    );
  };
  return (
    <section className="drawing-controls" aria-label="绘画参数">
      <div className="field-grid">
        <Field label="画面比例">
          <select
            value={size === "auto" ? "auto" : ratio}
            onChange={(e) =>
              e.target.value !== "custom" &&
              setSize(
                e.target.value === "auto" ? "auto" : ratioSizes[e.target.value],
              )
            }
          >
            <option value="auto">模型自动</option>
            {aspectRatios.map((r) => (
              <option key={r}>{r}</option>
            ))}
            <option value="custom">自定义宽高</option>
          </select>
        </Field>
        <Field label="尺寸预设">
          <select value={size} onChange={(e) => setSize(e.target.value)}>
            {[
              ...new Set([
                size,
                "auto",
                ...Object.values(ratioSizes),
                ...(model?.sizes || []),
              ]),
            ].map((v) => (
              <option key={v} value={v}>
                {v === "auto" ? "自动" : v.replace("x", " × ")}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="field-grid">
        <Field label="宽度 px">
          <input
            type="number"
            min="64"
            max="32768"
            step="16"
            value={width}
            placeholder="自动"
            onChange={(e) => setSize(`${e.target.value}x${height || "1024"}`)}
          />
        </Field>
        <Field label="高度 px">
          <input
            type="number"
            min="64"
            max="32768"
            step="16"
            value={height}
            placeholder="自动"
            onChange={(e) => setSize(`${width || "1024"}x${e.target.value}`)}
          />
        </Field>
      </div>
      <div className="drawing-chips resolution-chips">
        <span>长边</span>
        {[
          [1024, "1K"],
          [2048, "2K"],
          [3840, "4K"],
        ].map(([n, label]) => (
          <button key={n} onClick={() => scale(Number(n))}>
            {label}
          </button>
        ))}
        <small>按比例设置请求尺寸</small>
      </div>
      <Field label="画质">
        <select
          disabled={gemini}
          value={
            customQuality || !qualities.includes(quality) ? "custom" : quality
          }
          onChange={(e) => {
            setCustomQuality(e.target.value === "custom");
            if (e.target.value !== "custom") setQuality(e.target.value);
          }}
        >
          {qualities.map((q) => (
            <option value={q} key={q}>
              {qLabels[q] || q}
            </option>
          ))}
          <option value="custom">自定义画质参数…</option>
        </select>
      </Field>
      {(customQuality || !qualities.includes(quality)) && (
        <Field label="自定义画质值">
          <input
            value={quality}
            onChange={(e) => setQuality(e.target.value)}
            placeholder="供应商文档中的 quality 值"
          />
        </Field>
      )}
      <p className="parameter-hint">
        {gemini
          ? "Gemini 按比例生成；清晰度请使用下方原生分辨率档位，不发送 quality。"
          : "尺寸和画质按填写值请求，支持范围由模型决定；更高设置可能增加费用。"}
      </p>
      <details className="painting-options">
        <summary>Seed 与模型专属参数</summary>
        <div className="field-grid">
          <Field label="Seed 随机种子">
            <input
              type="number"
              min="0"
              value={seed}
              onChange={(e) => setSeed(e.target.value)}
              placeholder="留空：每张随机"
            />
          </Field>
          <Field label="批量 Seed 方式">
            <select
              value={options.seedMode || "increment"}
              onChange={(e) => update("seedMode", e.target.value)}
            >
              <option value="increment">逐张递增</option>
              <option value="fixed">固定不变 · 对比参数</option>
            </select>
          </Field>
        </div>
        <div className="drawing-chips">
          <button
            onClick={() =>
              setSeed(
                String(
                  crypto.getRandomValues(new Uint32Array(1))[0] % 2147483647,
                ),
              )
            }
          >
            随机填入
          </button>
          <button onClick={() => setSeed("")}>清空 Seed</button>
        </div>
        <p className="parameter-hint">
          {model?.supportsSeed
            ? "固定 Seed 可用于比较参数效果，是否可复现取决于供应商。"
            : "此模型未启用 Seed，填写的种子不会发送给模型。"}
        </p>
        <div className="field-grid">
          <Field label="背景">
            <select
              disabled={!supports("background")}
              value={options.background || ""}
              onChange={(e) => update("background", e.target.value)}
            >
              <option value="">默认</option>
              <option value="transparent">透明背景</option>
              <option value="opaque">不透明背景</option>
              <option value="auto">模型自动</option>
            </select>
          </Field>
          <Field label="原生分辨率档位">
            <select
              disabled={!supports("image_size")}
              value={options.imageSize || ""}
              onChange={(e) => update("imageSize", e.target.value)}
            >
              <option value="">默认</option>
              {["1K", "2K", "4K"].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </Field>
          {editing && (
            <>
              <Field label="参考图保真度">
                <select
                  disabled={!supports("input_fidelity")}
                  value={options.inputFidelity || ""}
                  onChange={(e) => update("inputFidelity", e.target.value)}
                >
                  <option value="">默认</option>
                  <option value="high">高 · 尽量保留细节</option>
                  <option value="low">低 · 更多创作空间</option>
                </select>
              </Field>
              <Field label="重绘强度 0–1">
                <input
                  disabled={!supports("strength")}
                  type="number"
                  min="0"
                  max="1"
                  step="0.05"
                  placeholder="默认"
                  value={options.strength ?? ""}
                  onChange={(e) =>
                    update(
                      "strength",
                      e.target.value === "" ? "" : Number(e.target.value),
                    )
                  }
                />
              </Field>
            </>
          )}
          <Field label="采样步数">
            <input
              disabled={!supports("steps")}
              type="number"
              min="1"
              max="150"
              placeholder="默认"
              value={options.steps ?? ""}
              onChange={(e) =>
                update(
                  "steps",
                  e.target.value === "" ? "" : Number(e.target.value),
                )
              }
            />
          </Field>
          <Field label="引导强度 CFG">
            <input
              disabled={!supports("cfg_scale")}
              type="number"
              min="0"
              max="30"
              step="0.5"
              placeholder="默认"
              value={options.cfgScale ?? ""}
              onChange={(e) =>
                update(
                  "cfgScale",
                  e.target.value === "" ? "" : Number(e.target.value),
                )
              }
            />
          </Field>
        </div>
        <Field label="采样器">
          <input
            disabled={!supports("sampler_name")}
            list="sampler-options"
            value={options.sampler || ""}
            placeholder="默认"
            onChange={(e) => update("sampler", e.target.value)}
          />
          <datalist id="sampler-options">
            {["Euler", "Euler a", "DPM++ 2M", "DPM++ SDE", "DDIM"].map((v) => (
              <option key={v}>{v}</option>
            ))}
          </datalist>
        </Field>
        <p className="parameter-hint">
          灰色选项尚未启用。不同模型的参数和取值并不通用，可在
          <button className="text-button" onClick={onModels}>
            模型能力设置
          </button>
          中配置。原生分辨率档位优先于像素尺寸，图片统一保存为 PNG。
        </p>
        {!gemini && (
          <Field
            label="供应商扩展参数 JSON"
            hint="仅按供应商文档填写；不能覆盖张数、提示词、尺寸或参考图。"
          >
            <textarea
              rows={3}
              value={extra}
              onChange={(e) => setExtra(e.target.value)}
              placeholder={'例如：{"style":"natural"}'}
              spellCheck={false}
            />
          </Field>
        )}
      </details>
    </section>
  );
}
