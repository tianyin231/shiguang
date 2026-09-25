import { useEffect, useRef, useState } from "react";
import { Button, Empty, Field } from "./components";
import { useStore } from "./store";
import { api } from "./api";
import {
  applyChromaKey,
  applyChromaKeyContiguousFromTopLeft,
  getTopLeftPixelColor,
} from "./imgkit/chromaUtils";
import {
  splitSpriteSheetGrid,
  composeSpriteSheetGrid,
  findDuplicateFrameIndexGroups,
} from "./imgkit/spriteGridDuplicate";
import { superSplitByTransparent } from "./imgkit/superSplitTransparent";
import { stitchImageBlobs } from "./imgkit/simpleStitchVertical";
import { removeGeminiWatermarkFromBlob } from "./imgkit/geminiWatermark";
import {
  decodeGifToFrames,
  encodeCanvasesToGif,
  blobsToCanvases,
  canvasToBlob,
  type DecodedGif,
} from "./imgkit/gifFrames";
import { pixelateCanvas } from "./imgkit/pixelate";

const IMAGE_ACCEPT = "image/png,image/jpeg,image/webp,image/gif";

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function baseName(name: string) {
  return name.replace(/\.[^.]+$/, "") || "image";
}

/** 把画布转为预览 URL；组件卸载时由调用方 revoke */
async function canvasToUrl(canvas: HTMLCanvasElement): Promise<string> {
  const blob = await canvasToBlob(canvas);
  return URL.createObjectURL(blob);
}

function useRevocableUrls() {
  const refs = useRef<string[]>([]);
  const track = (url: string) => {
    refs.current.push(url);
    return url;
  };
  useEffect(
    () => () => {
      refs.current.forEach((u) => URL.revokeObjectURL(u));
    },
    [],
  );
  return track;
}

function FilePick({
  label,
  accept = IMAGE_ACCEPT,
  multiple = false,
  onFiles,
}: {
  label: string;
  accept?: string;
  multiple?: boolean;
  onFiles: (files: File[]) => void;
}) {
  return (
    <label className="toolbox-file btn secondary">
      <input
        type="file"
        accept={accept}
        multiple={multiple}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length) onFiles(files);
          e.target.value = "";
        }}
      />
      {label}
    </label>
  );
}

function Preview({ src, alt }: { src: string | null; alt: string }) {
  if (!src) return null;
  return (
    <figure className="toolbox-preview checker">
      <img src={src} alt={alt} />
    </figure>
  );
}

/* ---------------- 色度键抠图 ---------------- */

