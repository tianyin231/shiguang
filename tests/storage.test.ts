import { after, test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import type { ImageAsset } from "../shared/types";

const tempPrefix = path.resolve(os.tmpdir(), "image-storage-test-");
const temp = await mkdtemp(tempPrefix);
process.env.DATA_DIR = path.join(temp, "data");
process.env.OUTPUT_DIR = path.join(temp, "images");
const { all, createDevice, db, put, remove, transaction } =
  await import("../server/db");
const { commitImage, deleteFiles, saveImage } =
  await import("../server/storage");
const image = await sharp({
  create: { width: 16, height: 12, channels: 3, background: "#b96549" },
})
  .png()
  .toBuffer();

function save(deviceId: string) {
  return saveImage(deviceId, image, {
    projectId: "project-" + deviceId,
    sessionId: "session-" + deviceId,
    prompt: "图片存储测试",
    effectivePrompt: "",
    modelName: "local-test",
    params: { size: "auto", quality: "auto" },
    currency: "USD",
    costSource: "estimate",
  });
}

function storageDevice() {
  const device = createDevice();
  const project = {
    id: "project-" + device.id,
    name: "存储测试",
    canvas: { nodes: [], edges: [] },
    revision: 0,
    createdAt: Date.now(),
  };
  const session = {
    id: "session-" + device.id,
    projectId: project.id,
    title: "测试",
    messages: [],
    summary: "",
    createdAt: Date.now(),
  };
  put("projects", device.id, project);
  put("sessions", device.id, session, { project_id: project.id });
  return device;
}

after(async () => {
  db.close();
  const resolved = path.resolve(temp);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.ok(
    resolved.startsWith(tempPrefix) && resolved.length > tempPrefix.length,
  );
  await rm(resolved, { recursive: true, force: true });
});

test("同内容图片保存后、提交前清理旧图，新图仍有有效原文件", async () => {
  const device = storageDevice();
  const original = await save(device.id);
  transaction(() => commitImage(device.id, original));
  const pending = await save(device.id);

  // 重现异步保存与图库 GC 的交错：新图尚未进入数据库，旧图已经被清理。
  await deleteFiles(original, []);
  remove("images", original.id, device.id);
  transaction(() => commitImage(device.id, pending));

  assert.equal(all<ImageAsset>("images", device.id).length, 1);
  const metadata = await sharp(await readFile(pending.path)).metadata();
  assert.equal(metadata.width, 16);
  assert.equal(metadata.height, 12);
  await access(pending.thumbnailPath);
  await access(pending.sidecarPath);
});

test("图库清理进行中提交相同图片，清理不会删掉新记录共享的原图", async () => {
  const device = storageDevice();
  const original = await save(device.id);
  transaction(() => commitImage(device.id, original));
  const pending = await save(device.id);

  // deleteFiles 已获取旧引用快照，暂停在第一个异步 unlink 时提交新副本。
  const deleting = deleteFiles(original, []);
  transaction(() => commitImage(device.id, pending));
  assert.equal(pending.path, original.path);
  await deleting;
  remove("images", original.id, device.id);

  assert.equal(all<ImageAsset>("images", device.id).length, 1);
  assert.equal(
    (await sharp(await readFile(pending.path)).metadata()).width,
    16,
  );
});

test("提交时正常去重，删除一个副本保留唯一原图，删除最后副本才释放文件", async () => {
  const device = storageDevice();
  const original = await save(device.id);
  transaction(() => commitImage(device.id, original));
  const duplicate = await save(device.id);
  const temporaryPath = duplicate.path;
  transaction(() => commitImage(device.id, duplicate));

  assert.equal(duplicate.path, original.path);
  assert.equal(all<ImageAsset>("images", device.id).length, 2);
  await access(original.path);
  await assert.rejects(access(temporaryPath), { code: "ENOENT" });

  await deleteFiles(original, [duplicate]);
  remove("images", original.id, device.id);
  await access(duplicate.path);
  await access(duplicate.thumbnailPath);
  await assert.rejects(access(original.thumbnailPath), { code: "ENOENT" });

  await deleteFiles(duplicate, []);
  remove("images", duplicate.id, device.id);
  await assert.rejects(access(duplicate.path), { code: "ENOENT" });
});
