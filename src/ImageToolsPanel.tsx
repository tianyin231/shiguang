import { useCallback, useEffect, useRef, useState } from "react";
import Cropper from "cropperjs";
import JSZip from "jszip";
import {
  Download,
  FolderOpen,
  ImageIcon,
  Settings2,
  Upload,
  X,
} from "lucide-react";
import { api, apiBlob } from "./api";
import { Busy, Button, Empty, Field, Modal } from "./components";
import { useStore } from "./store";
import type { ImageAsset } from "../shared/types";
import type {
  ImageOutputFormat,
  ImageToolAnalysis,
  ImageToolOptions,
} from "../shared/image-tools";

type Mode = ImageToolOptions["tool"] | "palette" | "info";
type CropArea = NonNullable<ImageToolOptions["crop"]>;
type Source = {
  id: string;
  name: string;
  url: string;
  file?: File;
  imageId?: string;
  projectId?: string;
  width: number;
  height: number;
  bytes: number;
};
type Result = {
  id: string;
  source: Source;
  signature: string;
  blob?: Blob;
  url?: string;
  width: number;
  height: number;
  format: string;
  analysis?: ImageToolAnalysis;
  saved?: boolean;
};

const MODES: { id: Mode; name: string; description: string }[] = [
  {
    id: "crop",
    name: "裁剪旋转",
    description: "框选保留的画面，再旋转或翻转。每次处理当前选中的一张。",
  },
  {
    id: "resize",
    name: "尺寸调整",
    description: "统一长宽、缩小大图，或为整批图片补齐相同比例。",
  },
  {
    id: "convert",
    name: "压缩转换",
    description: "批量转换格式、调整质量，比较处理前后的文件大小。",
  },
  {
    id: "adjust",
    name: "调色滤镜",
    description: "统一明暗、饱和度和对比度，也可以转为黑白或柔化画面。",
  },
  {
    id: "border",
    name: "边框补边",
    description: "为图片四周留白、增加底色，并设置圆角。",
  },
  {
    id: "watermark",
    name: "文字水印",
    description: "给整批图片加上署名、日期或简短的文字水印。",
  },
  {
    id: "palette",
    name: "配色提取",
    description: "提取画面的主要颜色，复制色值或导出可复用的色板。",
  },
  {
    id: "info",
    name: "图片信息",
    description: "查看尺寸、格式、透明通道和元数据标记。",
  },
];

