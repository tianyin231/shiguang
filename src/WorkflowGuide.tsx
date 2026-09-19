import { Check, ChevronRight, X } from "lucide-react";
import { useStore } from "./store";

export function WorkflowGuide({ onClose }: { onClose: () => void }) {
  const s = useStore();
  const provider = s.config?.providers.find(
    (p) => p.id === s.config?.activeProviderId,
  );
  const ready = s.data.models.some(
    (m) =>
      m.providerId === provider?.id &&
      (m.capabilities.includes("text2image") ||
        m.capabilities.includes("image2image")),
  );
  const hasImages = s.data.images.some(
    (i) => i.projectId === s.projectId && i.prompt !== "局部重绘遮罩",
  );
  const step = !ready ? 0 : !hasImages ? 1 : 2;
  const steps = [
    {
      title: "准备模型",
      description: ready
        ? provider?.adapter === "demo"
          ? "当前为演示，可连接自己的模型"
          : "已连接，可查看模型与价格"
        : "填写连接，选择可生图的模型",
      action: () =>
        s.set({
          page: provider && provider.adapter !== "demo" ? "models" : "settings",
        }),
    },
    {
      title: "描述并生成",
      description: "写下画面，选择张数，点击生成",
      action: () => s.set({ page: "canvas", composerFocus: Date.now() }),
    },
    {
      title: "看结果，再修改",
      description: "修改这张图 → 写要求 → 生成新版本",
      action: () => s.set({ page: hasImages ? "gallery" : "canvas" }),
    },
  ];
  return (
    <section className="workflow-guide" aria-label="创作流程指南">
      <div className="workflow-steps">
        {steps.map((item, index) => (
          <button
            key={item.title}
            className={`workflow-step ${index === step ? "current" : ""}`}
            onClick={item.action}
          >
            <span className="workflow-number">
              {index < step ? <Check size={14} /> : index + 1}
            </span>
            <span>
              <strong>{item.title}</strong>
              <small>{item.description}</small>
            </span>
            <ChevronRight size={14} />
          </button>
        ))}
      </div>
      <button
        className="icon-btn"
        aria-label="收起流程指南"
        title="随时可从顶部“使用指南”重新打开"
        onClick={onClose}
      >
        <X size={16} />
      </button>
    </section>
  );
}