function MatteTab() {
  const s = useStore();
  const track = useRevocableUrls();
  const [file, setFile] = useState<File | null>(null);
  const [srcUrl, setSrcUrl] = useState<string | null>(null);
  const [bg, setBg] = useState({ r: 0, g: 255, b: 0 });
  const [tolerance, setTolerance] = useState(80);
  const [feather, setFeather] = useState(5);
  const [mode, setMode] = useState<"global" | "contiguous">("contiguous");
  const [result, setResult] = useState<string | null>(null);
  const [resultBlob, setResultBlob] = useState<Blob | null>(null);
  const [busy, setBusy] = useState(false);

  const pick = async (files: File[]) => {
    const f = files[0];
    setFile(f);
    setResult(null);
    setResultBlob(null);
    setSrcUrl((old) => {
      if (old) URL.revokeObjectURL(old);
      return URL.createObjectURL(f);
    });
    try {
      const c = await getTopLeftPixelColor(f);
      setBg(c);
    } catch {
      /* 读不到首像素时保留当前取色 */
    }
  };

  const run = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result as string);
        r.onerror = () => reject(new Error("读取文件失败"));
        r.readAsDataURL(file);
      });
      const out =
        mode === "global"
          ? await applyChromaKey(dataUrl, bg.r, bg.g, bg.b, tolerance, feather)
          : await applyChromaKeyContiguousFromTopLeft(
              dataUrl,
              bg.r,
              bg.g,
              bg.b,
              tolerance,
              feather,
            );
      setResultBlob(out.blob);
      setResult(track(URL.createObjectURL(out.blob)));
    } catch (e) {
      s.set({ error: `抠图失败：${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="toolbox-grid">
      <div className="toolbox-controls">
        <FilePick label={file ? "换一张图" : "选择图片"} onFiles={pick} />
        {file && (
          <>
            <Field label="抠图模式" hint="连通域只清除与左上角相连的背景，适合保护主体同色区域">
              <select value={mode} onChange={(e) => setMode(e.target.value as "global" | "contiguous")}>
                <option value="contiguous">连通域（左上角）</option>
                <option value="global">全局色键</option>
              </select>
            </Field>
            <Field label="背景色" hint="默认取图片左上角第一像素">
              <input
                type="color"
                value={`#${[bg.r, bg.g, bg.b].map((v) => v.toString(16).padStart(2, "0")).join("")}`}
                onChange={(e) => {
                  const v = e.target.value;
                  setBg({
                    r: parseInt(v.slice(1, 3), 16),
                    g: parseInt(v.slice(3, 5), 16),
                    b: parseInt(v.slice(5, 7), 16),
                  });
                }}
              />
            </Field>
            <Field label={`容差 ${tolerance}`}>
              <input type="range" min={0} max={160} value={tolerance}
                onChange={(e) => setTolerance(Number(e.target.value))} />
            </Field>
            <Field label={`羽化 ${feather}`}>
              <input type="range" min={0} max={30} value={feather}
                onChange={(e) => setFeather(Number(e.target.value))} />
            </Field>
            <Button variant="primary" onClick={run} disabled={busy}>
              {busy ? "处理中…" : "开始抠图"}
            </Button>
            {resultBlob && (
              <Button
                onClick={() =>
                  download(resultBlob, `${baseName(file.name)}_matte.png`)
                }
              >
                下载透明 PNG
              </Button>
            )}
          </>
        )}
      </div>
      <div className="toolbox-stage">
        {!file ? (
          <Empty title="从一张带纯色背景的图开始">
            绿幕、蓝幕或任意纯色底图都可以。全程在浏览器本地完成，不经过任何接口。
          </Empty>
        ) : (
          <>
            <Preview src={srcUrl} alt="原图" />
            <Preview src={result} alt="抠图结果" />
          </>
        )}
      </div>
    </div>
  );
}

/* ---------------- GIF 工具 ---------------- */

type GifSub = "split" | "toGif" | "compose" | "stitch";

