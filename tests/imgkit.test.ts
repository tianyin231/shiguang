import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
// @ts-expect-error gifenc 未提供类型声明
import gifenc from "gifenc";
import { decodeGifToFrames } from "../src/imgkit/gifFrames";
import {
  composeSpriteSheetGrid,
  splitSpriteSheetGrid,
} from "../src/imgkit/spriteGridDuplicate";

// 仅实现这些纯像素工具需要的 Canvas 操作，不引入浏览器测试依赖。
class MemoryCanvas {
  width = 0;
  height = 0;
  private buffer = new Uint8ClampedArray(0);
  get naturalWidth() {
    return this.width;
  }
  get naturalHeight() {
    return this.height;
  }
  get pixels() {
    if (this.buffer.length !== this.width * this.height * 4)
      this.buffer = new Uint8ClampedArray(this.width * this.height * 4);
    return this.buffer;
  }
  getContext() {
    return {
      imageSmoothingEnabled: false,
      createImageData: (width: number, height: number) => ({
        data: new Uint8ClampedArray(width * height * 4),
      }),
      putImageData: (image: { data: Uint8ClampedArray }) =>
        this.pixels.set(image.data),
      drawImage: (source: MemoryCanvas, ...coordinates: number[]) => {
        const [sx, sy, width, height, dx, dy, outputWidth, outputHeight] =
          coordinates.length === 2
            ? [
                0,
                0,
                source.width,
                source.height,
                ...coordinates,
                source.width,
                source.height,
              ]
            : coordinates;
        assert.equal(width, outputWidth);
        assert.equal(height, outputHeight);
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const input = ((sy + y) * source.width + sx + x) * 4;
            const output = ((dy + y) * this.width + dx + x) * 4;
            this.pixels.set(source.pixels.subarray(input, input + 4), output);
          }
        }
      },
    };
  }
}

const originalDocument = Object.getOwnPropertyDescriptor(
  globalThis,
  "document",
);
before(() =>
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { createElement: () => new MemoryCanvas() },
  }),
);
after(() => {
  if (originalDocument)
    Object.defineProperty(globalThis, "document", originalDocument);
  else Reflect.deleteProperty(globalThis, "document");
});

type GifFrame = { pixels: number[]; dispose: number; transparent?: boolean };
function gifBytes(frames: GifFrame[]) {
  const gif = gifenc.GIFEncoder();
  for (const frame of frames)
    gif.writeFrame(new Uint8Array(frame.pixels), frame.pixels.length, 1, {
      palette: [
        [255, 0, 0],
        [0, 0, 255],
        [0, 0, 0],
      ],
      delay: 100,
      dispose: frame.dispose,
      transparent: frame.transparent ?? false,
      transparentIndex: 2,
    });
  gif.finish();
  return Buffer.from(gif.bytes());
}

async function decodedPixels(bytes: Buffer) {
  const decoded = await decodeGifToFrames(
    new Blob([new Uint8Array(bytes)], { type: "image/gif" }),
  );
  return {
    decoded,
    pixels: Buffer.concat(
      decoded.frames.map((frame) =>
        Buffer.from((frame.canvas as unknown as MemoryCanvas).pixels),
      ),
    ),
  };
}

test("GIF 的透明 patch 保留前一帧像素，拆帧与原生 GIF 解码一致", async () => {
  const bytes = gifBytes([
    { pixels: [0, 0], dispose: 1 },
    { pixels: [2, 1], dispose: 1, transparent: true },
  ]);
  const result = await decodedPixels(bytes);
  const expected = await sharp(bytes, { animated: true })
    .ensureAlpha()
    .raw()
    .toBuffer();
  assert.deepEqual(result.pixels, expected);
  assert.deepEqual(
    [...result.pixels.subarray(8)],
    [255, 0, 0, 255, 0, 0, 255, 255],
  );
  assert.deepEqual(
    result.decoded.frames.map((frame) => frame.delayMs),
    [100, 100],
  );
});

test("GIF 显示完当前帧才处置局部区域，并支持恢复背景与恢复上一画面", async () => {
  for (const [dispose, transparent] of [
    [2, false],
    [2, true],
    [3, true],
  ] as const) {
    const bytes = gifBytes([
      { pixels: [0, 0, 0], dispose: 1 },
      { pixels: [1], dispose, transparent },
      { pixels: [2, 2, 1], dispose: 1, transparent: true },
    ]);
    const result = await decodedPixels(bytes);
    const expected = await sharp(bytes, { animated: true })
      .ensureAlpha()
      .raw()
      .toBuffer();
    assert.deepEqual(
      result.pixels,
      expected,
      `dispose=${dispose}, transparent=${transparent}`,
    );
    // 中间像素不在局部 patch 内，所有帧都应保留为红色。
    for (let frame = 0; frame < 3; frame++)
      assert.deepEqual(
        [...result.pixels.subarray(frame * 12 + 4, frame * 12 + 8)],
        [255, 0, 0, 255],
      );
  }
});

test("非整除精灵图拆分后能合成，尺寸差用透明补齐且完整保留每帧像素", () => {
  const source = new MemoryCanvas();
  source.width = source.height = 101;
  for (let y = 0; y < 101; y++)
    for (let x = 0; x < 101; x++)
      source.pixels.set([x, y, x + y, 255], (y * 101 + x) * 4);
  const cells = splitSpriteSheetGrid(
    source as unknown as HTMLImageElement,
    4,
    4,
  );
  assert.equal(cells.length, 16);
  const composed = composeSpriteSheetGrid(cells, 4) as unknown as MemoryCanvas;
  assert.deepEqual([composed.width, composed.height], [104, 104]);
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i] as unknown as MemoryCanvas;
    for (let y = 0; y < cell.height; y++) {
      const start = ((Math.floor(i / 4) * 26 + y) * 104 + (i % 4) * 26) * 4;
      assert.deepEqual(
        composed.pixels.subarray(start, start + cell.width * 4),
        cell.pixels.subarray(y * cell.width * 4, (y + 1) * cell.width * 4),
      );
    }
  }
  assert.equal(composed.pixels[(0 * 104 + 25) * 4 + 3], 0);
  assert.deepEqual(
    [...composed.pixels.subarray((103 * 104 + 103) * 4)],
    [100, 100, 200, 255],
  );
});
