import { create } from "zustand";
import type { Config, Snapshot, ImageAsset, Task } from "../shared/types";
import { api } from "./api";
export type Page =
  "canvas" | "models" | "tasks" | "gallery" | "costs" | "memory" | "settings";
interface Store {
  config: Config | null;
  data: Snapshot;
  page: Page;
  projectId: string;
  sessionId: string;
  selectedImageId: string;
  reference: ImageAsset | null;
  maskId: string;
  prompt: string;
  editPrompts: Record<string, string>;
  negativePrompt: string;
  editNegativePrompts: Record<string, string>;
  generationPreset: Task | null;
  notice: string;
  error: string;
  connected: boolean;
  loading: boolean;
  composerFocus: number;
  canvasFocusId: string;
  flushCanvas?: () => Promise<void>;
  set: (value: Partial<Store>) => void;
  setPrompt: (value: string) => void;
  setNegativePrompt: (value: string) => void;
  reuseTask: (task: Task) => void;
  beginEdit: (image: ImageAsset, instruction?: string) => void;
  refresh: () => Promise<void>;
  boot: () => Promise<void>;
  toast: (message: string) => void;
}
export const useStore = create<Store>((set, get) => ({
  config: null,
  data: {
    models: [],
    projects: [],
    sessions: [],
    images: [],
    tasks: [],
    memories: [],
  },
  page: "canvas",
  projectId: localStorage.getItem("workbench-project") || "",
  sessionId: "",
  selectedImageId: "",
  reference: null,
  maskId: "",
  prompt: "",
  editPrompts: {},
  negativePrompt: "",
  editNegativePrompts: {},
  generationPreset: null,
  notice: "",
  error: "",
  connected: false,
  loading: true,
  composerFocus: 0,
  canvasFocusId: "",
  setPrompt: (value) => {
    const current = get();
    if (current.reference)
      set({
        editPrompts: { ...current.editPrompts, [current.reference.id]: value },
      });
    else set({ prompt: value });
  },
  setNegativePrompt: (value) => {
    const current = get();
    if (current.reference)
      set({
        editNegativePrompts: {
          ...current.editNegativePrompts,
          [current.reference.id]: value,
        },
      });
    else set({ negativePrompt: value });
  },
  reuseTask: (task) => {
    const current = get();
    if (task.providerId !== current.config?.activeProviderId) {
      current.toast("请先切换到这轮使用的供应商，再复用参数");
      return;
    }
    const reference =
      current.data.images.find((i) => i.id === task.parentImageId) || null;
    current.set({
      page: "canvas",
      projectId: task.projectId,
      sessionId: task.sessionId,
      reference,
      maskId: task.params.maskId || "",
      generationPreset: task,
      composerFocus: Date.now(),
      ...(reference
        ? {
            editPrompts: {
              ...current.editPrompts,
              [reference.id]: task.prompt,
            },
            editNegativePrompts: {
              ...current.editNegativePrompts,
              [reference.id]: task.params.negativePrompt || "",
            },
          }
        : {
            prompt: task.prompt,
            negativePrompt: task.params.negativePrompt || "",
          }),
    });
  },
  beginEdit: (image, instruction) => {
    const current = get();
    current.set({
      reference: image,
      maskId: "",
      selectedImageId: image.id,
      page: "canvas",
      composerFocus: Date.now(),
      ...(instruction !== undefined
        ? { editPrompts: { ...current.editPrompts, [image.id]: instruction } }
        : {}),
    });
  },
  set: (value) => {
    const current = get();
    const navigating =
      (value.page !== undefined && value.page !== current.page) ||
      (value.projectId !== undefined && value.projectId !== current.projectId);
    if (navigating && current.flushCanvas) {
      void current
        .flushCanvas()
        .then(() => set(value))
        .catch((error: Error) => set({ error: error.message }));
    } else set(value);
  },
  refresh: async () => {
    const data = await api<Snapshot>("/state");
    const current = get();
    data.projects = data.projects.map((project) => {
      const local = current.data.projects.find((p) => p.id === project.id);
      return local && local.revision > project.revision ? local : project;
    });
    const projectId = data.projects.some((p) => p.id === current.projectId)
      ? current.projectId
      : data.projects[0]?.id || "";
    const sessionId = data.sessions.some(
      (s) => s.id === current.sessionId && s.projectId === projectId,
    )
      ? current.sessionId
      : data.sessions.find((s) => s.projectId === projectId)?.id || "";
    set({ data, projectId, sessionId });
  },
  boot: async () => {
    try {
      const config = await api<Config>("/config");
      if (config.deviceToken)
        localStorage.setItem("workbench-token", config.deviceToken);
      set({ config });
      await get().refresh();
      set({ loading: false, error: "" });
    } catch (e) {
      set({ loading: false, error: (e as Error).message });
    }
  },
  toast: (message) => {
    set({ notice: message });
    setTimeout(() => {
      if (get().notice === message) set({ notice: "" });
    }, 4500);
  },
}));
