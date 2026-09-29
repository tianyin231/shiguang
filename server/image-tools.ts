import type express from "express";
import type { Request } from "express";
import multer from "multer";
import sharp from "sharp";
import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import { all, event, get, transaction } from "./db";
import { ApiError } from "./providers";
import { commitImage, deleteFiles, saveImage } from "./storage";
import type { ImageAsset, Project, Session } from "../shared/types";
import {
  imageOutputMime,
  type ImageToolAnalysis,
  type ImageToolOptions,
} from "../shared/image-tools";

const MAX_BYTES = 50 * 1024 * 1024;
const MAX_INPUT_PIXELS = 100_000_000;
const MAX_OUTPUT_PIXELS = 40_000_000;
const MAX_SIDE = 8192;
const inputSettings = {
  limitInputPixels: MAX_INPUT_PIXELS,
  failOn: "error" as const,
};
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1 },
});
const dimension = z.number().int().min(1).max(MAX_SIDE);
const color = z
  .string()
  .regex(
    /^(?:#[\da-f]{3}|#[\da-f]{4}|#[\da-f]{6}|#[\da-f]{8}|transparent|white|black)$/i,
    "请使用十六进制颜色或 transparent",
  );
const optionsSchema = z
  .object({
    tool: z.enum([
      "crop",
      "resize",
      "convert",
      "adjust",
      "border",
      "watermark",
    ]),
    format: z.enum(["png", "jpeg", "webp", "avif"]).default("png"),
    quality: z.number().int().min(1).max(100).default(90),
    crop: z
      .object({
        left: z.number().int().min(0),
        top: z.number().int().min(0),
        width: dimension,
        height: dimension,
      })
      .optional(),
    rotation: z
      .union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)])
      .optional(),
    flip: z.boolean().optional(),
    flop: z.boolean().optional(),
    resize: z
      .object({
        width: dimension.optional(),
        height: dimension.optional(),
        fit: z.enum(["inside", "cover", "contain", "fill"]).default("inside"),
        background: color.default("transparent"),
        withoutEnlargement: z.boolean().default(false),
      })
      .refine((v) => v.width || v.height, "请填写宽度或高度")
      .optional(),
    adjust: z
      .object({
        brightness: z.number().min(0).max(3).default(1),
        saturation: z.number().min(0).max(3).default(1),
        contrast: z.number().min(0).max(3).default(1),
        blur: z.number().min(0).max(20).default(0),
        sharpen: z.number().min(0).max(10).default(0),
        grayscale: z.boolean().default(false),
      })
      .optional(),
    border: z
      .object({
        padding: z.number().int().min(0).max(2048).default(0),
        background: color.default("#ffffff"),
        radius: z.number().min(0).max(4096).default(0),
      })
      .optional(),
    watermark: z
      .object({
        text: z.string().trim().min(1).max(200),
        fontSize: z.number().min(8).max(512).default(32),
        color: color.default("#ffffff"),
        opacity: z.number().min(0).max(1).default(0.7),
        position: z
          .enum(["northwest", "northeast", "center", "southwest", "southeast"])
          .default("southeast"),
        margin: z.number().min(0).max(2048).default(24),
      })
      .optional(),
  })
  .superRefine((value, ctx) => {
    const tool = value.tool;
    if (tool !== "convert" && tool !== "crop" && !value[tool])
      ctx.addIssue({ code: "custom", path: [tool], message: "缺少工具参数" });
  });

function owned<T>(
  req: Request,
  table: Parameters<typeof get>[0],
  id: string,
): T {
  const value = get<T>(table, id, req.device.id);
  if (!value) throw new ApiError(404, "图片或项目记录不存在");
  return value;
}

async function readSource(req: Request) {
  const imageId = z.string().min(1).optional().parse(req.body?.imageId);
  if (req.file && imageId)
    throw new ApiError(400, "请选择文件或图库图片中的一种来源");
  let buffer: Buffer;
  if (req.file) buffer = req.file.buffer;
  else if (imageId) {
    const asset = owned<ImageAsset>(req, "images", imageId);
    if ((await stat(asset.path)).size > MAX_BYTES)
      throw new ApiError(413, "图片不能超过 50 MB");
    buffer = await readFile(asset.path);
  } else throw new ApiError(400, "请选择图片");
  if (buffer.length > MAX_BYTES) throw new ApiError(413, "图片不能超过 50 MB");
  let metadata: sharp.Metadata;
  try {
    metadata = await sharp(buffer, inputSettings).metadata();
  } catch {
    throw new ApiError(
      400,
      "无法读取图片，请使用有效的静态图片（最多 1 亿像素）",
    );
  }
  if (
    !new Set(["png", "jpeg", "webp", "heif", "tiff", "gif"]).has(
      metadata.format,
    )
  )
    throw new ApiError(
      400,
      "仅支持 PNG、JPEG、WebP、AVIF、TIFF 或静态 GIF 图片",
    );
  if ((metadata.pages ?? 1) > 1)
    throw new ApiError(400, "此工具仅处理静态图片，动图请使用 GIF 工具");
  if (metadata.width * metadata.height > MAX_INPUT_PIXELS)
    throw new ApiError(413, "图片不能超过 1 亿像素");
  return { buffer, metadata };
}

