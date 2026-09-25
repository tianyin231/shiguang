import express, { type Request, type Response, type NextFunction } from "express";
import multer from "multer";
import { z } from "zod";
import { spawn } from "node:child_process";
import { mkdirSync, existsSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { db, uid, now } from "./db";
import { dataDir } from "./db";
import { ApiError } from "./providers";
import type { VideoJob, VideoJobParams, VideoCapability } from "../shared/types";

/* FFmpeg 二进制解析：环境变量 > npm 静态包 > 系统 PATH */

type Binaries = { ffmpeg: string | null; ffprobe: string | null };
let binCache: Binaries | undefined;

async function resolveBin(name: "ffmpeg" | "ffprobe"): Promise<string | null> {
  const envKey = name === "ffmpeg" ? "FFMPEG_PATH" : "FFPROBE_PATH";
  if (process.env[envKey] && existsSync(process.env[envKey] as string))
    return process.env[envKey] as string;
  try {
    const pkg =
      name === "ffmpeg"
        ? ((await import("ffmpeg-static")) as { default?: string | null })
        : ((await import("ffprobe-static")) as {
            default?: { path?: string | null } | null;
          });
    const p =
      name === "ffmpeg"
        ? (pkg as { default?: string | null }).default
        : (pkg as { default?: { path?: string | null } }).default?.path;
    if (p && existsSync(p)) return p;
  } catch {
    /* 包未安装，继续探测系统 PATH */
  }
  return await new Promise<string | null>((resolve) => {
    const probe = spawn("where", [name], { windowsHide: true });
    let out = "";
    probe.stdout?.on("data", (c) => (out += String(c)));
    probe.on("error", () => resolve(null));
    probe.on("close", (code) => {
      const first = out.split(/\r?\n/).find((l) => l.trim());
      resolve(code === 0 && first ? first.trim() : null);
    });
  });
}

async function binaries(): Promise<Binaries> {
  if (!binCache)
    binCache = {
      ffmpeg: await resolveBin("ffmpeg"),
      ffprobe: await resolveBin("ffprobe"),
    };
  return binCache;
}

let aiMatteAvailable: boolean | undefined;
async function aiMatteInstalled(): Promise<boolean> {
  if (aiMatteAvailable === undefined) {
    try {
      // 可选依赖：包名用变量传递，未安装时不影响编译与启动
      const specifier = "@imgly/background-removal-node";
      await import(specifier);
      aiMatteAvailable = true;
    } catch {
      aiMatteAvailable = false;
    }
  }
  return aiMatteAvailable;
}

export async function videoCapability(): Promise<VideoCapability> {
  const bins = await binaries();
  return {
    ffmpeg: !!bins.ffmpeg,
    ffprobe: !!bins.ffprobe,
    aiMatte: await aiMatteInstalled(),
  };
}

/* 任务存储：SQLite 持久化，输出文件在 data/video/<jobId>/ */

const videoRoot = path.join(dataDir, "video");
const jobDir = (jobId: string) => path.join(videoRoot, jobId);

db.exec(`CREATE TABLE IF NOT EXISTS video_jobs(
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  status TEXT NOT NULL,
  progress INTEGER NOT NULL DEFAULT 0,
  params TEXT NOT NULL,
  result TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`);
db.exec(
  `UPDATE video_jobs SET status='failed', error='{\"code\":\"INTERRUPTED\",\"message\":\"服务重启，任务中断\"}', updated_at=${now()} WHERE status IN ('queued','processing')`,
);

function rowToJob(row: Record<string, unknown>): VideoJob {
  return {
    id: String(row.id),
    status: row.status as VideoJob["status"],
    progress: Number(row.progress),
    params: JSON.parse(String(row.params)),
    error: row.error ? JSON.parse(String(row.error)) : null,
    result: row.result ? JSON.parse(String(row.result)) : null,
    createdAt: Number(row.created_at),
  };
}

function getJob(id: string, deviceId: string): VideoJob {
  const row = db
    .prepare("SELECT * FROM video_jobs WHERE id=? AND device_id=?")
    .get(id, deviceId) as Record<string, unknown> | undefined;
  if (!row) throw new ApiError(404, "任务不存在");
  return rowToJob(row);
}

function updateJob(id: string, patch: Partial<VideoJob>) {
  const sets: string[] = ["updated_at=?"];
  const args: (string | number | null)[] = [now()];
  if (patch.status !== undefined) {
    sets.push("status=?");
    args.push(patch.status);
  }
  if (patch.progress !== undefined) {
    sets.push("progress=?");
    args.push(patch.progress);
  }
  if (patch.result !== undefined) {
    sets.push("result=?");
    args.push(JSON.stringify(patch.result));
  }
  if (patch.error !== undefined) {
    sets.push("error=?");
    args.push(JSON.stringify(patch.error));
  }
  args.push(id);
  db.prepare(`UPDATE video_jobs SET ${sets.join(",")} WHERE id=?`).run(...args);
}

/* 串行队列：视频处理占用 CPU/IO，一次只跑一个任务 */

let chain: Promise<void> = Promise.resolve();

function enqueueRun(jobId: string, deviceId: string, videoPath: string) {
  chain = chain
    .then(() => runPipeline(jobId, deviceId, videoPath))
    .catch((e) => {
      console.error("视频任务失败:", e);
    });
}

/* 参数与处理管线（移植自 FrameRonin worker/processor.py） */

const videoParamsSchema = z.object({
  fps: z.number().int().min(1).max(60).default(12),
  frame_range: z
    .object({
      start_sec: z.number().min(0).default(0),
      end_sec: z.number().min(0).nullable().default(null),
    })
    .default({ start_sec: 0, end_sec: null }),
  max_frames: z.number().int().min(1).max(2000).default(300),
  target_size: z
    .object({
      w: z.number().int().min(16).max(1024).default(256),
      h: z.number().int().min(16).max(1024).default(256),
    })
    .default({ w: 256, h: 256 }),
  bg_color: z.string().default("transparent"),
  transparent: z.boolean().default(true),
  padding: z.number().int().min(0).max(64).default(4),
  spacing: z.number().int().min(0).max(64).default(4),
  layout_mode: z.enum(["fixed_columns", "auto_square"]).default("fixed_columns"),
  columns: z.number().int().min(1).max(64).default(12),
  matte_mode: z.enum(["none", "chroma", "ai"]).default("none"),
  chroma_color: z.string().default("#00ff00"),
  chroma_tolerance: z.number().min(0).max(200).default(80),
  crop_mode: z.enum(["none", "tight_bbox", "safe_bbox"]).default("tight_bbox"),
});

const ALLOWED_VIDEO_EXTENSIONS = [".mp4", ".mov", ".webm", ".avi", ".mkv"];

function runBin(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c) => (stdout += String(c)));
    child.stderr?.on("data", (c) => (stderr += String(c)));
    child.on("error", (e) => reject(new Error(`无法启动 ${bin}：${e.message}`)));
    child.on("close", (code) =>
      code === 0
        ? resolve(stdout)
        : reject(new Error(stderr.trim().split("\n").slice(-3).join(" ") || `退出码 ${code}`)),
    );
  });
}

