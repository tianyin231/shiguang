import { useState, type ReactNode, type ButtonHTMLAttributes } from "react";
import { createPortal } from "react-dom";
import {
  X,
  LoaderCircle,
  Star,
  Heart,
  Trash2,
  CornerUpRight,
  Download,
  Copy,
  ImagePlus,
} from "lucide-react";
import { useStore } from "./store";
import { patch, money } from "./api";
import type { ImageAsset } from "../shared/types";
export function Button({
  children,
  className = "",
  variant = "secondary",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
}) {
  return (
    <button className={`btn ${variant} ${className}`} {...props}>
      {children}
    </button>
  );
}
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  return createPortal(
    <div
      className="modal-backdrop"
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        className={`modal ${wide ? "wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="modal-heading">
          <h2>{title}</h2>
          <button className="icon-btn" aria-label="关闭" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        {children}
      </section>
    </div>,
    document.body,
  );
}
export function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-mark">
        <ImagePlus size={30} strokeWidth={1.2} />
      </div>
      <h2>{title}</h2>
      <p>{children}</p>
      {action}
    </div>
  );
}
export function Busy() {
  return <LoaderCircle className="spin" size={16} />;
}
export function useAction() {
  const [busy, setBusy] = useState(false);
  const store = useStore();
  return {
    busy,
    run: async (fn: () => Promise<unknown>) => {
      setBusy(true);
      try {
        await fn();
      } catch (e) {
        store.set({ error: (e as Error).message });
      } finally {
        setBusy(false);
      }
    },
  };
}
export function ImageActions({
  image,
  compact = false,
  onReference,
}: {
  image: ImageAsset;
  compact?: boolean;
  onReference?: () => void;
}) {
  const { refresh, set, toast, beginEdit } = useStore();
  const update = async (value: unknown) => {
    try {
      await patch("/images/" + image.id, value);
      await refresh();
    } catch (e) {
      set({ error: (e as Error).message });
    }
  };
  return (
    <div
      className="image-actions nodrag nopan"
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <button
        className={`icon-btn ${image.favorite ? "favorited" : ""}`}
        title="收藏图片"
        onClick={() => update({ favorite: !image.favorite })}
      >
        <Heart size={16} fill={image.favorite ? "currentColor" : "none"} />
      </button>
      <button
        className="image-iterate-button"
        title="二次生图：以这张图为原图，描述修改要求"
        onClick={() => {
          beginEdit(image);
          onReference?.();
          toast("已选好原图，写下修改要求后点击“生成新版本”");
        }}
      >
        <CornerUpRight size={16} />
        修改这张图
      </button>
      <a className="icon-btn" href={image.url + "?download=1"} title="下载原图">
        <Download size={16} />
      </a>
      {!compact && (
        <>
          <button
            className="icon-btn"
            title="复制文件路径"
            onClick={() =>
              navigator.clipboard
                .writeText(image.path)
                .then(() => toast("已复制路径"))
                .catch(() => set({ error: "浏览器未授予剪贴板权限" }))
            }
          >
            <Copy size={16} />
          </button>
          <button
            className={`icon-btn ${image.discarded ? "favorited" : ""}`}
            title={image.discarded ? "恢复图片" : "标为淘汰"}
            onClick={() => update({ discarded: !image.discarded })}
          >
            <Trash2 size={16} />
          </button>
        </>
      )}
    </div>
  );
}
export function ImageDetail({
  image,
  onClose,
}: {
  image: ImageAsset;
  onClose: () => void;
}) {
  const { refresh, set } = useStore();
  return (
    <Modal title="作品详情" wide onClose={onClose}>
      <div className="detail-grid">
        <img className="detail-image" src={image.url} />
        <div className="detail-copy">
          <div className="pill">{image.model}</div>
          <p>{image.prompt}</p>
          {image.params.negativePrompt && (
            <div className="parameter-hint">
              <strong>负面提示词</strong>
              <p>{image.params.negativePrompt}</p>
            </div>
          )}
          <div className="rating">
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                title={`${n} 星`}
                onClick={() =>
                  patch("/images/" + image.id, {
                    rating: image.rating === n ? 0 : n,
                  })
                    .then(refresh)
                    .catch((e) => set({ error: e.message }))
                }
              >
                <Star
                  size={21}
                  fill={n <= image.rating ? "#b96549" : "none"}
                  color={n <= image.rating ? "#b96549" : "#aaa39a"}
                />
              </button>
            ))}
          </div>
          <dl>
            <dt>尺寸</dt>
            <dd>
              {image.width} × {image.height}
            </dd>
            <dt>Seed</dt>
            <dd>{image.params.seed ?? "自动"}</dd>
            <dt>画质</dt>
            <dd>{image.params.quality || "auto"}</dd>
            <dt>费用</dt>
            <dd>
              {money(image.cost, image.currency)} ·{" "}
              {image.costSource === "provider" ? "实际" : "估算"}
            </dd>
            <dt>父图</dt>
            <dd>{image.parentId || "原始创作"}</dd>
          </dl>
          <ImageActions image={image} onReference={onClose} />
          <details>
            <summary>全部生成参数</summary>
            <pre>{JSON.stringify(image.params, null, 2)}</pre>
          </details>
          <details>
            <summary>最终提示词与记忆</summary>
            <p className="pre-wrap">{image.effectivePrompt || image.prompt}</p>
          </details>
        </div>
      </div>
    </Modal>
  );
}
