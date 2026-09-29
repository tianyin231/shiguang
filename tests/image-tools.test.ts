import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import supertest from "supertest";
import sharp from "sharp";
import type { ImageAsset, Snapshot } from "../shared/types";
import type {
  ImageToolAnalysis,
  ImageToolOptions,
} from "../shared/image-tools";

const tempPrefix = path.resolve(os.tmpdir(), "image-tools-test-");
const temp = await mkdtemp(tempPrefix);
process.env.DATA_DIR = path.join(temp, "data");
process.env.OUTPUT_DIR = path.join(temp, "images");
const { createApp } = await import("../server/app");
const { db } = await import("../server/db");
const app = createApp();
const client = supertest.agent(app);
const stranger = supertest.agent(app);

const originalPixels = Buffer.alloc(12 * 8 * 3);
for (let y = 0; y < 8; y++) {
  for (let x = 0; x < 12; x++) {
    originalPixels.set([x * 17, y * 29, (x + y) * 11], (y * 12 + x) * 3);
  }
}
const original = await sharp(originalPixels, {
  raw: { width: 12, height: 8, channels: 3 },
})
  .png()
  .toBuffer();
let projectId: string;
let sessionId: string;
let source: ImageAsset;
let foreignSource: ImageAsset;
let foreignState: Snapshot;

before(async () => {
  await client.get("/api/config").expect(200);
  await stranger.get("/api/config").expect(200);
  const state: Snapshot = (await client.get("/api/state").expect(200)).body;
  projectId = state.projects[0].id;
  sessionId = state.sessions[0].id;
  foreignState = (await stranger.get("/api/state").expect(200)).body;
  source = (
    await client
      .post("/api/images/upload")
      .field("projectId", projectId)
      .field("sessionId", sessionId)
      .attach("image", original, "original.png")
      .expect(201)
  ).body;
  foreignSource = (
    await stranger
      .post("/api/images/upload")
      .field("projectId", foreignState.projects[0].id)
      .field("sessionId", foreignState.sessions[0].id)
      .attach("image", original, "foreign.png")
      .expect(201)
  ).body;
});

after(async () => {
  db.close();
  // 只清理由本测试 mkdtemp 创建、且位于系统临时目录下的目录。
  const resolved = path.resolve(temp);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.ok(
    resolved.startsWith(tempPrefix) && resolved.length > tempPrefix.length,
  );
  await rm(resolved, { recursive: true, force: true });
});

function processImage(options: ImageToolOptions, input = original) {
  return client
    .post("/api/image-tools/process")
    .field("options", JSON.stringify(options))
    .attach("image", input, "input.png")
    .buffer(true);
}

async function pixels(input: Buffer) {
  const { data, info } = await sharp(input)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    width: info.width,
    height: info.height,
    at(x: number, y: number) {
      return [
        ...data.subarray(
          (y * info.width + x) * 4,
          (y * info.width + x + 1) * 4,
        ),
      ];
    },
    data,
  };
}

test("格式转换生成真实 JPEG、WebP 和 AVIF 编码，尺寸响应头与文件一致", async () => {
  for (const format of ["jpeg", "webp", "avif"] as const) {
    const result = await processImage({
      tool: "convert",
      format,
      quality: 80,
    }).expect(200);
    assert.ok(Buffer.isBuffer(result.body));
    const metadata = await sharp(result.body).metadata();
    assert.equal(metadata.format, format === "avif" ? "heif" : format);
    if (format === "avif") assert.equal(metadata.compression, "av1");
    assert.equal(metadata.width, 12);
    assert.equal(metadata.height, 8);
    assert.match(
      result.headers["content-type"],
      new RegExp(`^image/${format}`),
    );
    assert.equal(result.headers["x-image-format"], format);
    assert.equal(Number(result.headers["x-image-width"]), metadata.width);
    assert.equal(Number(result.headers["x-image-height"]), metadata.height);
  }
});

test("按原图坐标裁剪后顺时针旋转，边角像素位置正确", async () => {
  const result = await processImage({
    tool: "crop",
    crop: { left: 2, top: 1, width: 4, height: 3 },
    rotation: 90,
  }).expect(200);
  const image = await pixels(result.body);
  assert.deepEqual([image.width, image.height], [3, 4]);
  assert.deepEqual(image.at(0, 0), [2 * 17, 3 * 29, 5 * 11, 255]);
  assert.deepEqual(image.at(2, 3), [5 * 17, 1 * 29, 6 * 11, 255]);
});

