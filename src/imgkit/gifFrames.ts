import { parseGIF, decompressFrames } from "gifuct-js";
// @ts-expect-error gifenc 未提供类型声明
import * as gifenc from "gifenc";

// gifenc 的浏览器 ESM 与 Node CommonJS 入口导出方式不同。
const { GIFEncoder, quantize, applyPalette } = gifenc.GIFEncoder
  ? gifenc
  : gifenc.default;

export interface DecodedGifFrame {
  canvas: HTMLCanvasElement;
  delayMs: number;
}

export interface DecodedGif {
  width: number;
  height: number;
  frames: DecodedGifFrame[];
}

/** 透明 patch 像素不覆盖之前的画面；dispose 在当前帧显示完后处理。 */
function compositeFrame(
  prevBuf: Uint8ClampedArray<ArrayBuffer>,
  frame: {
    patch: Uint8ClampedArray;
    dims: { top: number; left: number; width: number; height: number };
  },
  width: number,
  height: number,
): Uint8ClampedArray<ArrayBuffer> {
  const buf = new Uint8ClampedArray(prevBuf);
  const { patch, dims } = frame;
  const { top, left, width: pw, height: ph } = dims;

  for (let py = 0; py < ph; py++) {
    for (let px = 0; px < pw; px++) {
      const idx = (py * pw + px) * 4;
      const a = patch[idx + 3];
      const outY = top + py;
      const outX = left + px;
      if (a !== 0 && outY >= 0 && outY < height && outX >= 0 && outX < width) {
        const outIdx = (outY * width + outX) * 4;
        buf.set(patch.subarray(idx, idx + 4), outIdx);
      }
    }
  }
  return buf;
}

function fillFrameArea(
  buffer: Uint8ClampedArray,
  dims: { top: number; left: number; width: number; height: number },
  width: number,
  height: number,
  color: number[],
) {
  for (
    let y = Math.max(0, dims.top);
    y < Math.min(height, dims.top + dims.height);
    y++
  ) {
    for (
      let x = Math.max(0, dims.left);
      x < Math.min(width, dims.left + dims.width);
      x++
    ) {
      buffer.set(color, (y * width + x) * 4);
    }
  }
}

/** 解码 GIF 为逐帧画布（已按原 GIF 帧延时记录 delayMs） */
export async function decodeGifToFrames(blob: Blob): Promise<DecodedGif> {
  const buf = await blob.arrayBuffer();
  const gif = parseGIF(buf);
  const frames = decompressFrames(gif, true);
  const width = gif.lsd.width;
  const height = gif.lsd.height;
  if (!frames.length) throw new Error("GIF 中没有可用帧");

  let prevBuf = new Uint8ClampedArray(width * height * 4);
  const background = gif.gct?.[gif.lsd.backgroundColorIndex];
  const backgroundFor = (transparentIndex: number | undefined) =>
    transparentIndex === undefined && background
      ? [...background, 255]
      : [0, 0, 0, 0];
  fillFrameArea(
    prevBuf,
    { top: 0, left: 0, width, height },
    width,
    height,
    backgroundFor(frames[0].transparentIndex),
  );
  const out: DecodedGifFrame[] = [];
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    const beforeFrame = prevBuf;
    prevBuf = compositeFrame(beforeFrame, frame, width, height);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("无法创建画布");
    const imgData = ctx.createImageData(width, height);
    imgData.data.set(prevBuf);
    ctx.putImageData(imgData, 0, 0);
    out.push({ canvas, delayMs: frame.delay ?? 100 });
    if (frame.disposalType === 2) {
      // 只恢复当前 patch 覆盖的区域，不能清掉画面中其它帧留下的内容。
      fillFrameArea(
        prevBuf,
        frame.dims,
        width,
        height,
        backgroundFor(frame.transparentIndex),
      );
    } else if (frame.disposalType === 3) {
      prevBuf = beforeFrame;
    }
  }
  return { width, height, frames: out };
}

/** 画布像素转 GIF 帧：量化到 ≤255 色 + 1bit 透明 */
function writeCanvasFrame(
  gif: ReturnType<typeof GIFEncoder>,
  canvas: HTMLCanvasElement,
  delayMs: number,
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法读取画布");
  const { data, width, height } = ctx.getImageData(
    0,
    0,
    canvas.width,
    canvas.height,
  );
  const palette = quantize(data, 255, {
    format: "rgba4444",
    oneBitAlpha: 128,
    clearAlpha: true,
    clearAlphaThreshold: 128,
  });
  const index = applyPalette(data, palette, "rgba4444");
  const transIdx = palette.findIndex((c: number[]) => c[3] === 0);
  let finalPalette: number[][];
  let finalIndex: Uint8Array;
  let transparentIndex: number;
  if (transIdx >= 0) {
    finalPalette = [...palette];
    finalIndex = index;
    transparentIndex = transIdx;
  } else {
    finalPalette = [[0, 0, 0, 0], ...palette];
    finalIndex = new Uint8Array(index.length);
    for (let j = 0; j < data.length; j += 4) {
      finalIndex[j / 4] = data[j + 3] < 128 ? 0 : index[j / 4] + 1;
    }
    transparentIndex = 0;
  }
  gif.writeFrame(finalIndex, width, height, {
    palette: finalPalette,
    delay: delayMs,
    transparent: true,
    transparentIndex,
  });
}

/** 将多张画布按统一延时编码为 GIF */
export async function encodeCanvasesToGif(
  canvases: HTMLCanvasElement[],
  delayMs: number,
): Promise<Blob> {
  if (canvases.length === 0) throw new Error("没有可编码的帧");
  const gif = GIFEncoder();
  for (const canvas of canvases)
    writeCanvasFrame(gif, canvas, Math.max(20, Math.round(delayMs)));
  gif.finish();
  return new Blob([gif.bytes()], { type: "image/gif" });
}

/** 把图片 Blob 绘制为画布（统一到首张尺寸，多余部分留白居中不缩放） */
export async function blobToCanvas(blob: Blob): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法创建画布");
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return canvas;
}

export async function blobsToCanvases(
  blobs: Blob[],
): Promise<HTMLCanvasElement[]> {
  const out: HTMLCanvasElement[] = [];
  for (const blob of blobs) out.push(await blobToCanvas(blob));
  return out;
}

export function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("画布导出失败"))),
      "image/png",
    );
  });
}