async function probeVideo(bin: string | null, videoPath: string) {
  if (!bin) throw new ApiError(400, "未找到 ffprobe，无法读取视频信息");
  const out = await runBin(bin, [
    "-v", "quiet",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    videoPath,
  ]);
  const data = JSON.parse(out) as {
    streams: { codec_type?: string; width?: number; height?: number; r_frame_rate?: string }[];
    format?: { duration?: string };
  };
  let duration = 0;
  let width = 0;
  let height = 0;
  let fps = 30;
  for (const stream of data.streams ?? []) {
    if (stream.codec_type === "video") {
      width = stream.width ?? 0;
      height = stream.height ?? 0;
      const [num, den] = (stream.r_frame_rate ?? "30/1").split("/").map(Number);
      if (num && den) fps = num / den;
      break;
    }
  }
  duration = Number(data.format?.duration ?? 0) || 0;
  return { duration, width, height, fps };
}

interface RawFrame {
  data: Buffer;
  width: number;
  height: number;
}

async function loadFrame(file: string): Promise<RawFrame> {
  const { data, info } = await sharp(file)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/** 色度键：与目标色距离 ≤ 容差全透明，容差~容差+16 线性羽化 */
function chromaKey(frame: RawFrame, color: string, tolerance: number) {
  const hex = color.replace("#", "");
  const kr = parseInt(hex.slice(0, 2), 16) || 0;
  const kg = parseInt(hex.slice(2, 4), 16) || 0;
  const kb = parseInt(hex.slice(4, 6), 16) || 0;
  const d = frame.data;
  const feather = 16;
  for (let i = 0; i < d.length; i += 4) {
    const dist = Math.sqrt(
      (d[i] - kr) ** 2 + (d[i + 1] - kg) ** 2 + (d[i + 2] - kb) ** 2,
    );
    if (dist <= tolerance) d[i + 3] = 0;
    else if (dist < tolerance + feather)
      d[i + 3] = Math.round(255 * ((dist - tolerance) / feather));
  }
}

/** AI 抠图：可选依赖 @imgly/background-removal-node，首次调用会下载模型 */
async function aiMatte(frame: RawFrame): Promise<RawFrame> {
  const specifier = "@imgly/background-removal-node";
  const mod = (await import(specifier).catch(
    () => undefined,
  )) as { removeBackground?: (input: Blob) => Promise<Blob> } | undefined;
  if (!mod?.removeBackground)
    throw new ApiError(
      400,
      "AI 抠图组件未安装：请在项目根目录运行 npm i @imgly/background-removal-node 后重启",
    );
  const png = await sharp(frame.data, {
    raw: { width: frame.width, height: frame.height, channels: 4 },
  })
    .png()
    .toBuffer();
  const blob = await mod.removeBackground(
    new Blob([new Uint8Array(png)], { type: "image/png" }),
  );
  const { data, info } = await sharp(Buffer.from(await blob.arrayBuffer()))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

function alphaBbox(frame: RawFrame): [number, number, number, number] | null {
  const { data, width, height } = frame;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] !== 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return maxX < 0 ? null : [minX, minY, maxX + 1, maxY + 1];
}

function parseBgColor(s: string): { r: number; g: number; b: number; alpha: number } {
  if (!s || s === "transparent") return { r: 0, g: 0, b: 0, alpha: 0 };
  const hex = s.replace("#", "");
  if (hex.length === 6)
    return {
      r: parseInt(hex.slice(0, 2), 16) || 0,
      g: parseInt(hex.slice(2, 4), 16) || 0,
      b: parseInt(hex.slice(4, 6), 16) || 0,
      alpha: 255,
    };
  return { r: 0, g: 0, b: 0, alpha: 0 };
}

async function processFrame(
  raw: RawFrame,
  p: VideoJobParams,
): Promise<Buffer> {
  let img = raw;
  if (p.matte_mode === "chroma")
    chromaKey(img, p.chroma_color, p.chroma_tolerance);
  else if (p.matte_mode === "ai") img = await aiMatte(img);

  if (p.crop_mode !== "none") {
    const bbox = alphaBbox(img);
    if (bbox) {
      const pad = p.crop_mode === "safe_bbox" ? p.padding : 0;
      const x1 = Math.max(0, bbox[0] - pad);
      const y1 = Math.max(0, bbox[1] - pad);
      const x2 = Math.min(img.width, bbox[2] + pad);
      const y2 = Math.min(img.height, bbox[3] + pad);
      img = await cropRaw(img, x1, y1, x2 - x1, y2 - y1);
    }
  }

  const maxW = Math.max(1, p.target_size.w - p.padding * 2);
  const maxH = Math.max(1, p.target_size.h - p.padding * 2);
  const scale = Math.min(1, maxW / img.width, maxH / img.height);
  const fitW = Math.max(1, Math.round(img.width * scale));
  const fitH = Math.max(1, Math.round(img.height * scale));
  const resized = await sharp(img.data, {
    raw: { width: img.width, height: img.height, channels: 4 },
  })
    .resize(fitW, fitH, { kernel: "lanczos3", withoutEnlargement: true })
    .png()
    .toBuffer();

  const bg = parseBgColor(p.bg_color);
  const canvas = sharp({
    create: {
      width: p.target_size.w,
      height: p.target_size.h,
      channels: 4,
      background: p.transparent
        ? { r: 0, g: 0, b: 0, alpha: 0 }
        : { r: bg.r, g: bg.g, b: bg.b, alpha: bg.alpha },
    },
  }).composite([
    {
      input: resized,
      left: Math.round((p.target_size.w - fitW) / 2),
      top: Math.round((p.target_size.h - fitH) / 2),
    },
  ]);
  return canvas.png().toBuffer();
}

async function cropRaw(
  frame: RawFrame,
  left: number,
  top: number,
  width: number,
  height: number,
): Promise<RawFrame> {
  const out = await sharp(frame.data, {
    raw: { width: frame.width, height: frame.height, channels: 4 },
  })
    .extract({ left, top, width, height })
    .raw()
    .toBuffer();
  return { data: out, width, height };
}

function computeLayout(
  frameCount: number,
  layoutMode: string,
  columns: number,
): number {
  if (layoutMode === "fixed_columns" && columns) return columns;
  return Math.max(1, Math.ceil(Math.sqrt(frameCount)));
}

async function runPipeline(
  jobId: string,
  deviceId: string,
  videoPath: string,
) {
  const row = db
    .prepare("SELECT params FROM video_jobs WHERE id=? AND device_id=?")
    .get(jobId, deviceId) as { params: string } | undefined;
  if (!row) return;
  const p = JSON.parse(row.params) as VideoJobParams;
  const bins = await binaries();
  try {
    if (!bins.ffmpeg) throw new ApiError(400, "未找到 FFmpeg，无法处理视频");
    updateJob(jobId, { status: "processing", progress: 2 });

    const outDir = jobDir(jobId);
    const framesDir = path.join(outDir, "frames");
    await mkdir(framesDir, { recursive: true });

    const info = await probeVideo(bins.ffprobe, videoPath);
    let startSec = Math.max(0, Math.min(p.frame_range.start_sec, info.duration || 0));
    let endSec =
      p.frame_range.end_sec && p.frame_range.end_sec > 0
        ? Math.min(p.frame_range.end_sec, info.duration || 0)
        : info.duration;
    if (endSec <= startSec) endSec = startSec + 1 / p.fps;

    const count = Math.min(
      p.max_frames,
      Math.max(1, Math.ceil(((endSec as number) - startSec) * p.fps)),
    );

    // 单趟提取：-ss 输入定位 + fps 滤镜，帧 i 的时间戳 = start + i/fps
    await runBin(bins.ffmpeg, [
      "-y",
      "-ss", String(startSec),
      "-i", videoPath,
      "-t", String((endSec as number) - startSec),
      "-vf", `fps=${p.fps}`,
      "-frames:v", String(count),
      "-vsync", "0",
      path.join(framesDir, "frame_%05d.png"),
    ]);
    const files = readdirSync(framesDir)
      .filter((f) => f.endsWith(".png"))
      .sort();
    if (files.length === 0) throw new ApiError(400, "未能从视频中提取到帧");

    const processed: { buffer: Buffer; t: number }[] = [];
    for (let i = 0; i < files.length; i++) {
      const raw = await loadFrame(path.join(framesDir, files[i]));
      const buffer = await processFrame(raw, p);
      processed.push({ buffer, t: Math.round((startSec + i / p.fps) * 1000) / 1000 });
      updateJob(jobId, {
        progress: 5 + Math.round(((i + 1) / files.length) * 80),
      });
    }
    await rm(framesDir, { recursive: true, force: true });

    // 合成 Sprite Sheet + 索引
    const cols = computeLayout(processed.length, p.layout_mode, p.columns);
    const rows = Math.ceil(processed.length / cols);
    const sheetW = cols * (p.target_size.w + p.spacing) - p.spacing;
    const sheetH = rows * (p.target_size.h + p.spacing) - p.spacing;
    const composites = processed.map((f, i) => ({
      input: f.buffer,
      left: (i % cols) * (p.target_size.w + p.spacing),
      top: Math.floor(i / cols) * (p.target_size.h + p.spacing),
    }));
    await sharp({
      create: {
        width: sheetW,
        height: sheetH,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .composite(composites)
      .png()
      .toFile(path.join(outDir, "sprite.png"));

    const index = {
      version: "1.0",
      frame_size: p.target_size,
      sheet_size: { w: sheetW, h: sheetH },
      frames: processed.map((f, i) => ({
        i,
        x: (i % cols) * (p.target_size.w + p.spacing),
        y: Math.floor(i / cols) * (p.target_size.h + p.spacing),
        w: p.target_size.w,
        h: p.target_size.h,
        t: f.t,
      })),
    };
    await writeFile(
      path.join(outDir, "index.json"),
      JSON.stringify(index, null, 2),
      "utf-8",
    );

    updateJob(jobId, {
      status: "completed",
      progress: 100,
      result: { frame_count: processed.length, width: sheetW, height: sheetH },
    });
  } catch (e) {
    const message = e instanceof ApiError ? e.message : String(e);
    updateJob(jobId, {
      status: "failed",
      error: { code: "PROCESSING_ERROR", message },
    });
  }
}

/* 路由注册 */

const uploadVideo = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const dir = jobDir(String(req.params.jobId));
      mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => cb(null, `upload${path.extname(file.originalname).toLowerCase() || ".mp4"}`),
  }),
  limits: { fileSize: 200 * 1024 * 1024 },
});

