/** 块平均像素化：先整图缩小到块级，再禁用平滑放大回原尺寸 */
export function pixelateCanvas(
  source: HTMLImageElement | HTMLCanvasElement,
  pixelSize: number,
): Promise<Blob> {
  const w = source instanceof HTMLImageElement ? source.naturalWidth : source.width;
  const h = source instanceof HTMLImageElement ? source.naturalHeight : source.height;
  const block = Math.max(1, Math.floor(pixelSize));
  const scaledW = Math.max(1, Math.floor(w / block));
  const scaledH = Math.max(1, Math.floor(h / block));

  const small = document.createElement("canvas");
  small.width = scaledW;
  small.height = scaledH;
  small.getContext("2d")?.drawImage(source, 0, 0, w, h, 0, 0, scaledW, scaledH);

  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const ctx = out.getContext("2d");
  if (!ctx) return Promise.reject(new Error("无法创建画布"));
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(small, 0, 0, scaledW, scaledH, 0, 0, w, h);
  return new Promise<Blob>((resolve, reject) => {
    out.toBlob((b) => (b ? resolve(b) : reject(new Error("画布导出失败"))), "image/png");
  });
}
