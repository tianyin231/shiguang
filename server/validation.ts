import { z } from "zod";
import { drawingFields, reservedImageParameters } from "../shared/drawing";
const drawingSchema = z.object({
  negativePrompt: z.string().max(10000).optional(),
  seedMode: z.enum(["fixed", "increment"]).optional(),
  background: z.enum(["auto", "opaque", "transparent"]).optional(),
  inputFidelity: z.enum(["high", "low"]).optional(),
  steps: z.number().int().min(1).max(150).optional(),
  cfgScale: z.number().min(0).max(30).optional(),
  sampler: z.string().max(100).optional(),
  strength: z.number().min(0).max(1).optional(),
  imageSize: z.enum(["1K", "2K", "4K"]).optional(),
  extraParams: z
    .record(z.string(), z.unknown())
    .refine(
      (value) =>
        !Object.keys(value).some((key) => reservedImageParameters.has(key)),
      "扩展参数不能覆盖 model、prompt、n、参考图或界面中已有的绘画参数",
    )
    .optional(),
});
export const generationSchema = z.object({
  ...drawingSchema.shape,
  projectId: z.string(),
  sessionId: z.string(),
  modelIds: z.array(z.string()).min(1).max(12),
  prompt: z.string().min(1).max(20000),
  variants: z.array(z.string().min(1).max(20000)).max(32).default([]),
  count: z.number().int().min(1).max(32).default(1),
  sizes: z
    .array(z.string().regex(/^(auto|\d{2,5}x\d{2,5})$/))
    .min(1)
    .max(8)
    .default(["1024x1024"]),
  qualities: z.array(z.string().max(50)).min(1).max(8).default(["auto"]),
  seed: z.number().int().min(0).optional(),
  concurrency: z.number().int().min(1).max(32).default(2),
  retries: z.number().int().min(0).max(5).default(1),
  timeout: z.number().int().min(5).max(1800).default(600),
  priority: z.number().int().min(0).max(10).default(0),
  referenceId: z.string().optional(),
  maskId: z.string().optional(),
  taskBudget: z.number().nonnegative().optional(),
  batchBudget: z.number().nonnegative().optional(),
  allowFallback: z.boolean().default(false),
  idempotencyKey: z.string().min(1).max(100),
});
export const providerSchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().max(100).default(""),
  baseUrl: z.url().refine((v) => /^https?:\/\//.test(v), "需要 HTTP(S) 地址"),
  apiKey: z.string().max(10000).optional(),
  adapter: z.enum(["openai", "gemini", "anthropic", "demo"]).default("openai"),
  proxyUrl: z
    .string()
    .default("")
    .refine((v) => !v || /^https?:\/\//.test(v), "代理需要 HTTP(S) 地址"),
  concurrency: z.number().int().min(1).max(32).default(4),
});
export const priceSchema = z.object({
  type: z.enum(["image", "megapixel", "token"]),
  unit: z.number().nonnegative(),
  outputUnit: z.number().nonnegative().default(0),
  currency: z.string().min(1).max(8),
  qualityMultiplier: z.record(z.string(), z.number().nonnegative()).default({}),
});
export const modelPatchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  capabilities: z
    .array(
      z.enum([
        "text2image",
        "image2image",
        "vision",
        "chat",
        "streaming",
        "mask",
      ]),
    )
    .optional(),
  sizes: z.array(z.string()).max(30).optional(),
  qualities: z.array(z.string()).max(30).optional(),
  supportsSeed: z.boolean().optional(),
  supportsN: z.boolean().optional(),
  imageParameters: z.array(z.enum(drawingFields.map((f) => f.api))).optional(),
  maxConcurrency: z.number().int().min(1).max(32).optional(),
  favorite: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  price: priceSchema.optional(),
});
export const settingsSchema = z.object({
  outputDir: z.string().min(1),
  filenameTemplate: z.string().min(1).max(400),
  quotaMB: z.number().positive(),
  totalBudgets: z.record(z.string(), z.number().nonnegative()),
  concurrency: z.number().int().min(1).max(32),
  retries: z.number().int().min(0).max(5),
  timeout: z.number().int().min(5).max(1800),
});
export const canvasSchema = z.object({
  nodes: z
    .array(
      z
        .object({
          id: z.string(),
          position: z.object({ x: z.number(), y: z.number() }),
          data: z.record(z.string(), z.unknown()),
        })
        .passthrough(),
    )
    .max(5000),
  edges: z
    .array(
      z
        .object({ id: z.string(), source: z.string(), target: z.string() })
        .passthrough(),
    )
    .max(10000),
  viewport: z
    .object({ x: z.number(), y: z.number(), zoom: z.number().positive() })
    .optional(),
  hiddenTaskIds: z.array(z.string()).optional(),
  hiddenImageIds: z.array(z.string()).optional(),
});
