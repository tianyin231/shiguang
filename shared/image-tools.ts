export type ImageTool =
  "crop" | "resize" | "convert" | "adjust" | "border" | "watermark";
export type ImageOutputFormat = "png" | "jpeg" | "webp" | "avif";

export interface ImageToolOptions {
  tool: ImageTool;
  format?: ImageOutputFormat;
  quality?: number;
  crop?: { left: number; top: number; width: number; height: number };
  rotation?: 0 | 90 | 180 | 270;
  flip?: boolean;
  flop?: boolean;
  resize?: {
    width?: number;
    height?: number;
    fit: "inside" | "cover" | "contain" | "fill";
    background: string;
    withoutEnlargement: boolean;
  };
  adjust?: {
    brightness: number;
    saturation: number;
    contrast: number;
    blur: number;
    sharpen: number;
    grayscale: boolean;
  };
  border?: { padding: number; background: string; radius: number };
  watermark?: {
    text: string;
    fontSize: number;
    color: string;
    opacity: number;
    position: "northwest" | "northeast" | "center" | "southwest" | "southeast";
    margin: number;
  };
}

export interface ImageToolAnalysis {
  width: number;
  height: number;
  format: string;
  bytes: number;
  hasAlpha: boolean;
  channels: number;
  density?: number;
  hasExif: boolean;
  hasIcc: boolean;
  palette: { hex: string; percent: number }[];
}

export const imageOutputMime: Record<ImageOutputFormat, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
  avif: "image/avif",
};