const MAX_SOURCES = 20;
const ACCEPT = "image/png,image/jpeg,image/webp,image/avif";
const baseName = (name: string) => name.replace(/\.[^.]+$/, "") || "image";
const fileSize = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1024 / 1024).toFixed(2)} MB`;
const resultName = (result: Result) =>
  `${baseName(result.source.name)}-处理.${result.format === "jpeg" ? "jpg" : result.format}`;

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function sourceFromAsset(image: ImageAsset): Source {
  return {
    id: `gallery:${image.id}`,
    imageId: image.id,
    projectId: image.projectId,
    name: image.path.split(/[\\/]/).pop() || `${image.id}.png`,
    url: image.url,
    width: image.width,
    height: image.height,
    bytes: image.bytes,
  };
}

function sourceForm(source: Source) {
  const form = new FormData();
  if (source.file) form.append("image", source.file);
  else if (source.imageId) form.append("imageId", source.imageId);
  return form;
}

function CropPreview({
  source,
  ratio,
  disabled,
  onCrop,
  onError,
}: {
  source: Source;
  ratio: string;
  disabled: boolean;
  onCrop: (id: string, area: CropArea | null) => void;
  onError: (message: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const instance = useRef<Cropper | null>(null);

  useEffect(() => {
    if (!host.current) return;
    const element = new Image();
    element.src = source.url;
    element.alt = source.name;
    const cropper = new Cropper(element, {
      container: host.current,
      template:
        '<cropper-canvas background theme-color="#b96549"><cropper-image initial-fit="contain" scalable translatable></cropper-image><cropper-shade hidden></cropper-shade><cropper-handle action="select" plain></cropper-handle><cropper-selection movable resizable precise><cropper-grid role="grid" bordered covered></cropper-grid><cropper-crosshair centered></cropper-crosshair><cropper-handle action="move" theme-color="rgba(255,255,255,.25)"></cropper-handle><cropper-handle action="n-resize"></cropper-handle><cropper-handle action="e-resize"></cropper-handle><cropper-handle action="s-resize"></cropper-handle><cropper-handle action="w-resize"></cropper-handle><cropper-handle action="ne-resize"></cropper-handle><cropper-handle action="nw-resize"></cropper-handle><cropper-handle action="se-resize"></cropper-handle><cropper-handle action="sw-resize"></cropper-handle></cropper-selection></cropper-canvas>',
    });
    instance.current = cropper;
    const canvas = cropper.getCropperCanvas()!;
    const image = cropper.getCropperImage()!;
    const selection = cropper.getCropperSelection()!;
    selection.aspectRatio = ratio === "free" ? NaN : Number(ratio);
    let ready = false;
    let disposed = false;
    let lastCrop: CropArea | null = null;
    onCrop(source.id, null);

    const bounds = () => {
      const frame = canvas.getBoundingClientRect();
      const rect = image.getBoundingClientRect();
      return {
        left: rect.left - frame.left,
        top: rect.top - frame.top,
        width: rect.width,
        height: rect.height,
      };
    };
    const changed = (event: Event) => {
      if (!ready) return;
      const area = (
        event as CustomEvent<{
          x: number;
          y: number;
          width: number;
          height: number;
        }>
      ).detail;
      const rect = bounds();
      if (!rect.width || !rect.height || !area.width || !area.height) return;
      if (
        area.x < rect.left - 0.5 ||
        area.y < rect.top - 0.5 ||
        area.x + area.width > rect.left + rect.width + 0.5 ||
        area.y + area.height > rect.top + rect.height + 0.5
      ) {
        event.preventDefault();
        return;
      }
      // 图片固定为 contain 显示且禁止变换，选框坐标可直接映射到 EXIF 转正后的像素。
      const width = image.$image.naturalWidth;
      const height = image.$image.naturalHeight;
      const left = Math.max(
        0,
        Math.min(
          width - 1,
          Math.round(((area.x - rect.left) / rect.width) * width),
        ),
      );
      const top = Math.max(
        0,
        Math.min(
          height - 1,
          Math.round(((area.y - rect.top) / rect.height) * height),
        ),
      );
      lastCrop = {
        left,
        top,
        width: Math.max(
          1,
          Math.min(width - left, Math.round((area.width / rect.width) * width)),
        ),
        height: Math.max(
          1,
          Math.min(
            height - top,
            Math.round((area.height / rect.height) * height),
          ),
        ),
      };
      onCrop(source.id, lastCrop);
    };
    selection.addEventListener("change", changed);
    const fit = () => {
      if (!ready || disposed || !canvas.clientWidth) return;
      const previous = lastCrop;
      image.scalable = true;
      image.translatable = true;
      image.$resetTransform().$center("contain");
      image.scalable = false;
      image.translatable = false;
      const rect = bounds();
      let width = rect.width;
      let height = rect.height;
      if (previous) {
        selection.$change(
          rect.left + (previous.left / image.$image.naturalWidth) * width,
          rect.top + (previous.top / image.$image.naturalHeight) * height,
          (previous.width / image.$image.naturalWidth) * width,
          (previous.height / image.$image.naturalHeight) * height,
        );
        return;
      }
      if (Number.isFinite(selection.aspectRatio)) {
        width = Math.min(width, height * selection.aspectRatio);
        height = width / selection.aspectRatio;
      }
      selection.$change(
        rect.left + (rect.width - width) / 2,
        rect.top + (rect.height - height) / 2,
        width,
        height,
      );
    };
    const observer = new ResizeObserver(fit);
    image
      .$ready()
      .then(() => {
        if (disposed) return;
        ready = true;
        fit();
        observer.observe(canvas);
      })
      .catch(() => {
        if (!disposed)
          onError("无法读取这张图片，请换一张 PNG、JPEG、WebP 或 AVIF 图片。");
      });
    return () => {
      disposed = true;
      observer.disconnect();
      selection.removeEventListener("change", changed);
      cropper.destroy();
      instance.current = null;
    };
  }, [source.id, source.url, source.name, ratio, onCrop, onError]);

  useEffect(() => {
    const canvas = instance.current?.getCropperCanvas();
    if (canvas) canvas.disabled = disabled;
  }, [disabled, source.id, ratio]);

  return (
    <div
      ref={host}
      className="image-tools-cropper"
      aria-label="拖动选框裁剪图片"
    />
  );
}

export function ImageToolsPanel() {
  const store = useStore();
  const [mode, setMode] = useState<Mode>("crop");
  const [sources, setSources] = useState<Source[]>([]);
  const sourcesRef = useRef<Source[]>([]);
  sourcesRef.current = sources;
  const [selectedId, setSelectedId] = useState("");
  const [results, setResults] = useState<Result[]>([]);
  const [resultId, setResultId] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [running, setRunning] = useState(false);
  const [adding, setAdding] = useState(false);
  const [savingId, setSavingId] = useState("");
  const [packing, setPacking] = useState(false);
  const [progress, setProgress] = useState({
    done: 0,
    total: 0,
    name: "",
    stopped: false,
  });
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [galleryIds, setGalleryIds] = useState<string[]>([]);
  const [ratio, setRatio] = useState("free");
  const [cropValue, setCropValue] = useState<{
    sourceId: string;
    area: CropArea;
  } | null>(null);
  const [rotation, setRotation] = useState<0 | 90 | 180 | 270>(0);
  const [flip, setFlip] = useState(false);
  const [flop, setFlop] = useState(false);
  const [format, setFormat] = useState<ImageOutputFormat>("png");
  const [quality, setQuality] = useState(82);
  const [width, setWidth] = useState("1024");
  const [height, setHeight] = useState("");
  const [fit, setFit] =
    useState<NonNullable<ImageToolOptions["resize"]>["fit"]>("inside");
  const [background, setBackground] = useState("#ffffff");
  const [withoutEnlargement, setWithoutEnlargement] = useState(true);
  const [adjust, setAdjust] = useState<NonNullable<ImageToolOptions["adjust"]>>(
    {
      brightness: 1,
      saturation: 1,
      contrast: 1,
      blur: 0,
      sharpen: 0,
      grayscale: false,
    },
  );
  const [padding, setPadding] = useState(32);
  const [radius, setRadius] = useState(0);
  const [watermark, setWatermark] = useState<
    NonNullable<ImageToolOptions["watermark"]>
  >({
    text: "",
    fontSize: 36,
    color: "#ffffff",
    opacity: 0.7,
    position: "southeast",
    margin: 24,
  });
  const controller = useRef<AbortController | null>(null);
  const urls = useRef(new Set<string>());
  const alive = useRef(true);
  const consumedRequest = useRef(0);
  const selected =
    sources.find((source) => source.id === selectedId) || sources[0];
  const result = results.find((item) => item.id === resultId) || results[0];
  const saveProjectMismatch = Boolean(
    result?.source.projectId && result.source.projectId !== store.projectId,
  );
  const analysisMode = mode === "palette" || mode === "info";
  const busy = running || adding;
  const description = MODES.find((item) => item.id === mode)!.description;
  const gallery = store.data.images.filter(
    (image) => image.projectId === store.projectId && !image.discarded,
  );

  const trackUrl = (blob: Blob) => {
    const url = URL.createObjectURL(blob);
    urls.current.add(url);
    return url;
  };
  const revokeUrl = (url?: string) => {
    if (url && urls.current.delete(url)) URL.revokeObjectURL(url);
  };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      controller.current?.abort();
      urls.current.forEach((url) => URL.revokeObjectURL(url));
      urls.current.clear();
    };
  }, []);

  const addAssets = useCallback((assets: ImageAsset[]) => {
    const previous = sourcesRef.current;
    const additions = assets
      .map(sourceFromAsset)
      .filter((source) => !previous.some((item) => item.id === source.id))
      .slice(0, MAX_SOURCES - previous.length);
    if (additions.length) {
      const next = [...previous, ...additions];
      sourcesRef.current = next;
      setSources(next);
      setSelectedId(additions[0].id);
    } else if (
      assets[0] &&
      previous.some((item) => item.imageId === assets[0].id)
    ) {
      setSelectedId(`gallery:${assets[0].id}`);
    }
    if (assets.length && !additions.length && previous.length >= MAX_SOURCES)
      setError("每批最多 20 张，请先移除部分素材。");
  }, []);

  useEffect(() => {
    if (
      !store.toolboxRequest ||
      consumedRequest.current === store.toolboxRequest ||
      !store.toolboxImageIds.length
    )
      return;
    consumedRequest.current = store.toolboxRequest;
    const assets = store.toolboxImageIds
      .map((id) => store.data.images.find((image) => image.id === id))
      .filter((image): image is ImageAsset => Boolean(image));
    addAssets(assets);
    store.set({ toolboxImageIds: [] });
  }, [
    store.toolboxRequest,
    store.toolboxImageIds,
    store.data.images,
    store.set,
    addAssets,
  ]);

  const onCrop = useCallback((sourceId: string, area: CropArea | null) => {
    setCropValue((previous) =>
      area
        ? previous?.sourceId === sourceId &&
          JSON.stringify(previous.area) === JSON.stringify(area)
          ? previous
          : { sourceId, area }
        : null,
    );
  }, []);

  const options: ImageToolOptions | null = analysisMode
    ? null
    : {
        tool: mode,
        format,
        quality,
        ...(mode === "crop"
          ? {
              crop:
                cropValue && cropValue.sourceId === selected?.id
                  ? cropValue.area
                  : undefined,
              rotation,
              flip,
              flop,
            }
          : {}),
        ...(mode === "resize"
          ? {
              resize: {
                width: Number(width) || undefined,
                height: Number(height) || undefined,
                fit,
                background,
                withoutEnlargement,
              },
            }
          : {}),
        ...(mode === "adjust" ? { adjust } : {}),
        ...(mode === "border"
          ? { border: { padding, background, radius } }
          : {}),
        ...(mode === "watermark" ? { watermark } : {}),
      };
  const signature = JSON.stringify({ mode, options });
  const stale = Boolean(result && result.signature !== signature);

  async function addFiles(files: File[]) {
    setAdding(true);
    setError("");
    const available = MAX_SOURCES - sourcesRef.current.length;
    const accepted = files.slice(0, available);
    const additions: Source[] = [];
    const failed: string[] = [];
    for (const file of accepted) {
      if (!alive.current) break;
      const url = trackUrl(file);
      try {
        const image = new Image();
        image.src = url;
        await image.decode();
        if (!alive.current) {
          revokeUrl(url);
          break;
        }
        additions.push({
          id: crypto.randomUUID(),
          name: file.name,
          file,
          url,
          width: image.naturalWidth,
          height: image.naturalHeight,
          bytes: file.size,
        });
      } catch {
        revokeUrl(url);
        failed.push(file.name);
      }
    }
    if (alive.current) {
      const next = [...sourcesRef.current, ...additions].slice(0, MAX_SOURCES);
      additions
        .filter((item) => !next.includes(item))
        .forEach((item) => revokeUrl(item.url));
      sourcesRef.current = next;
      setSources(next);
      if (additions.length) setSelectedId(additions[0].id);
      setError(
        [
          files.length > available
            ? "每批最多 20 张，已加入可容纳的图片。"
            : "",
          failed.length ? `无法读取：${failed.join("、")}` : "",
        ]
          .filter(Boolean)
          .join(" "),
      );
      setAdding(false);
    }
  }

  function clearResults() {
    results.forEach((item) => revokeUrl(item.url));
    setResults([]);
    setResultId("");
    setErrors([]);
    setProgress({ done: 0, total: 0, name: "", stopped: false });
  }

  function removeSource(id: string) {
    revokeUrl(
      sources.find((item) => item.id === id)?.file
        ? sources.find((item) => item.id === id)?.url
        : undefined,
    );
    results
      .filter((item) => item.source.id === id)
      .forEach((item) => revokeUrl(item.url));
    setResults((previous) => previous.filter((item) => item.source.id !== id));
    const next = sources.filter((item) => item.id !== id);
    sourcesRef.current = next;
    setSources(next);
    if (selectedId === id) setSelectedId(next[0]?.id || "");
  }

  async function process() {
    if (!selected || running) return;
    if (mode === "crop" && cropValue?.sourceId !== selected.id) {
      setError("请等图片加载完成后框选裁剪区域。");
      return;
    }
    if (mode === "resize" && !Number(width) && !Number(height)) {
      setError("请至少填写宽度或高度。");
      return;
    }
    if (mode === "watermark" && !watermark.text.trim()) {
      setError("请先填写水印文字。");
      return;
    }
    clearResults();
    setError("");
    setRunning(true);
    const batch = mode === "crop" ? [selected] : [...sources];
    const request = new AbortController();
    controller.current = request;
    const completed: Result[] = [];
    let done = 0;
    setProgress({ done, total: batch.length, name: "", stopped: false });
    try {
      for (const source of batch) {
        if (request.signal.aborted) break;
        setProgress({
          done,
          total: batch.length,
          name: source.name,
          stopped: false,
        });
        try {
          const form = sourceForm(source);
          let item: Result;
          if (analysisMode) {
            const analysis = await api<ImageToolAnalysis>(
              "/image-tools/analyze",
              { method: "POST", body: form, signal: request.signal },
            );
            item = {
              id: crypto.randomUUID(),
              source,
              signature,
              width: analysis.width,
              height: analysis.height,
              format: analysis.format,
              analysis,
            };
          } else {
            form.append("options", JSON.stringify(options));
            const { blob, headers } = await apiBlob("/image-tools/process", {
              method: "POST",
              body: form,
              signal: request.signal,
            });
            if (request.signal.aborted) break;
            item = {
              id: crypto.randomUUID(),
              source,
              signature,
              blob,
              url: trackUrl(blob),
              width: Number(headers.get("X-Image-Width")),
              height: Number(headers.get("X-Image-Height")),
              format: headers.get("X-Image-Format") || format,
            };
          }
          if (request.signal.aborted) break;
          completed.push(item);
          setResults([...completed]);
          if (completed.length === 1) setResultId(item.id);
        } catch (failure) {
          if (request.signal.aborted) break;
          setErrors((previous) => [
            ...previous,
            `${source.name}：${(failure as Error).message}`,
          ]);
        }
        done += 1;
      }
    } finally {
      if (alive.current) {
        setProgress({
          done,
          total: batch.length,
          name: "",
          stopped: request.signal.aborted,
        });
        setRunning(false);
      }
      if (controller.current === request) controller.current = null;
    }
  }

  async function saveResult(item: Result) {
    if (!item.blob || !store.projectId || !store.sessionId) return;
    setSavingId(item.id);
    try {
      const form = new FormData();
      form.append("image", item.blob, resultName(item));
      form.append("projectId", store.projectId);
      form.append("sessionId", store.sessionId);
      form.append("name", baseName(resultName(item)));
      if (item.source.imageId)
        form.append("sourceImageId", item.source.imageId);
      await api<ImageAsset>("/image-tools/save", {
        method: "POST",
        body: form,
      });
      setResults((previous) =>
        previous.map((entry) =>
          entry.id === item.id ? { ...entry, saved: true } : entry,
        ),
      );
      await store.refresh();
      store.toast("处理结果已另存到当前项目图库");
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setSavingId("");
    }
  }

  async function downloadZip() {
    setPacking(true);
    try {
      const zip = new JSZip();
      results.forEach((item, index) => {
        if (item.blob)
          zip.file(
            `${String(index + 1).padStart(2, "0")}-${resultName(item)}`,
            item.blob,
          );
      });
      download(await zip.generateAsync({ type: "blob" }), "图片处理结果.zip");
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setPacking(false);
    }
  }

  function exportPalette(item: Result, type: "json" | "css") {
    if (!item.analysis) return;
    const content =
      type === "json"
        ? JSON.stringify(
            { name: item.source.name, colors: item.analysis.palette },
            null,
            2,
          )
        : `:root {\n${item.analysis.palette.map((color, index) => `  --image-color-${index + 1}: ${color.hex};`).join("\n")}\n}\n`;
    download(
      new Blob([content], {
        type: type === "json" ? "application/json" : "text/css",
      }),
      `${baseName(item.source.name)}-色板.${type}`,
    );
  }

  const preview = (url: string, label: string) => (
    <figure className="toolbox-preview">
      <div className="toolbox-preview-image checker">
        <img src={url} alt={label} />
      </div>
      <figcaption>{label}</figcaption>
    </figure>
  );

  return (
    <div className="image-tools-panel">
      <div
        className="toolbox-subtabs image-tools-modes"
        aria-label="图片处理工具"
      >
        {MODES.map((item) => (
          <button
            key={item.id}
            type="button"
            className={mode === item.id ? "active" : ""}
            aria-pressed={mode === item.id}
            disabled={busy}
            onClick={() => {
              setMode(item.id);
              clearResults();
              setError("");
            }}
          >
            {item.name}
          </button>
        ))}
      </div>
      <section className="image-tools-sources" aria-label="待处理图片">
        <div className="image-tools-source-heading">
          <strong>
            待处理图片{" "}
            <span>
              {sources.length} / {MAX_SOURCES}
            </span>
          </strong>
          <div className="toolbox-row">
            <label className="toolbox-file btn secondary">
              <input
                type="file"
                accept={ACCEPT}
                multiple
                disabled={busy || sources.length >= MAX_SOURCES}
                aria-label="添加本地图片"
                onChange={(event) => {
                  const files = Array.from(event.target.files || []);
                  if (files.length) void addFiles(files);
                  event.target.value = "";
                }}
              />
              {adding ? <Busy /> : <Upload size={16} />}
              <span>本地图片</span>
            </label>
            <Button
              disabled={busy || sources.length >= MAX_SOURCES}
              onClick={() => {
                setGalleryIds([]);
                setGalleryOpen(true);
              }}
            >
              <FolderOpen size={16} />
              从图库选择
            </Button>
            {sources.length > 0 && (
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  sources.forEach((item) => {
                    if (item.file) revokeUrl(item.url);
                  });
                  setSources([]);
                  sourcesRef.current = [];
                  setSelectedId("");
                  clearResults();
                }}
              >
                清空
              </Button>
            )}
          </div>
        </div>
        {sources.length ? (
          <div className="image-tools-source-list">
            {sources.map((source) => (
              <div
                key={source.id}
                className={`image-tools-source-item ${selected?.id === source.id ? "active" : ""}`}
              >
                <button
                  type="button"
                  className="image-tools-source-select"
                  disabled={busy}
                  aria-pressed={selected?.id === source.id}
                  onClick={() => {
                    setSelectedId(source.id);
                    const existing = results.find(
                      (item) => item.source.id === source.id,
                    );
                    if (existing) setResultId(existing.id);
                  }}
                >
                  <img src={source.url} alt="" />
                  <span title={source.name}>{source.name}</span>
                  <small>
                    {source.width} × {source.height}
                  </small>
                </button>
                <button
                  type="button"
                  className="image-tools-source-remove icon-btn"
                  disabled={busy}
                  aria-label={`移除 ${source.name}`}
                  onClick={() => removeSource(source.id)}
                >
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="image-tools-hint">
            添加 PNG、JPEG、WebP 或 AVIF 图片，也可以直接使用当前项目中的作品。
          </p>
        )}
      </section>
      {error && (
        <p className="image-tools-errors" role="alert">
          {error}
        </p>
      )}
      <div className="toolbox-grid">
        <section className="toolbox-controls" aria-label="图片处理设置">
          <h2 className="toolbox-panel-title">
            <Settings2 size={16} />
            {MODES.find((item) => item.id === mode)!.name}
          </h2>
          <p className="image-tools-hint">{description}</p>
          <fieldset className="image-tools-options" disabled={busy}>
            {mode === "crop" && (
              <>
                <Field label="裁剪比例">
                  <select
                    value={ratio}
                    onChange={(event) => setRatio(event.target.value)}
                  >
                    <option value="free">自由比例</option>
                    <option value="1">1:1 正方形</option>
                    <option value={4 / 3}>4:3</option>
                    <option value={3 / 4}>3:4</option>
                    <option value={16 / 9}>16:9</option>
                    <option value={9 / 16}>9:16</option>
                  </select>
                </Field>
                <Field label="裁剪后旋转">
                  <select
                    value={rotation}
                    onChange={(event) =>
                      setRotation(Number(event.target.value) as typeof rotation)
                    }
                  >
                    <option value="0">不旋转</option>
                    <option value="90">顺时针 90°</option>
                    <option value="180">旋转 180°</option>
                    <option value="270">逆时针 90°</option>
                  </select>
                </Field>
                <label className="image-tools-check">
                  <input
                    type="checkbox"
                    checked={flop}
                    onChange={(event) => setFlop(event.target.checked)}
                  />
                  左右翻转
                </label>
                <label className="image-tools-check">
                  <input
                    type="checkbox"
                    checked={flip}
                    onChange={(event) => setFlip(event.target.checked)}
                  />
                  上下翻转
                </label>
              </>
            )}
            {mode === "resize" && (
              <>
                <div className="toolbox-fields">
                  <Field label="宽度（像素）">
                    <input
                      type="number"
                      min="1"
                      max="8192"
                      value={width}
                      placeholder="自动"
                      onChange={(event) => setWidth(event.target.value)}
                    />
                  </Field>
                  <Field label="高度（像素）">
                    <input
                      type="number"
                      min="1"
                      max="8192"
                      value={height}
                      placeholder="自动"
                      onChange={(event) => setHeight(event.target.value)}
                    />
                  </Field>
                </div>
                <Field label="适配方式" hint="只填一个尺寸时保持原比例。">
                  <select
                    value={fit}
                    onChange={(event) =>
                      setFit(event.target.value as typeof fit)
                    }
                  >
                    <option value="inside">保持比例，完整放入</option>
                    <option value="cover">填满尺寸，裁去多余</option>
                    <option value="contain">保持比例，补齐底色</option>
                    <option value="fill">拉伸到指定尺寸</option>
                  </select>
                </Field>
                {fit === "contain" && (
                  <Field label="补边底色">
                    <input
                      type="color"
                      value={background}
                      onChange={(event) => setBackground(event.target.value)}
                    />
                  </Field>
                )}
                <label className="image-tools-check">
                  <input
                    type="checkbox"
                    checked={withoutEnlargement}
                    onChange={(event) =>
                      setWithoutEnlargement(event.target.checked)
                    }
                  />
                  不放大小图
                </label>
              </>
            )}
            {mode === "adjust" && (
              <>
                {(
                  [
                    {
                      key: "brightness",
                      name: "亮度",
                      min: 0.2,
                      max: 2,
                      step: 0.05,
                    },
                    {
                      key: "saturation",
                      name: "饱和度",
                      min: 0,
                      max: 2,
                      step: 0.05,
                    },
                    {
                      key: "contrast",
                      name: "对比度",
                      min: 0.2,
                      max: 2,
                      step: 0.05,
                    },
                    { key: "blur", name: "模糊", min: 0, max: 10, step: 0.5 },
                    { key: "sharpen", name: "锐化", min: 0, max: 3, step: 0.1 },
                  ] as const
                ).map((setting) => (
                  <Field
                    key={setting.key}
                    label={`${setting.name} ${adjust[setting.key].toFixed(2)}`}
                  >
                    <input
                      type="range"
                      min={setting.min}
                      max={setting.max}
                      step={setting.step}
                      value={adjust[setting.key]}
                      onChange={(event) =>
                        setAdjust({
                          ...adjust,
                          [setting.key]: Number(event.target.value),
                        })
                      }
                    />
                  </Field>
                ))}
                <label className="image-tools-check">
                  <input
                    type="checkbox"
                    checked={adjust.grayscale}
                    onChange={(event) =>
                      setAdjust({ ...adjust, grayscale: event.target.checked })
                    }
                  />
                  黑白效果
                </label>
                <Button
                  onClick={() =>
                    setAdjust({
                      brightness: 1,
                      saturation: 1,
                      contrast: 1,
                      blur: 0,
                      sharpen: 0,
                      grayscale: false,
                    })
                  }
                >
                  恢复默认调色
                </Button>
              </>
            )}
            {mode === "border" && (
              <>
                <Field label="四周留白（像素）">
                  <input
                    type="number"
                    min="0"
                    max="2048"
                    value={padding}
                    onChange={(event) => setPadding(Number(event.target.value))}
                  />
                </Field>
                <Field label="底色">
                  <input
                    type="color"
                    value={background}
                    onChange={(event) => setBackground(event.target.value)}
                  />
                </Field>
                <Field
                  label="圆角半径（像素）"
                  hint="圆角之外为透明区域，建议导出 PNG 或 WebP。"
                >
                  <input
                    type="number"
                    min="0"
                    max="2048"
                    value={radius}
                    onChange={(event) => setRadius(Number(event.target.value))}
                  />
                </Field>
              </>
            )}
            {mode === "watermark" && (
              <>
                <Field label="水印文字">
                  <input
                    type="text"
                    maxLength={200}
                    value={watermark.text}
                    placeholder="例如：摄影 / 我的名字"
                    onChange={(event) =>
                      setWatermark({ ...watermark, text: event.target.value })
                    }
                  />
                </Field>
                <div className="toolbox-fields">
                  <Field label="字号（像素）">
                    <input
                      type="number"
                      min="8"
                      max="512"
                      value={watermark.fontSize}
                      onChange={(event) =>
                        setWatermark({
                          ...watermark,
                          fontSize: Number(event.target.value),
                        })
                      }
                    />
                  </Field>
                  <Field label="文字颜色">
                    <input
                      type="color"
                      value={watermark.color}
                      onChange={(event) =>
                        setWatermark({
                          ...watermark,
                          color: event.target.value,
                        })
                      }
                    />
                  </Field>
                </div>
                <Field
                  label={`不透明度 ${Math.round(watermark.opacity * 100)}%`}
                >
                  <input
                    type="range"
                    min="0.05"
                    max="1"
                    step="0.05"
                    value={watermark.opacity}
                    onChange={(event) =>
                      setWatermark({
                        ...watermark,
                        opacity: Number(event.target.value),
                      })
                    }
                  />
                </Field>
                <Field label="位置">
                  <select
                    value={watermark.position}
                    onChange={(event) =>
                      setWatermark({
                        ...watermark,
                        position: event.target
                          .value as typeof watermark.position,
                      })
                    }
                  >
                    <option value="northwest">左上角</option>
                    <option value="northeast">右上角</option>
                    <option value="center">正中</option>
                    <option value="southwest">左下角</option>
                    <option value="southeast">右下角</option>
                  </select>
                </Field>
                <Field label="边距（像素）">
                  <input
                    type="number"
                    min="0"
                    max="2048"
                    value={watermark.margin}
                    onChange={(event) =>
                      setWatermark({
                        ...watermark,
                        margin: Number(event.target.value),
                      })
                    }
                  />
                </Field>
              </>
            )}
            {!analysisMode && (
              <>
                <Field
                  label="输出格式"
                  hint={
                    format === "jpeg"
                      ? "JPEG 不支持透明，透明区域会铺为白色。"
                      : undefined
                  }
                >
                  <select
                    value={format}
                    onChange={(event) =>
                      setFormat(event.target.value as ImageOutputFormat)
                    }
                  >
                    <option value="png">PNG · 无损 / 透明</option>
                    <option value="jpeg">JPEG · 通用照片</option>
                    <option value="webp">WebP · 小体积 / 透明</option>
                    <option value="avif">AVIF · 更高压缩</option>
                  </select>
                </Field>
                {format !== "png" && (
                  <Field
                    label={`输出质量 ${quality}`}
                    hint="数值越低，文件通常越小；处理后可查看实际差异。"
                  >
                    <input
                      type="range"
                      min="1"
                      max="100"
                      value={quality}
                      onChange={(event) =>
                        setQuality(Number(event.target.value))
                      }
                    />
                  </Field>
                )}
                {mode === "convert" && format === "png" && (
                  <p className="image-tools-hint">
                    PNG 使用无损压缩。想进一步缩小体积，可以选择 WebP 或 AVIF。
                  </p>
                )}
              </>
            )}
          </fieldset>
          <Button
            variant="primary"
            disabled={
              busy ||
              !selected ||
              (mode === "crop" && cropValue?.sourceId !== selected.id)
            }
            onClick={() => void process()}
          >
            {running && <Busy />}
            {analysisMode
              ? `分析${sources.length ? ` ${sources.length} 张` : "图片"}`
              : mode === "crop"
                ? "处理当前图片"
                : `处理${sources.length ? ` ${sources.length} 张` : "图片"}`}
          </Button>
          {running && (
            <Button onClick={() => controller.current?.abort()}>
              停止处理
            </Button>
          )}
          <p className="image-tools-hint">
            {analysisMode
              ? "在本机读取图片信息，不会修改原图。"
              : "由本机服务处理。结果可下载，或以 PNG 另存到图库。"}
          </p>
          {progress.total > 0 && (
            <div
              className="image-tools-progress"
              role="status"
              aria-live="polite"
            >
              <progress max={progress.total} value={progress.done} />
              <span>
                {progress.stopped
                  ? "已停止"
                  : running
                    ? "正在处理"
                    : "处理完成"}{" "}
                · {progress.done}/{progress.total}，成功 {results.length} 张
              </span>
              {progress.name && (
                <small title={progress.name}>{progress.name}</small>
              )}
            </div>
          )}
        </section>
        <section className="toolbox-stage" aria-label="图片与处理结果">
          <h2 className="toolbox-panel-title">
            <ImageIcon size={16} />
            {mode === "crop" ? "框选与结果" : "素材与结果"}
          </h2>
          {!selected ? (
            <Empty title="先放入一张图片">
              选择本地文件或图库作品，开始处理。
            </Empty>
          ) : (
            <>
              {mode === "crop" && (
                <>
                  <CropPreview
                    source={selected}
                    ratio={ratio}
                    disabled={busy}
                    onCrop={onCrop}
                    onError={setError}
                  />
                  <p className="image-tools-crop-readout">
                    {cropValue?.sourceId === selected.id
                      ? `裁剪区域 ${cropValue.area.width} × ${cropValue.area.height} px，起点 ${cropValue.area.left}, ${cropValue.area.top}`
                      : "正在载入裁剪画面…"}
                  </p>
                </>
              )}
              {!result &&
                mode !== "crop" &&
                preview(selected.url, selected.name)}
              {results.length > 0 && (
                <>
                  <div
                    className="image-tools-result-list"
                    aria-label="已完成结果"
                  >
                    {results.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        className={`image-tools-result-tab ${result?.id === item.id ? "active" : ""}`}
                        aria-pressed={result?.id === item.id}
                        title={item.source.name}
                        onClick={() => setResultId(item.id)}
                      >
                        {item.source.name}
                      </button>
                    ))}
                  </div>
                  {stale && (
                    <p className="image-tools-stale" role="status">
                      参数已更改，下面仍是上次的结果。点击处理应用新设置。
                    </p>
                  )}
                  {result?.blob && (
                    <>
                      <div className="image-tools-comparison">
                        {preview(result.source.url, "原图")}
                        {preview(result.url!, "处理结果")}
                      </div>
                      <div className="image-tools-stats">
                        <span>
                          原图 {result.source.width} × {result.source.height} /{" "}
                          {fileSize(result.source.bytes)}
                        </span>
                        <strong>
                          结果 {result.width} × {result.height} /{" "}
                          {fileSize(result.blob.size)} /{" "}
                          {result.format.toUpperCase()}
                        </strong>
                        <span>
                          {result.blob.size <= result.source.bytes
                            ? `体积减少 ${((1 - result.blob.size / result.source.bytes) * 100).toFixed(1)}%`
                            : `体积增加 ${((result.blob.size / result.source.bytes - 1) * 100).toFixed(1)}%`}
                        </span>
                      </div>
                      <div className="toolbox-row">
                        <Button
                          onClick={() =>
                            download(result.blob!, resultName(result))
                          }
                        >
                          <Download size={16} />
                          下载当前结果
                        </Button>
                        <Button
                          disabled={packing || running}
                          onClick={() => void downloadZip()}
                        >
                          {packing ? <Busy /> : <Download size={16} />}打包下载{" "}
                          {results.length} 张
                        </Button>
                        <Button
                          disabled={
                            running ||
                            Boolean(savingId) ||
                            result.saved ||
                            saveProjectMismatch ||
                            !store.projectId ||
                            !store.sessionId
                          }
                          onClick={() => void saveResult(result)}
                        >
                          {savingId === result.id && <Busy />}
                          {result.saved ? "已保存到图库" : "另存图库（PNG）"}
                        </Button>
                      </div>
                      {(!store.projectId || !store.sessionId) && (
                        <p className="image-tools-hint">
                          选择项目与创作会话后，可以把结果另存到图库。
                        </p>
                      )}
                      {saveProjectMismatch && (
                        <p className="image-tools-hint">
                          原图来自其他项目，请切回原项目后另存图库；也可以直接下载结果。
                        </p>
                      )}
                    </>
                  )}
                  {result?.analysis && (
                    <>
                      {preview(result.source.url, result.source.name)}
                      {mode === "palette" ? (
                        <>
                          <div className="image-tools-palette">
                            {result.analysis.palette.map((color) => (
                              <button
                                type="button"
                                key={color.hex}
                                onClick={() =>
                                  navigator.clipboard
                                    .writeText(color.hex)
                                    .then(() =>
                                      store.toast(`已复制 ${color.hex}`),
                                    )
                                    .catch(() =>
                                      setError(
                                        "无法访问剪贴板，请手动复制显示的 HEX 色值。",
                                      ),
                                    )
                                }
                                title={`复制 ${color.hex}`}
                              >
                                <span
                                  className="image-tools-swatch"
                                  style={{ backgroundColor: color.hex }}
                                />
                                <strong>{color.hex}</strong>
                                <small>{color.percent.toFixed(1)}%</small>
                              </button>
                            ))}
                          </div>
                          <p className="image-tools-hint">
                            {result.analysis.palette.length
                              ? "点击色块复制 HEX。占比为颜色聚类的近似结果。"
                              : "这张图片完全透明，没有可提取的颜色。"}
                          </p>
                          <div className="toolbox-row">
                            <Button
                              onClick={() => exportPalette(result, "json")}
                            >
                              下载色板 JSON
                            </Button>
                            <Button
                              onClick={() => exportPalette(result, "css")}
                            >
                              下载 CSS 变量
                            </Button>
                          </div>
                        </>
                      ) : (
                        <dl className="image-tools-metadata">
                          <dt>尺寸</dt>
                          <dd>
                            {result.analysis.width} × {result.analysis.height}{" "}
                            px
                          </dd>
                          <dt>格式</dt>
                          <dd>{result.analysis.format.toUpperCase()}</dd>
                          <dt>文件大小</dt>
                          <dd>{fileSize(result.analysis.bytes)}</dd>
                          <dt>透明通道</dt>
                          <dd>{result.analysis.hasAlpha ? "有" : "无"}</dd>
                          <dt>颜色通道</dt>
                          <dd>{result.analysis.channels}</dd>
                          <dt>像素密度</dt>
                          <dd>
                            {result.analysis.density
                              ? `${result.analysis.density} DPI`
                              : "未记录"}
                          </dd>
                          <dt>EXIF 信息</dt>
                          <dd>{result.analysis.hasExif ? "含有" : "无"}</dd>
                          <dt>ICC 色彩配置</dt>
                          <dd>{result.analysis.hasIcc ? "含有" : "无"}</dd>
                        </dl>
                      )}
                    </>
                  )}
                </>
              )}
              {errors.length > 0 && (
                <div className="image-tools-errors" role="alert">
                  <strong>{errors.length} 张未处理成功</strong>
                  <ul>
                    {errors.map((message, index) => (
                      <li key={index}>{message}</li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </section>
      </div>
      {galleryOpen && (
        <Modal
          title="从当前项目图库选择"
          wide
          onClose={() => setGalleryOpen(false)}
        >
          <p className="image-tools-hint">
            已选择 {galleryIds.length} 张，还可添加{" "}
            {MAX_SOURCES - sources.length} 张。
          </p>
          {gallery.length ? (
            <div className="image-tools-gallery">
              {gallery.map((image) => {
                const included = sources.some(
                  (source) => source.imageId === image.id,
                );
                const checked = galleryIds.includes(image.id);
                return (
                  <button
                    type="button"
                    key={image.id}
                    className={`image-tools-gallery-item ${checked ? "active" : ""}`}
                    disabled={
                      included ||
                      (!checked &&
                        galleryIds.length >= MAX_SOURCES - sources.length)
                    }
                    aria-pressed={checked}
                    onClick={() =>
                      setGalleryIds((previous) =>
                        checked
                          ? previous.filter((id) => id !== image.id)
                          : [...previous, image.id],
                      )
                    }
                  >
                    <img
                      src={image.thumbnailUrl || image.url}
                      alt={image.prompt || "图库图片"}
                      loading="lazy"
                    />
                    <span>
                      {included
                        ? "已在待处理列表"
                        : `${image.width} × ${image.height}`}
                    </span>
                    <small>{image.path.split(/[\\/]/).pop()}</small>
                  </button>
                );
              })}
            </div>
          ) : (
            <Empty title="当前项目还没有图片">
              生成或上传图片后，即可在这里选择。
            </Empty>
          )}
          <div className="toolbox-row">
            <Button
              variant="primary"
              disabled={!galleryIds.length}
              onClick={() => {
                addAssets(
                  gallery.filter((image) => galleryIds.includes(image.id)),
                );
                setGalleryOpen(false);
              }}
            >
              添加所选 {galleryIds.length} 张
            </Button>
            <Button onClick={() => setGalleryOpen(false)}>取消</Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
