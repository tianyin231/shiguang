import type { DrawingOptions, Model } from "./types";

export const drawingFields = [
  { key: "negativePrompt", api: "negative_prompt", label: "独立负面提示词" },
  { key: "background", api: "background", label: "透明 / 不透明背景" },
  { key: "inputFidelity", api: "input_fidelity", label: "参考图保真度" },
  { key: "steps", api: "steps", label: "采样步数" },
  { key: "cfgScale", api: "cfg_scale", label: "提示词引导强度 CFG" },
  { key: "sampler", api: "sampler_name", label: "采样器" },
  { key: "strength", api: "strength", label: "重绘强度" },
  { key: "imageSize", api: "image_size", label: "原生分辨率档位" },
] as const;
export function imageParameters(model: Model): string[] {
  if (model.imageParameters) return model.imageParameters;
  if (model.name === "demo-image") return drawingFields.map((f) => f.api);
  if (/^gpt-image/i.test(model.name)) return ["background", "input_fidelity"];
  return [];
}
// 扩展参数不能覆盖队列预算、参考图、种子或界面中已有的设置。
export const reservedImageParameters = new Set([
  "model",
  "prompt",
  "n",
  "batch_size",
  "num_images",
  "num_outputs",
  "image",
  "images",
  "mask",
  "size",
  "quality",
  "seed",
  "stream",
  "response_format",
  ...drawingFields.map((f) => f.api),
]);
export function nativeDrawingParams(
  model: Model,
  options: DrawingOptions,
  editing: boolean,
): Record<string, unknown> {
  const supported = imageParameters(model);
  const result: Record<string, unknown> = { ...options.extraParams };
  for (const field of drawingFields) {
    const value = options[field.key];
    if (value === undefined || value === "" || !supported.includes(field.api))
      continue;
    if (["inputFidelity", "strength"].includes(field.key) && !editing) continue;
    result[field.api] = value;
  }
  return result;
}
export function promptWithNegative(
  prompt: string,
  options: DrawingOptions,
  model: Model,
): string {
  return options.negativePrompt?.trim() &&
    !imageParameters(model).includes("negative_prompt")
    ? `${prompt}\n\n避免以下内容（负面约束）：\n${options.negativePrompt.trim()}`
    : prompt;
}
export const aspectRatios = [
  "1:1",
  "4:3",
  "3:4",
  "3:2",
  "2:3",
  "16:9",
  "9:16",
  "21:9",
  "4:5",
  "5:4",
];
export function nearestAspectRatio(size: string): string | undefined {
  if (size === "auto") return undefined;
  const [w, h] = size.split("x").map(Number);
  return [...aspectRatios].sort((a, b) => {
    const ratio = (v: string) => {
      const [x, y] = v.split(":").map(Number);
      return Math.abs(Math.log(w / h / (x / y)));
    };
    return ratio(a) - ratio(b);
  })[0];
}
