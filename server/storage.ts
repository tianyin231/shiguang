import { mkdir, writeFile, readFile, unlink, access } from "node:fs/promises";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { all, settings, uid, now, put } from "./db";
import type { ImageAsset, Task } from "../shared/types";
import { ApiError } from "./providers";

export async function writableDirectory(dir: string) {
  const resolved = path.resolve(dir);
  await mkdir(resolved, { recursive: true });
  const test = path.join(resolved, ".write-" + uid());
  await writeFile(test, "");
  await unlink(test);
  return resolved;
}
export async function saveImage(
  deviceId: string,
  buffer: Buffer,
  task: Pick<
    Task,
    | "projectId"
    | "sessionId"
    | "prompt"
    | "effectivePrompt"
    | "modelName"
    | "params"
    | "currency"
    | "costSource"
  > &
    Partial<Task>,
): Promise<ImageAsset> {
  const config = settings(deviceId);
  const root = await writableDirectory(config.outputDir);
  const png = await sharp(buffer, { limitInputPixels: 100_000_000 })
    .rotate()
    .png()
    .toBuffer();
  const metadata = await sharp(png).metadata();
  const sha = createHash("sha256").update(png).digest("hex");
  const existing = all<ImageAsset>("images", deviceId);
  const bytes = png.length;
  if (
    existing.reduce((n, i) => n + i.bytes, 0) + bytes >
    config.quotaMB * 1024 * 1024
  )
    throw new ApiError(413, "图片存储配额不足，请清理淘汰图片或增加配额");
  const id = uid();
  const values: Record<string, string> = {
    date: new Date().toISOString().slice(0, 10),
    model: task.modelName.replace(/[^a-zA-Z0-9._-]/g, "_"),
    prompt_hash: createHash("sha256")
      .update(task.prompt)
      .digest("hex")
      .slice(0, 12),
    seed: String(task.params.seed ?? "auto"),
    id,
  };
  let name = config.filenameTemplate.replace(
    /\{(date|model|prompt_hash|seed|id)\}/g,
    (_, key: string) => values[key],
  );
  if (!config.filenameTemplate.includes("{id}"))
    name = name.replace(/(\.[^./\\]+)?$/, "-" + id + ".png");
  name = name.replace(/\.[^./\\]+$/, ".png");
  const dest = path.resolve(root, name);
  if (!dest.startsWith(root + path.sep))
    throw new ApiError(400, "文件名模板必须位于输出目录内");
  await mkdir(path.dirname(dest), { recursive: true });
  let file = dest;
  const duplicate = existing.find((i) => i.sha === sha);
  if (duplicate) {
    try {
      await access(duplicate.path);
      file = duplicate.path;
    } catch {}
  }
  if (file === dest) await writeFile(file, png, { flag: "wx" });
  const thumbnailPath = path.join(path.dirname(dest), id + ".thumb.webp");
  await sharp(png)
    .resize(480, 480, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: 80 })
    .toFile(thumbnailPath);
  const sidecarPath = path.join(path.dirname(dest), id + ".json");
  const asset: ImageAsset = {
    id,
    projectId: task.projectId,
    sessionId: task.sessionId,
    taskId: task.id,
    parentId: task.parentImageId,
    path: file,
    thumbnailPath,
    sidecarPath,
    sha,
    bytes,
    width: metadata.width || 0,
    height: metadata.height || 0,
    prompt: task.prompt,
    effectivePrompt: task.effectivePrompt,
    model: task.modelName,
    params: task.params,
    rating: 0,
    favorite: false,
    discarded: false,
    cost: task.actualCost ?? task.estimatedCost ?? 0,
    costSource: task.costSource,
    currency: task.currency,
    createdAt: now(),
    url: `/api/images/${id}/file`,
    thumbnailUrl: `/api/images/${id}/thumbnail`,
  };
  await writeFile(sidecarPath, JSON.stringify(asset, null, 2));
  return asset;
}
export async function updateSidecar(image: ImageAsset) {
  await writeFile(image.sidecarPath, JSON.stringify(image, null, 2));
}
// 调用者必须持有 SQLite 写事务，避免并发完成的同内容图片绕过去重/配额。
export function commitImage(deviceId: string, image: ImageAsset) {
  const existing = all<ImageAsset>("images", deviceId);
  if (
    existing.reduce((n, i) => n + i.bytes, 0) + image.bytes >
    settings(deviceId).quotaMB * 1024 * 1024
  )
    throw new ApiError(413, "图片存储配额不足");
  const duplicate = existing.find(
    (i) => i.sha === image.sha && existsSync(i.path),
  );
  if (duplicate && duplicate.path !== image.path) {
    const redundant = image.path;
    image.path = duplicate.path;
    if (!existing.some((i) => i.path === redundant)) unlinkSync(redundant);
  }
  writeFileSync(image.sidecarPath, JSON.stringify(image, null, 2));
  put("images", deviceId, image, {
    project_id: image.projectId,
    sha: image.sha,
  });
}
export async function deleteFiles(image: ImageAsset, remaining: ImageAsset[]) {
  for (const file of [
    image.sidecarPath,
    image.thumbnailPath,
    ...(remaining.some((i) => i.path === image.path) ? [] : [image.path]),
  ])
    await unlink(file).catch((e) => {
      if (e.code !== "ENOENT") throw e;
    });
}
export async function dataUrl(image: ImageAsset) {
  return (
    "data:image/png;base64," + (await readFile(image.path)).toString("base64")
  );
}