function checkOutput(width: number, height: number) {
  if (
    width > MAX_SIDE ||
    height > MAX_SIDE ||
    width * height > MAX_OUTPUT_PIXELS
  )
    throw new ApiError(
      400,
      "输出边长不能超过 8192，且总像素不能超过 4000 万，请先缩小或裁切图片",
    );
}

function outputSize(width: number, height: number, options: ImageToolOptions) {
  if (options.tool === "crop" && options.crop) {
    const crop = options.crop;
    if (crop.left + crop.width > width || crop.top + crop.height > height)
      throw new ApiError(400, "裁切范围超出自动转正后的原图");
    width = crop.width;
    height = crop.height;
  }
  if (
    options.tool === "crop" &&
    (options.rotation === 90 || options.rotation === 270)
  )
    [width, height] = [height, width];
  if (options.tool === "resize" && options.resize) {
    const resize = options.resize;
    if (resize.width && resize.height && resize.fit !== "inside") {
      width = resize.width;
      height = resize.height;
    } else {
      let scale = Math.min(
        resize.width ? resize.width / width : Infinity,
        resize.height ? resize.height / height : Infinity,
      );
      if (resize.withoutEnlargement) scale = Math.min(1, scale);
      width = Math.max(1, Math.round(width * scale));
      height = Math.max(1, Math.round(height * scale));
    }
  }
  if (options.tool === "border" && options.border) {
    width += options.border.padding * 2;
    height += options.border.padding * 2;
  }
  checkOutput(width, height);
  return { width, height };
}

function escapeXml(text: string) {
  return text.replace(/[\u0000-\u001f]/g, " ").replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[char]!,
  );
}

function textOverlay(
  width: number,
  height: number,
  watermark: NonNullable<ImageToolOptions["watermark"]>,
) {
  const { position, margin, fontSize } = watermark;
  const center = position === "center";
  const right = position.endsWith("east");
  const bottom = position.startsWith("south");
  const x = center ? width / 2 : right ? width - margin : margin;
  const y = center ? height / 2 : bottom ? height - margin : margin + fontSize;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><text x="${x}" y="${y}" text-anchor="${center ? "middle" : right ? "end" : "start"}" ${center ? 'dominant-baseline="middle"' : ""} font-family="Microsoft YaHei, Noto Sans CJK SC, WenQuanYi Zen Hei, sans-serif" font-size="${fontSize}" fill="${watermark.color}" opacity="${watermark.opacity}">${escapeXml(watermark.text)}</text></svg>`,
  );
}

async function processImage(
  buffer: Buffer,
  metadata: sharp.Metadata,
  options: z.infer<typeof optionsSchema>,
) {
  const { width, height } = outputSize(
    metadata.autoOrient.width,
    metadata.autoOrient.height,
    options,
  );
  // 先自动转正并解码，确保裁切坐标属于用户看到的原图，同时清除 EXIF。
  const oriented = await sharp(buffer, inputSettings)
    .autoOrient()
    .toColourspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });
  let pipeline = sharp(oriented.data, { raw: oriented.info });
  switch (options.tool) {
    case "crop": {
      if (options.crop) pipeline = pipeline.extract(options.crop);
      // Sharp 会重排部分操作；固定为转正 → 裁切 → 旋转 → 镜像。
      if (options.rotation || options.flip || options.flop) {
        const cropped = await pipeline
          .raw()
          .toBuffer({ resolveWithObject: true });
        pipeline = sharp(cropped.data, { raw: cropped.info });
      }
      if (options.rotation) pipeline = pipeline.rotate(options.rotation);
      if (options.rotation && (options.flip || options.flop)) {
        const rotated = await pipeline
          .raw()
          .toBuffer({ resolveWithObject: true });
        pipeline = sharp(rotated.data, { raw: rotated.info });
      }
      if (options.flip) pipeline = pipeline.flip();
      if (options.flop) pipeline = pipeline.flop();
      break;
    }
    case "resize":
      pipeline = pipeline.resize(options.resize!);
      break;
    case "adjust": {
      const adjust = options.adjust!;
      pipeline = pipeline.modulate({
        brightness: adjust.brightness,
        saturation: adjust.saturation,
      });
      if (adjust.contrast !== 1)
        pipeline = pipeline.linear(
          adjust.contrast,
          128 * (1 - adjust.contrast),
        );
      if (adjust.grayscale) pipeline = pipeline.grayscale();
      if (adjust.blur > 0) pipeline = pipeline.blur(Math.max(0.3, adjust.blur));
      if (adjust.sharpen > 0)
        pipeline = pipeline.sharpen(Math.max(0.01, adjust.sharpen));
      break;
    }
    case "border": {
      const border = options.border!;
      pipeline = pipeline.ensureAlpha().extend({
        top: border.padding,
        bottom: border.padding,
        left: border.padding,
        right: border.padding,
        background: border.background,
      });
      if (border.radius > 0) {
        const radius = Math.min(border.radius, width / 2, height / 2);
        pipeline = pipeline.composite([
          {
            input: Buffer.from(
              `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" rx="${radius}" fill="white"/></svg>`,
            ),
            blend: "dest-in",
          },
        ]);
      }
      break;
    }
    case "watermark":
      pipeline = pipeline.composite([
        { input: textOverlay(width, height, options.watermark!) },
      ]);
      break;
  }
  if (options.format === "jpeg")
    pipeline = pipeline.flatten({ background: "#ffffff" });
  return pipeline
    .toFormat(options.format, { quality: options.quality })
    .toBuffer({ resolveWithObject: true });
}

