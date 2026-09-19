export type Adapter = "openai" | "gemini" | "anthropic" | "demo";
export type Capability =
  "text2image" | "image2image" | "vision" | "chat" | "streaming" | "mask";
export type Status =
  "queued" | "running" | "succeeded" | "failed" | "cancelled" | "dead";
export interface Provider {
  id: string;
  name: string;
  baseUrl: string;
  apiKey?: string;
  keyHint?: string;
  adapter: Adapter;
  proxyUrl: string;
  concurrency: number;
  adaptiveLimit: number;
  cooldownUntil: number;
  createdAt: number;
}
export interface Price {
  type: "image" | "megapixel" | "token";
  unit: number;
  outputUnit: number;
  currency: string;
  qualityMultiplier: Record<string, number>;
}
export interface Model {
  id: string;
  providerId: string;
  name: string;
  capabilities: Capability[];
  sizes: string[];
  qualities: string[];
  supportsSeed: boolean;
  supportsN: boolean;
  imageParameters?: string[];
  maxConcurrency: number;
  favorite: boolean;
  isDefault: boolean;
  verified: Partial<Record<Capability, boolean>>;
  probeAt?: number;
  probeError?: string;
  price: Price;
}
export interface Settings {
  outputDir: string;
  filenameTemplate: string;
  quotaMB: number;
  totalBudgets: Record<string, number>;
  concurrency: number;
  retries: number;
  timeout: number;
}
export interface CanvasNode {
  id: string;
  type?: string;
  position: { x: number; y: number };
  data: Record<string, unknown>;
  parentId?: string;
  extent?: "parent";
  style?: Record<string, string | number>;
  selected?: boolean;
  width?: number;
  height?: number;
}
export interface CanvasEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
}
export interface Canvas {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  viewport?: { x: number; y: number; zoom: number };
  hiddenTaskIds?: string[];
  hiddenImageIds?: string[];
}
export interface Project {
  id: string;
  name: string;
  canvas: Canvas;
  revision: number;
  createdAt: number;
}
export interface Session {
  id: string;
  projectId: string;
  title: string;
  messages: { role: "user" | "assistant"; content: string }[];
  summary: string;
  createdAt: number;
}
export interface Memory {
  id: string;
  projectId: string;
  sessionId?: string;
  imageId?: string;
  scope: "project" | "session" | "image";
  content: string;
  enabled: boolean;
  createdAt: number;
}
export interface DrawingOptions {
  negativePrompt?: string;
  seedMode?: "increment" | "fixed";
  background?: "auto" | "opaque" | "transparent";
  inputFidelity?: "high" | "low";
  steps?: number;
  cfgScale?: number;
  sampler?: string;
  strength?: number;
  imageSize?: "1K" | "2K" | "4K";
  extraParams?: Record<string, unknown>;
}
export interface GenerationParams extends DrawingOptions {
  size: string;
  quality: string;
  seed?: number;
  referenceId?: string;
  maskId?: string;
}
export interface Task {
  id: string;
  projectId: string;
  sessionId: string;
  providerId: string;
  modelId: string;
  modelName: string;
  batchId: string;
  status: Status;
  priority: number;
  attempts: number;
  maxRetries: number;
  createdAt: number;
  updatedAt: number;
  prompt: string;
  effectivePrompt: string;
  memoryIds: string[];
  params: GenerationParams;
  estimatedCost: number;
  actualCost: number | null;
  costSource: "estimate" | "provider";
  currency: string;
  timeout: number;
  concurrency: number;
  error?: string;
  logs: { at: number; text: string }[];
  imageIds: string[];
  parentImageId?: string;
  fallback: boolean;
  elapsedMs?: number;
  uncertainCharge?: boolean;
  reservation: number;
  price: Price;
}
export interface ImageAsset {
  id: string;
  projectId: string;
  sessionId: string;
  taskId?: string;
  parentId?: string;
  path: string;
  thumbnailPath: string;
  sidecarPath: string;
  sha: string;
  bytes: number;
  width: number;
  height: number;
  prompt: string;
  effectivePrompt: string;
  model: string;
  params: GenerationParams;
  rating: number;
  favorite: boolean;
  discarded: boolean;
  cost: number;
  costSource: "estimate" | "provider";
  currency: string;
  createdAt: number;
  url: string;
  thumbnailUrl: string;
}
export interface Config {
  providers: Provider[];
  activeProviderId: string | null;
  settings: Settings;
  deviceToken?: string;
}
export interface Snapshot {
  models: Model[];
  projects: Project[];
  sessions: Session[];
  tasks: Task[];
  images: ImageAsset[];
  memories: Memory[];
}
export interface GenerateInput extends DrawingOptions {
  projectId: string;
  sessionId: string;
  modelIds: string[];
  prompt: string;
  variants: string[];
  count: number;
  sizes: string[];
  qualities: string[];
  seed?: number;
  concurrency: number;
  retries: number;
  timeout: number;
  priority: number;
  referenceId?: string;
  maskId?: string;
  taskBudget?: number;
  batchBudget?: number;
  allowFallback: boolean;
  idempotencyKey: string;
}
export interface Estimate {
  count: number;
  totals: Record<string, number>;
  warnings: string[];
  items: { modelId: string; amount: number; currency: string }[];
}