test("EXIF 转正后的坐标裁切，再旋转和镜像，保持选区及像素顺序", async () => {
  const oriented = await sharp(original)
    .withMetadata({ orientation: 6 })
    .png()
    .toBuffer();
  assert.equal((await sharp(oriented).metadata()).orientation, 6);
  const result = await processImage(
    {
      tool: "crop",
      crop: { left: 1, top: 2, width: 4, height: 3 },
      rotation: 90,
      flop: true,
    },
    oriented,
  ).expect(200);
  const image = await pixels(result.body);
  assert.deepEqual([image.width, image.height], [3, 4]);
  // 原始 12×8 像素先转正为 8×12，最终左右角分别来自原始 (2,6) 和 (4,3)。
  assert.deepEqual(image.at(0, 0), [2 * 17, 6 * 29, 8 * 11, 255]);
  assert.deepEqual(image.at(2, 3), [4 * 17, 3 * 29, 7 * 11, 255]);
});

test("contain 保留图片比例，并用指定颜色填充留白", async () => {
  const red = await sharp({
    create: { width: 20, height: 10, channels: 3, background: "#ff0000" },
  })
    .png()
    .toBuffer();
  const result = await processImage(
    {
      tool: "resize",
      resize: {
        width: 20,
        height: 20,
        fit: "contain",
        background: "#0000ff",
        withoutEnlargement: false,
      },
    },
    red,
  ).expect(200);
  const image = await pixels(result.body);
  assert.deepEqual([image.width, image.height], [20, 20]);
  assert.deepEqual(image.at(10, 0), [0, 0, 255, 255]);
  assert.deepEqual(image.at(10, 10), [255, 0, 0, 255]);
  assert.deepEqual(image.at(10, 19), [0, 0, 255, 255]);
});

test("水印转义特殊文本，透明画布上实际生成半透明文字", async () => {
  const blank = await sharp({
    create: { width: 240, height: 100, channels: 4, background: "#00000000" },
  })
    .png()
    .toBuffer();
  const result = await processImage(
    {
      tool: "watermark",
      watermark: {
        text: '<& "A">',
        fontSize: 24,
        color: "#ff3300",
        opacity: 0.5,
        position: "center",
        margin: 8,
      },
    },
    blank,
  ).expect(200);
  const image = await pixels(result.body);
  let visible = 0;
  let highestAlpha = 0;
  for (let i = 3; i < image.data.length; i += 4) {
    if (image.data[i] > 0) visible++;
    highestAlpha = Math.max(highestAlpha, image.data[i]);
  }
  assert.ok(visible > 20 && visible < (240 * 100) / 2);
  assert.ok(highestAlpha >= 100 && highestAlpha <= 135);
});

test("边框扩展画布，圆角保持外角透明与中央原图", async () => {
  const white = await sharp({
    create: { width: 16, height: 12, channels: 3, background: "#ffffff" },
  })
    .png()
    .toBuffer();
  const result = await processImage(
    {
      tool: "border",
      border: { padding: 4, background: "#ff0000", radius: 6 },
    },
    white,
  ).expect(200);
  const image = await pixels(result.body);
  assert.deepEqual([image.width, image.height], [24, 20]);
  assert.equal(image.at(0, 0)[3], 0);
  assert.equal(image.at(23, 19)[3], 0);
  assert.deepEqual(image.at(2, 10), [255, 0, 0, 255]);
  assert.deepEqual(image.at(12, 10), [255, 255, 255, 255]);
});