async function analyze(
  buffer: Buffer,
  metadata: sharp.Metadata,
): Promise<ImageToolAnalysis> {
  const { data } = await sharp(buffer, inputSettings)
    .autoOrient()
    .resize(128, 128, { fit: "inside", withoutEnlargement: true })
    .toColourspace("srgb")
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const buckets = new Map<
    number,
    { weight: number; red: number; green: number; blue: number }
  >();
  let total = 0;
  for (let i = 0; i < data.length; i += 4) {
    const weight = data[i + 3] / 255;
    if (!weight) continue;
    const key =
      ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
    const bucket = buckets.get(key) ?? { weight: 0, red: 0, green: 0, blue: 0 };
    bucket.weight += weight;
    bucket.red += data[i] * weight;
    bucket.green += data[i + 1] * weight;
    bucket.blue += data[i + 2] * weight;
    buckets.set(key, bucket);
    total += weight;
  }
  const palette = [...buckets.values()]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 8)
    .map((bucket) => ({
      hex:
        "#" +
        [bucket.red, bucket.green, bucket.blue]
          .map((channel) =>
            Math.round(channel / bucket.weight)
              .toString(16)
              .padStart(2, "0"),
          )
          .join(""),
      percent: Math.round((bucket.weight / total) * 1000) / 10,
    }));
  return {
    width: metadata.autoOrient.width,
    height: metadata.autoOrient.height,
    format:
      metadata.format === "heif" && metadata.compression === "av1"
        ? "avif"
        : metadata.format,
    bytes: buffer.length,
    hasAlpha: metadata.hasAlpha,
    channels: metadata.channels,
    density: metadata.density,
    hasExif: !!metadata.exif,
    hasIcc: !!metadata.icc,
    palette,
  };
}

export function registerImageToolRoutes(app: express.Express) {
  app.post(
    "/api/image-tools/process",
    upload.single("image"),
    async (req, res) => {
      const options = optionsSchema.parse(
        JSON.parse(String(req.body.options || "{}")),
      );
      const { buffer, metadata } = await readSource(req);
      try {
        const result = await processImage(buffer, metadata, options);
        checkOutput(result.info.width, result.info.height);
        res
          .set({
            "X-Image-Width": String(result.info.width),
            "X-Image-Height": String(result.info.height),
            "X-Image-Format": options.format,
          })
          .type(imageOutputMime[options.format])
          .send(result.data);
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError(400, `图片处理失败：${(error as Error).message}`);
      }
    },
  );
  app.post(
    "/api/image-tools/analyze",
    upload.single("image"),
    async (req, res) => {
      const { buffer, metadata } = await readSource(req);
      try {
        res.json(await analyze(buffer, metadata));
      } catch (error) {
        throw new ApiError(400, `图片分析失败：${(error as Error).message}`);
      }
    },
  );
  app.post(
    "/api/image-tools/save",
    upload.single("image"),
    async (req, res) => {
      const input = z
        .object({
          projectId: z.string().min(1),
          sessionId: z.string().min(1),
          sourceImageId: z.string().min(1).optional(),
          name: z.string().trim().max(200).optional(),
        })
        .parse(req.body);
      if (!req.file) throw new ApiError(400, "请选择要保存的处理结果");
      const project = owned<Project>(req, "projects", input.projectId);
      const session = owned<Session>(req, "sessions", input.sessionId);
      if (session.projectId !== project.id)
        throw new ApiError(400, "会话与项目不匹配");
      const source = input.sourceImageId
        ? owned<ImageAsset>(req, "images", input.sourceImageId)
        : undefined;
      if (source && source.projectId !== project.id)
        throw new ApiError(400, "原图与保存项目不匹配");
      const { buffer, metadata } = await readSource(req);
      checkOutput(metadata.autoOrient.width, metadata.autoOrient.height);
      const image = await saveImage(req.device.id, buffer, {
        projectId: project.id,
        sessionId: session.id,
        parentImageId: source?.id,
        prompt: input.name || "工具箱处理结果",
        effectivePrompt: "",
        modelName: "本地图片工具",
        params: { size: "auto", quality: "auto" },
        currency: "USD",
        costSource: "estimate",
      });
      try {
        transaction(() => commitImage(req.device.id, image));
      } catch (error) {
        await deleteFiles(image, all<ImageAsset>("images", req.device.id));
        throw error;
      }
      event(req.device.id, "images", [image.id]);
      res.status(201).json(image);
    },
  );
}