function GifTab() {
  const s = useStore();
  const track = useRevocableUrls();
  const [sub, setSub] = useState<GifSub>("split");
  const [gif, setGif] = useState<DecodedGif | null>(null);
  const [gifName, setGifName] = useState("");
  const [thumbs, setThumbs] = useState<string[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const [delayMs, setDelayMs] = useState(100);
  const [cols, setCols] = useState(8);
  const [stitchMode, setStitchMode] = useState<0 | 1 | 2>(0);
  const [result, setResult] = useState<string | null>(null);
  const [resultBlob, setResultBlob] = useState<Blob | null>(null);
  const [busy, setBusy] = useState(false);

  const resetResult = () => {
    setResult(null);
    setResultBlob(null);
  };

  const openGif = async (picked: File[]) => {
    const f = picked[0];
    setBusy(true);
    resetResult();
    try {
      const decoded = await decodeGifToFrames(f);
      setGif(decoded);
      setGifName(baseName(f.name));
      setThumbs((old) => {
        old.forEach(URL.revokeObjectURL);
        return [];
      });
      setThumbs(
        await Promise.all(
          decoded.frames.slice(0, 24).map((fr) => canvasToUrl(fr.canvas).then(track)),
        ),
      );
    } catch (e) {
      s.set({ error: `GIF 解码失败：${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="toolbox-subtabs">
        {(
          [
            ["split", "GIF 拆帧"],
            ["toGif", "帧转 GIF"],
            ["compose", "多图合成单图"],
            ["stitch", "简易拼接"],
          ] as [GifSub, string][]
        ).map(([id, label]) => (
          <button
            key={id}
            className={sub === id ? "active" : ""}
            onClick={() => {
              setSub(id);
              resetResult();
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="toolbox-grid">
        <div className="toolbox-controls">
          {sub === "split" && (
            <>
              <FilePick
                label="选择 GIF"
                accept="image/gif"
                onFiles={(f) => void openGif(f)}
              />
              {gif && (
                <Button
                  variant="primary"
                  onClick={async () => {
                    setBusy(true);
                    try {
                      const { default: JSZip } = await import("jszip");
                      const zip = new JSZip();
                      for (let i = 0; i < gif.frames.length; i++) {
                        zip.file(
                          `frame_${String(i).padStart(3, "0")}.png`,
                          await canvasToBlob(gif.frames[i].canvas),
                        );
                      }
                      const zipBlob = await zip.generateAsync({ type: "blob" });
                      download(zipBlob, `${gifName}_frames.zip`);
                    } catch (e) {
                      s.set({ error: `打包失败：${(e as Error).message}` });
                    } finally {
                      setBusy(false);
                    }
                  }}
                  disabled={busy}
                >
                  下载 {gif.frames.length} 帧（ZIP）
                </Button>
              )}
            </>
          )}
          {sub === "toGif" && (
            <>
              <FilePick multiple label="选择多张图片" onFiles={(f) => { setFiles(f); resetResult(); }} />
              <Field label={`每帧延时 ${delayMs} ms`} hint="约等于每秒 1000 ÷ 延时 帧">
                <input type="range" min={40} max={1000} step={20} value={delayMs}
                  onChange={(e) => setDelayMs(Number(e.target.value))} />
              </Field>
              <Button
                variant="primary"
                disabled={busy || files.length === 0}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const canvases = await blobsToCanvases(files);
                    const blob = await encodeCanvasesToGif(canvases, delayMs);
                    setResultBlob(blob);
                    setResult(track(URL.createObjectURL(blob)));
                    s.toast(`已合成 ${canvases.length} 帧 GIF`);
                  } catch (e) {
                    s.set({ error: `编码失败：${(e as Error).message}` });
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                合成 GIF
              </Button>
            </>
          )}
          {sub === "compose" && (
            <>
              <FilePick multiple label="选择多张等大图片" onFiles={(f) => { setFiles(f); resetResult(); }} />
              <Field label={`每行列数 ${cols}`}>
                <input type="range" min={1} max={16} value={cols}
                  onChange={(e) => setCols(Number(e.target.value))} />
              </Field>
              <Button
                variant="primary"
                disabled={busy || files.length === 0}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const canvases = await blobsToCanvases(files);
                    const sheet = composeSpriteSheetGrid(canvases, cols);
                    const blob = await canvasToBlob(sheet);
                    setResultBlob(blob);
                    setResult(track(URL.createObjectURL(blob)));
                  } catch (e) {
                    s.set({ error: `合成失败：${(e as Error).message}` });
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                合成单图
              </Button>
            </>
          )}
          {sub === "stitch" && (
            <>
              <FilePick multiple label="选择多张图片" onFiles={(f) => { setFiles(f); resetResult(); }} />
              <Field label="拼接方向">
                <select value={stitchMode} onChange={(e) => setStitchMode(Number(e.target.value) as 0 | 1 | 2)}>
                  <option value={0}>上下</option>
                  <option value={1}>左右</option>
                  <option value={2}>同尺寸叠画</option>
                </select>
              </Field>
              <Button
                variant="primary"
                disabled={busy || files.length === 0}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const blob = await stitchImageBlobs(files, stitchMode);
                    setResultBlob(blob);
                    setResult(track(URL.createObjectURL(blob)));
                  } catch (e) {
                    s.set({ error: `拼接失败：${(e as Error).message}` });
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                开始拼接
              </Button>
            </>
          )}
          {resultBlob && (
            <Button onClick={() => download(resultBlob, `toolbox_result_${Date.now()}.${resultBlob.type === "image/gif" ? "gif" : "png"}`)}>
              下载结果
            </Button>
          )}
        </div>
        <div className="toolbox-stage">
          {sub === "split" && gif && (
            <div className="toolbox-frames">
              {thumbs.map((u, i) => (
                <img key={i} src={u} alt={`第 ${i + 1} 帧`} className="checker" />
              ))}
            </div>
          )}
          {sub !== "split" && <Preview src={result} alt="结果" />}
          {(sub !== "split" || !gif) && !result && files.length > 0 && !busy && (
            <p className="toolbox-hint">已选 {files.length} 张图片，设置好参数后点击左侧按钮。</p>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------------- 精灵图工具 ---------------- */

function SpriteTab() {
  const s = useStore();
  const track = useRevocableUrls();
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [fileName, setFileName] = useState("");
  const [cols, setCols] = useState(4);
  const [rows, setRows] = useState(4);
  const [cells, setCells] = useState<HTMLCanvasElement[]>([]);
  const [thumbs, setThumbs] = useState<string[]>([]);
  const [dupInfo, setDupInfo] = useState<number[][]>([]);
  const [delayMs, setDelayMs] = useState(100);
  const [busy, setBusy] = useState(false);

  const openImage = async (picked: File[]) => {
    const f = picked[0];
    const url = URL.createObjectURL(f);
    try {
      const image = new Image();
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error("图片读取失败"));
        image.src = url;
      });
      setImg(image);
      setFileName(baseName(f.name));
      setCells([]);
      setThumbs((old) => {
        old.forEach(URL.revokeObjectURL);
        return [];
      });
      setDupInfo([]);
    } finally {
      URL.revokeObjectURL(url);
    }
  };

  const showCells = async (list: HTMLCanvasElement[]) => {
    thumbs.forEach(URL.revokeObjectURL);
    setThumbs(await Promise.all(list.slice(0, 32).map((c) => canvasToUrl(c).then(track))));
    setCells(list);
    const groups = findDuplicateFrameIndexGroups(list).filter((g) => g.length > 1);
    setDupInfo(groups);
  };

  return (
    <div className="toolbox-grid">
      <div className="toolbox-controls">
        <FilePick label={img ? "换一张精灵图" : "选择精灵图"} onFiles={(f) => void openImage(f)} />
        {img && (
          <>
            <Field label={`列数 ${cols}`}>
              <input type="range" min={1} max={24} value={cols}
                onChange={(e) => setCols(Number(e.target.value))} />
            </Field>
            <Field label={`行数 ${rows}`}>
              <input type="range" min={1} max={24} value={rows}
                onChange={(e) => setRows(Number(e.target.value))} />
            </Field>
            <div className="toolbox-row">
              <Button
                variant="primary"
                disabled={busy}
                onClick={() => showCells(splitSpriteSheetGrid(img, cols, rows))}
              >
                网格拆分
              </Button>
              <Button
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const parts = await superSplitByTransparent(img, fileName);
                    await showCells(await blobsToCanvases(parts));
                  } catch (e) {
                    s.set({ error: `拆分失败：${(e as Error).message}` });
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                透明间隙拆分
              </Button>
            </div>
            {cells.length > 0 && (
              <>
                <p className="toolbox-hint">
                  共 {cells.length} 帧
                  {dupInfo.length > 0 &&
                    `，重复组 ${dupInfo.length} 个（${dupInfo
                      .slice(0, 3)
                      .map((g) => g.map((i) => i + 1).join("＝"))
                      .join("、")}${dupInfo.length > 3 ? "…" : ""}）`}
                </p>
                <Field label={`合成列数 ${cols}`}>
                  <input type="range" min={1} max={16} value={cols}
                    onChange={(e) => setCols(Number(e.target.value))} />
                </Field>
                <div className="toolbox-row">
                  <Button
                    onClick={async () => {
                      const sheet = composeSpriteSheetGrid(cells, cols);
                      download(await canvasToBlob(sheet), `${fileName}_sheet.png`);
                    }}
                  >
                    合成精灵图
                  </Button>
                  <Button
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        const blob = await encodeCanvasesToGif(cells, delayMs);
                        download(blob, `${fileName}_anim.gif`);
                        s.toast("已按当前帧顺序导出 GIF");
                      } catch (e) {
                        s.set({ error: `导出失败：${(e as Error).message}` });
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    导出 GIF
                  </Button>
                </div>
                <Field label={`GIF 每帧延时 ${delayMs} ms`}>
                  <input type="range" min={40} max={1000} step={20} value={delayMs}
                    onChange={(e) => setDelayMs(Number(e.target.value))} />
                </Field>
              </>
            )}
          </>
        )}
      </div>
      <div className="toolbox-stage">
        {!img ? (
          <Empty title="把序列帧图交给我">
            支持按列行均分拆分，或沿完全透明的行列间隙智能拆帧，拆完可重排合成、检测重复帧。
          </Empty>
        ) : cells.length === 0 ? (
          <p className="toolbox-hint">图片 {img.naturalWidth} × {img.naturalHeight}，选择拆分方式开始。</p>
        ) : (
          <div className="toolbox-frames">
            {thumbs.map((u, i) => (
              <img key={i} src={u} alt={`帧 ${i + 1}`} className="checker" />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------- 像素化 ---------------- */

function PixelTab() {
  const s = useStore();
  const track = useRevocableUrls();
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [fileName, setFileName] = useState("");
  const [block, setBlock] = useState(8);
  const [result, setResult] = useState<string | null>(null);
  const [resultBlob, setResultBlob] = useState<Blob | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (image: HTMLImageElement, size: number) => {
    setBusy(true);
    try {
      const blob = await pixelateCanvas(image, size);
      setResultBlob(blob);
      setResult((old) => {
        if (old) URL.revokeObjectURL(old);
        return track(URL.createObjectURL(blob));
      });
    } catch (e) {
      s.set({ error: `像素化失败：${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="toolbox-grid">
      <div className="toolbox-controls">
        <FilePick
          label={img ? "换一张图" : "选择图片"}
          onFiles={async (files) => {
            const f = files[0];
            const url = URL.createObjectURL(f);
            try {
              const image = new Image();
              await new Promise<void>((resolve, reject) => {
                image.onload = () => resolve();
                image.onerror = () => reject(new Error("图片读取失败"));
                image.src = url;
              });
              setImg(image);
              setFileName(baseName(f.name));
              setResult(null);
              setResultBlob(null);
              await run(image, block);
            } catch (e) {
              s.set({ error: (e as Error).message });
            } finally {
              URL.revokeObjectURL(url);
            }
          }}
        />
        {img && (
          <>
            <Field label={`像素块 ${block} px`} hint="越大越粗糙，原图尺寸保持不变">
              <input type="range" min={2} max={32} value={block}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setBlock(v);
                  void run(img, v);
                }} />
            </Field>
            {resultBlob && (
              <Button onClick={() => download(resultBlob, `${fileName}_pixel.png`)}>
                下载 PNG
              </Button>
            )}
          </>
        )}
      </div>
      <div className="toolbox-stage">
        {!img ? (
          <Empty title="把图片变成像素块风格">
            拖动滑块实时调整颗粒大小，全部在浏览器本地完成。
          </Empty>
        ) : (
          <>
            <Preview src={img.src} alt="原图" />
            <Preview src={result} alt="像素化结果" />
          </>
        )}
      </div>
    </div>
  );
}

/* ---------------- 去水印 ---------------- */

function WatermarkTab() {
  const s = useStore();
  const track = useRevocableUrls();
  const [file, setFile] = useState<File | null>(null);
  const [srcUrl, setSrcUrl] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [resultBlob, setResultBlob] = useState<Blob | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <div className="toolbox-grid">
      <div className="toolbox-controls">
        <FilePick
          label={file ? "换一张图" : "选择 Gemini 生成图"}
          onFiles={(files) => {
            const f = files[0];
            setFile(f);
            setResult(null);
            setResultBlob(null);
            setSrcUrl((old) => {
              if (old) URL.revokeObjectURL(old);
              return URL.createObjectURL(f);
            });
          }}
        />
        {file && (
          <Button
            variant="primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const blob = await removeGeminiWatermarkFromBlob(file);
                setResultBlob(blob);
                setResult(track(URL.createObjectURL(blob)));
                s.toast("水印已按反向 alpha 修复");
              } catch (e) {
                s.set({ error: `去水印失败：${(e as Error).message}` });
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "处理中…" : "移除水印"}
          </Button>
        )}
        {resultBlob && file && (
          <Button onClick={() => download(resultBlob, `${baseName(file.name)}_clean.png`)}>
            下载 PNG
          </Button>
        )}
        <p className="toolbox-hint">
          识别 48 / 96 px 两种规格的 Gemini 星形水印并做反向 alpha 修复，
          纯本地像素运算，不调用任何接口。
        </p>
      </div>
      <div className="toolbox-stage">
        {!file ? (
          <Empty title="清理 AI 生成图上的可见水印">
            把 Gemini 生成的图片拖进来，右下角星形水印会被就地修复，其余像素保持原样。
          </Empty>
        ) : (
          <>
            <Preview src={srcUrl} alt="原图" />
            <Preview src={result} alt="去水印结果" />
          </>
        )}
      </div>
    </div>
  );
}

/* ---------------- 视频拆帧（服务端管线） ---------------- */

interface VideoJobView {
  id: string;
  status: "queued" | "processing" | "completed" | "failed";
  progress: number;
  error: { code: string; message: string } | null;
  result: { frame_count: number; width: number; height: number } | null;
}

function VideoTab() {
  const s = useStore();
  const [capability, setCapability] = useState<{
    ffmpeg: boolean;
    ffprobe: boolean;
    aiMatte: boolean;
  } | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [job, setJob] = useState<VideoJobView | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const [params, setParams] = useState({
    fps: 12,
    start_sec: 0,
    end_sec: "",
    max_frames: 300,
    target_w: 256,
    target_h: 256,
    padding: 4,
    spacing: 4,
    layout_mode: "fixed_columns" as "fixed_columns" | "auto_square",
    columns: 12,
    matte_mode: "chroma" as "none" | "chroma" | "ai",
    chroma_color: "#00ff00",
    chroma_tolerance: 80,
    crop_mode: "tight_bbox" as "none" | "tight_bbox" | "safe_bbox",
  });
  const set = <K extends keyof typeof params>(key: K, value: (typeof params)[K]) =>
    setParams((p) => ({ ...p, [key]: value }));

  useEffect(() => {
    api<{ ffmpeg: boolean; ffprobe: boolean; aiMatte: boolean }>(
      "/video/capability",
    )
      .then(setCapability)
      .catch(() => setCapability({ ffmpeg: false, ffprobe: false, aiMatte: false }));
    return () => clearInterval(timer.current);
  }, []);

  const poll = (jobId: string) => {
    clearInterval(timer.current);
    timer.current = setInterval(async () => {
      try {
        const next = await api<VideoJobView>(`/video/jobs/${jobId}`);
        setJob(next);
        if (next.status === "completed") {
          clearInterval(timer.current);
          s.toast(`拆帧完成：${next.result?.frame_count} 帧`);
        }
        if (next.status === "failed") {
          clearInterval(timer.current);
          s.set({ error: next.error?.message || "处理失败" });
        }
      } catch {
        /* 下个轮询周期重试 */
      }
    }, 900);
  };

  const submit = async () => {
    if (!file) return;
    setBusy(true);
    setJob(null);
    try {
      const body = new FormData();
      body.append("file", file);
      body.append(
        "params",
        JSON.stringify({
          fps: params.fps,
          frame_range: {
            start_sec: params.start_sec,
            end_sec: params.end_sec ? Number(params.end_sec) : null,
          },
          max_frames: params.max_frames,
          target_size: { w: params.target_w, h: params.target_h },
          transparent: params.matte_mode !== "none",
          padding: params.padding,
          spacing: params.spacing,
          layout_mode: params.layout_mode,
          columns: params.columns,
          matte_mode: params.matte_mode,
          chroma_color: params.chroma_color,
          chroma_tolerance: params.chroma_tolerance,
          crop_mode: params.crop_mode,
        }),
      );
      const { job_id } = await api<{ job_id: string }>("/video/jobs", {
        method: "POST",
        body,
      });
      setJob({
        id: job_id,
        status: "queued",
        progress: 0,
        error: null,
        result: null,
      });
      poll(job_id);
    } catch (e) {
      s.set({ error: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  if (capability && !capability.ffmpeg)
    return (
      <Empty title="本机还没找到 FFmpeg">
        视频拆帧由本地后端完成，需要 FFmpeg 支持。安装后重启拾光即可：
        在项目根目录运行 npm i ffmpeg-static ffprobe-static（已自动安装时检查
        FFMPEG_PATH 环境变量是否指向了错误位置），或从 ffmpeg.org 安装并加入 PATH。
      </Empty>
    );

  const running = job?.status === "queued" || job?.status === "processing";

  return (
    <div className="toolbox-grid">
      <div className="toolbox-controls">
        <FilePick
          label={file ? file.name : "选择视频"}
          accept=".mp4,.mov,.webm,.avi,.mkv,video/mp4,video/quicktime,video/webm"
          onFiles={(f) => {
            setFile(f[0]);
            setJob(null);
          }}
        />
        <Field label={`每秒帧数 ${params.fps}`}>
          <input type="range" min={1} max={30} value={params.fps}
            onChange={(e) => set("fps", Number(e.target.value))} />
        </Field>
        <div className="toolbox-row">
          <Field label="开始秒">
            <input type="number" min={0} step={0.1} value={params.start_sec}
              onChange={(e) => set("start_sec", Number(e.target.value))} />
          </Field>
          <Field label="结束秒（留空到结尾）">
            <input type="number" min={0} step={0.1} value={params.end_sec}
              onChange={(e) => set("end_sec", e.target.value)} />
          </Field>
        </div>
        <div className="toolbox-row">
          <Field label="目标宽">
            <input type="number" min={16} max={1024} value={params.target_w}
              onChange={(e) => set("target_w", Number(e.target.value))} />
          </Field>
          <Field label="目标高">
            <input type="number" min={16} max={1024} value={params.target_h}
              onChange={(e) => set("target_h", Number(e.target.value))} />
          </Field>
        </div>
        <Field label="抠图方式" hint={capability && !capability.aiMatte ? "AI 抠图需安装可选组件 @imgly/background-removal-node" : undefined}>
          <select value={params.matte_mode}
            onChange={(e) => set("matte_mode", e.target.value as "none" | "chroma" | "ai")}>
            <option value="chroma">色度键（绿幕/蓝幕）</option>
            <option value="none">不抠图</option>
            <option value="ai" disabled={capability ? !capability.aiMatte : false}>
              AI 抠图{capability && !capability.aiMatte ? "（未安装）" : ""}
            </option>
          </select>
        </Field>
        {params.matte_mode === "chroma" && (
          <div className="toolbox-row">
            <Field label="幕布颜色">
              <input type="color" value={params.chroma_color}
                onChange={(e) => set("chroma_color", e.target.value)} />
            </Field>
            <Field label={`容差 ${params.chroma_tolerance}`}>
              <input type="range" min={10} max={200} value={params.chroma_tolerance}
                onChange={(e) => set("chroma_tolerance", Number(e.target.value))} />
            </Field>
          </div>
        )}
        <Field label="构图方式">
          <select value={params.layout_mode}
            onChange={(e) => set("layout_mode", e.target.value as "fixed_columns" | "auto_square")}>
            <option value="fixed_columns">固定列数</option>
            <option value="auto_square">自动方形</option>
          </select>
        </Field>
        {params.layout_mode === "fixed_columns" && (
          <Field label={`列数 ${params.columns}`}>
            <input type="range" min={1} max={32} value={params.columns}
              onChange={(e) => set("columns", Number(e.target.value))} />
          </Field>
        )}
        <Field label="裁切方式">
          <select value={params.crop_mode}
            onChange={(e) => set("crop_mode", e.target.value as "none" | "tight_bbox" | "safe_bbox")}>
            <option value="tight_bbox">紧贴主体</option>
            <option value="safe_bbox">保留边距</option>
            <option value="none">不裁切</option>
          </select>
        </Field>
        <Button variant="primary" disabled={busy || !file || running} onClick={submit}>
          {running ? "处理中…" : busy ? "上传中…" : "开始拆帧"}
        </Button>
      </div>
      <div className="toolbox-stage">
        {!job ? (
          <Empty title="上传视频，本地生成序列帧表">
            后端用 FFmpeg 按设定帧率抽帧，自动抠图、裁切、对齐成 Sprite Sheet，
            并输出与原项目一致的索引 JSON。任务在本机排队处理。
          </Empty>
        ) : running ? (
          <div className="toolbox-progress">
            <p>{job.status === "queued" ? "排队中…" : `处理中 ${job.progress}%`}</p>
            <div className="toolbox-bar">
              <i style={{ width: `${Math.max(4, job.progress)}%` }} />
            </div>
          </div>
        ) : job.status === "failed" ? (
          <p className="toolbox-hint">处理失败：{job.error?.message}</p>
        ) : (
          <div className="toolbox-video-result">
            <p className="toolbox-hint">
              共 {job.result?.frame_count} 帧 · 表尺寸 {job.result?.width} × {job.result?.height}
            </p>
            <figure className="toolbox-preview checker">
              <img src={`/api/video/jobs/${job.id}/result?format=png`} alt="Sprite Sheet" />
            </figure>
            <div className="toolbox-row">
              <a className="btn primary" href={`/api/video/jobs/${job.id}/result?format=png`} download="sprite.png">
                下载序列帧表
              </a>
              <a className="btn secondary" href={`/api/video/jobs/${job.id}/result?format=zip`} download="sprite_sheet.zip">
                下载 ZIP（含索引）
              </a>
              <a className="btn secondary" href={`/api/video/jobs/${job.id}/index`} download="index.json" target="_blank" rel="noreferrer">
                查看索引 JSON
              </a>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------- 页面 ---------------- */

type ToolboxTab = "matte" | "gif" | "sprite" | "pixel" | "watermark" | "video";

const TABS: [ToolboxTab, string, string][] = [
  ["matte", "色度键抠图", "绿幕蓝幕一键去背"],
  ["gif", "GIF 工具", "拆帧、合成与拼接"],
  ["sprite", "精灵图", "序列帧拆分与重组"],
  ["pixel", "像素化", "块平均像素风格"],
  ["watermark", "去水印", "清理 Gemini 水印"],
  ["video", "视频拆帧", "上传视频生成序列帧表"],
];

export default function ToolboxPage() {
  const [tab, setTab] = useState<ToolboxTab>("matte");
  return (
    <div className="toolbox">
      <header className="toolbox-head">
        <h1>图像工具箱</h1>
        <p>从像素处理工具集移植的本地处理管线，全部在你的浏览器里完成。</p>
      </header>
      <div className="toolbox-tabs">
        {TABS.map(([id, label, hint]) => (
          <button
            key={id}
            className={tab === id ? "active" : ""}
            onClick={() => setTab(id)}
          >
            <strong>{label}</strong>
            <small>{hint}</small>
          </button>
        ))}
      </div>
      {tab === "matte" && <MatteTab />}
      {tab === "gif" && <GifTab />}
      {tab === "sprite" && <SpriteTab />}
      {tab === "pixel" && <PixelTab />}
      {tab === "watermark" && <WatermarkTab />}
      {tab === "video" && <VideoTab />}
    </div>
  );
}