test("颜色分析忽略透明像素的 RGB，不把透明区域计入主色占比", async () => {
  const raw = Buffer.alloc(10 * 10 * 4);
  for (let i = 0; i < 100; i++) {
    raw.set(i < 40 ? [255, 0, 0, 255] : [0, 0, 255, 0], i * 4);
  }
  const input = await sharp(raw, {
    raw: { width: 10, height: 10, channels: 4 },
  })
    .png()
    .toBuffer();
  const result = await client
    .post("/api/image-tools/analyze")
    .attach("image", input, "palette.png")
    .expect(200);
  const analysis = result.body as ImageToolAnalysis;
  assert.deepEqual(
    [analysis.width, analysis.height, analysis.format],
    [10, 10, "png"],
  );
  assert.equal(analysis.bytes, input.length);
  assert.equal(analysis.hasAlpha, true);
  assert.equal(analysis.palette.length, 1);
  const hex = analysis.palette[0].hex.replace(/^#/, "");
  assert.ok(parseInt(hex.slice(0, 2), 16) > 200);
  assert.ok(
    parseInt(hex.slice(2, 4), 16) < 40 && parseInt(hex.slice(4, 6), 16) < 40,
  );
  assert.ok(analysis.palette[0].percent >= 99);
});

test("图库图片可直接处理，结果另存 PNG 并保留派生关系和原文件", async () => {
  const beforeBytes = await readFile(source.path);
  const result = await client
    .post("/api/image-tools/process")
    .field("imageId", source.id)
    .field(
      "options",
      JSON.stringify({ tool: "crop", rotation: 90, format: "webp" }),
    )
    .buffer(true)
    .expect(200);
  const saved: ImageAsset = (
    await client
      .post("/api/image-tools/save")
      .field("projectId", projectId)
      .field("sessionId", sessionId)
      .field("sourceImageId", source.id)
      .field("name", "旋转后的作品")
      .attach("image", result.body, "edited.webp")
      .expect(201)
  ).body;
  assert.notEqual(saved.id, source.id);
  assert.equal(saved.parentId, source.id);
  assert.equal(saved.projectId, projectId);
  assert.equal(saved.sessionId, sessionId);
  assert.deepEqual([saved.width, saved.height], [8, 12]);
  assert.equal(path.extname(saved.path), ".png");
  const stored = await readFile(saved.path);
  assert.equal((await sharp(stored).metadata()).format, "png");
  const sidecar: ImageAsset = JSON.parse(
    await readFile(saved.sidecarPath, "utf8"),
  );
  assert.equal(sidecar.parentId, source.id);
  const state: Snapshot = (await client.get("/api/state").expect(200)).body;
  assert.ok(
    state.images.some(
      (image) => image.id === saved.id && image.parentId === source.id,
    ),
  );
  assert.ok(state.images.some((image) => image.id === source.id));
  assert.deepEqual(await readFile(source.path), beforeBytes);
  await client
    .get(saved.url)
    .expect(200)
    .expect("Content-Type", /image\/png/);
});

test("工具接口拒绝跨设备图片、保存目标以及不匹配的项目会话", async () => {
  for (const endpoint of ["process", "analyze"]) {
    await stranger
      .post(`/api/image-tools/${endpoint}`)
      .field("imageId", source.id)
      .field("options", JSON.stringify({ tool: "convert" }))
      .expect(404);
  }
  await stranger
    .post("/api/image-tools/save")
    .field("projectId", projectId)
    .field("sessionId", sessionId)
    .attach("image", original, "output.png")
    .expect(404);
  await client
    .post("/api/image-tools/save")
    .field("projectId", projectId)
    .field("sessionId", sessionId)
    .field("sourceImageId", foreignSource.id)
    .attach("image", original, "output.png")
    .expect(404);
  const secondProject = await client
    .post("/api/projects")
    .send({ name: "另一个项目" })
    .expect(201);
  await client
    .post("/api/image-tools/save")
    .field("projectId", projectId)
    .field("sessionId", secondProject.body.session.id)
    .attach("image", original, "output.png")
    .expect(400);
});

test("无效选项和越界裁剪返回可读的 400 错误", async () => {
  const invalidOptions = [
    "{broken",
    JSON.stringify({ tool: "resize", resize: { width: 0, fit: "inside" } }),
    JSON.stringify({
      tool: "crop",
      crop: { left: 11, top: 0, width: 8, height: 4 },
    }),
  ];
  for (const options of invalidOptions) {
    const result = await client
      .post("/api/image-tools/process")
      .field("options", options)
      .attach("image", original, "input.png")
      .expect(400);
    assert.equal(typeof result.body.error, "string");
    assert.ok(result.body.error.length > 0);
  }
});