export function registerVideoRoutes(app: express.Express) {
  app.get("/api/video/capability", async (_req, res) =>
    res.json(await videoCapability()),
  );
  app.get("/api/video/jobs", (req, res) => {
    const rows = db
      .prepare(
        "SELECT * FROM video_jobs WHERE device_id=? ORDER BY created_at DESC LIMIT 50",
      )
      .all(req.device.id) as Record<string, unknown>[];
    res.json(rows.map(rowToJob));
  });
  app.post(
    "/api/video/jobs",
    (req: Request, res: Response, next: NextFunction) => {
      req.params.jobId = uid();
      next();
    },
    uploadVideo.single("file"),
    async (req, res) => {
      if (!req.file) throw new ApiError(400, "请上传视频文件");
      const ext = path.extname(req.file.originalname || "").toLowerCase();
      if (ext && !ALLOWED_VIDEO_EXTENSIONS.includes(ext))
        throw new ApiError(
          400,
          `不支持的格式，仅支持：${ALLOWED_VIDEO_EXTENSIONS.join("、")}`,
        );
      let params: VideoJobParams;
      try {
        params = videoParamsSchema.parse(JSON.parse(String(req.body.params || "{}")));
      } catch (e) {
        await rm(jobDir(String(req.params.jobId)), { recursive: true, force: true });
        throw new ApiError(400, `参数解析失败：${(e as Error).message}`);
      }
      const jobId = String(req.params.jobId);
      db.prepare(
        "INSERT INTO video_jobs(id,device_id,status,progress,params,result,error,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
      ).run(jobId, req.device.id, "queued", 0, JSON.stringify(params), null, null, now(), now());
      enqueueRun(jobId, req.device.id, path.join(jobDir(jobId), `upload${ext || ".mp4"}`));
      res.status(201).json({ job_id: jobId });
    },
  );
  app.get("/api/video/jobs/:id", (req, res) => {
    const job = getJob(req.params.id, req.device.id);
    res.json({
      ...job,
      videoReady: existsSync(path.join(jobDir(job.id), "upload.mp4")),
    });
  });
  app.get("/api/video/jobs/:id/result", async (req, res) => {
    const job = getJob(req.params.id, req.device.id);
    if (job.status !== "completed") throw new ApiError(400, "任务未完成");
    const spritePath = path.join(jobDir(job.id), "sprite.png");
    if (!existsSync(spritePath)) throw new ApiError(404, "结果文件不存在");
    if (req.query.format === "zip") {
      const { default: JSZip } = await import("jszip");
      const zip = new JSZip();
      zip.file("sprite.png", readFileSync(spritePath));
      zip.file("index.json", readFileSync(path.join(jobDir(job.id), "index.json")));
      const blob = await zip.generateAsync({ type: "nodebuffer" });
      res.attachment("sprite_sheet.zip").type("application/zip").send(blob);
      return;
    }
    res.type("image/png").sendFile(spritePath);
  });
  app.get("/api/video/jobs/:id/index", (req, res) => {
    const job = getJob(req.params.id, req.device.id);
    const indexPath = path.join(jobDir(job.id), "index.json");
    if (!existsSync(indexPath)) throw new ApiError(404, "结果不存在");
    res.type("application/json").sendFile(indexPath);
  });
  app.delete("/api/video/jobs/:id", async (req, res) => {
    getJob(req.params.id, req.device.id);
    db.prepare("DELETE FROM video_jobs WHERE id=?").run(req.params.id);
    await rm(jobDir(req.params.id), { recursive: true, force: true });
    res.json({ ok: true });
  });
}

export { getJob as getVideoJob };
