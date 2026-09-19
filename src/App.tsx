import { useEffect, useRef, useState } from "react";
import {
  Sparkles,
  LayoutDashboard,
  Images,
  Layers3,
  ListTodo,
  Wallet,
  CircuitBoard,
  Settings2,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  ChevronDown,
  X,
  ArrowUpRight,
  Check,
  Radio,
  LogOut,
  CircleHelp,
} from "lucide-react";
import { useStore, type Page } from "./store";
import { post, api } from "./api";
import { Button, Field, Modal, Busy } from "./components";
import { CanvasPage } from "./CanvasPage";
import { Composer } from "./Composer";
import { WorkflowGuide } from "./WorkflowGuide";
import {
  SettingsPage,
  ModelsPage,
  TasksPage,
  GalleryPage,
  CostsPage,
  MemoryPage,
} from "./Pages";
import type { Config, Project, Session } from "../shared/types";
const nav: { id: Page; label: string; icon: typeof Images }[] = [
  { id: "canvas", label: "创作画布", icon: LayoutDashboard },
  { id: "gallery", label: "作品图库", icon: Images },
  { id: "tasks", label: "生成任务", icon: ListTodo },
  { id: "models", label: "模型管理", icon: Layers3 },
  { id: "memory", label: "创作记忆", icon: CircuitBoard },
  { id: "costs", label: "费用统计", icon: Wallet },
  { id: "settings", label: "连接设置", icon: Settings2 },
];
export function App() {
  const s = useStore();
  const [collapsed, setCollapsed] = useState(false);
  const [projectModal, setProjectModal] = useState(false);
  const [name, setName] = useState("");
  const [demoBusy, setDemoBusy] = useState(false);
  const [guideOpen, setGuideOpen] = useState(
    localStorage.getItem("workbench-guide") !== "closed",
  );
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  useEffect(() => {
    void s.boot();
  }, []);
  useEffect(() => {
    if (s.projectId) localStorage.setItem("workbench-project", s.projectId);
  }, [s.projectId]);
  useEffect(() => {
    if (!s.config) return;
    const source = new EventSource("/api/events", { withCredentials: true });
    const refresh = () => {
      clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(
        () => void s.refresh().catch(() => {}),
        200,
      );
    };
    source.onopen = () => s.set({ connected: true });
    source.onerror = () => s.set({ connected: false });
    ["task", "images", "models", "ready"].forEach((event) =>
      source.addEventListener(event, refresh),
    );
    return () => {
      source.close();
      clearTimeout(refreshTimer.current);
    };
  }, [!!s.config]);
  const project = s.data.projects.find((p) => p.id === s.projectId);
  const provider = s.config?.providers.find(
    (p) => p.id === s.config?.activeProviderId,
  );
  const pending = s.data.tasks.filter((t) =>
    ["queued", "running"].includes(t.status),
  ).length;
  async function demo() {
    setDemoBusy(true);
    try {
      const config = await post<Config>("/demo");
      s.set({ config });
      await s.refresh();
      s.toast("已启用本地演示。示例图片不调用付费接口。");
    } catch (e) {
      s.set({ error: (e as Error).message });
    } finally {
      setDemoBusy(false);
    }
  }
  if (s.loading)
    return (
      <div className="boot">
        <Sparkles size={36} />
        <p>准备好，让想法成为画面。</p>
        <Busy />
      </div>
    );
  return (
    <div className={`app ${collapsed ? "collapsed" : ""}`}>
      <aside className="sidebar">
        <a className="brand" onClick={() => s.set({ page: "canvas" })}>
          <span className="brand-mark">
            <Sparkles size={24} />
          </span>
          {!collapsed && (
            <span>
              拾光<small>图像创作工作台</small>
            </span>
          )}
        </a>
        <button
          className="collapse-toggle icon-btn"
          aria-label="收起侧栏"
          onClick={() => setCollapsed(!collapsed)}
        >
          {collapsed ? (
            <PanelLeftOpen size={17} />
          ) : (
            <PanelLeftClose size={17} />
          )}
        </button>
        <div className="project-selector">
          <select
            title="切换项目"
            value={s.projectId}
            onChange={(e) => {
              s.set({
                projectId: e.target.value,
                sessionId:
                  s.data.sessions.find((v) => v.projectId === e.target.value)
                    ?.id || "",
                reference: null,
                maskId: "",
              });
              localStorage.setItem("workbench-project", e.target.value);
            }}
          >
            {s.data.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button
            className="icon-btn"
            title="新建项目"
            onClick={() => setProjectModal(true)}
          >
            <Plus size={15} />
          </button>
        </div>
        <nav>
          {nav.map((n) => (
            <button
              key={n.id}
              className={s.page === n.id ? "active" : ""}
              title={n.label}
              onClick={() => s.set({ page: n.id })}
            >
              <n.icon size={19} />
              <span>{n.label}</span>
              {n.id === "tasks" && pending > 0 && <i>{pending}</i>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="local-note">
            <span className={`status-dot ${s.connected ? "live" : ""}`} />
            <span>{s.connected ? "实时连接正常" : "正在恢复连接"}</span>
          </div>
          <button
            className="provider-nav"
            onClick={() => s.set({ page: "settings" })}
          >
            <div className="avatar">{provider?.name?.slice(0, 1) || "连"}</div>
            <div>
              <strong>{provider?.name || "连接你的模型"}</strong>
              <small>
                {provider?.adapter === "demo"
                  ? "本地演示 · 不产生费用"
                  : provider
                    ? "密钥已保存在服务端"
                    : "添加 Base URL 与 Key"}
              </small>
            </div>
            <Settings2 size={15} />
          </button>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="breadcrumb">
            <select
              aria-label="当前项目"
              value={s.projectId}
              onChange={(e) => {
                s.set({
                  projectId: e.target.value,
                  sessionId:
                    s.data.sessions.find((v) => v.projectId === e.target.value)
                      ?.id || "",
                  reference: null,
                  maskId: "",
                });
                localStorage.setItem("workbench-project", e.target.value);
              }}
            >
              {s.data.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <button
              className="icon-btn"
              aria-label="添加项目"
              onClick={() => setProjectModal(true)}
            >
              <Plus size={14} />
            </button>
            <span>/</span>
            <strong>{nav.find((n) => n.id === s.page)?.label}</strong>
          </div>
          <div className="header-actions">
            <Button
              variant="ghost"
              aria-expanded={guideOpen}
              onClick={() => {
                const next = !guideOpen;
                setGuideOpen(next);
                localStorage.setItem(
                  "workbench-guide",
                  next ? "open" : "closed",
                );
              }}
            >
              <CircleHelp size={15} />
              使用指南
            </Button>
            <span className="pill">
              <span className="status-dot live" />
              {provider?.adapter === "demo" ? "演示模式" : "本地优先"}
            </span>
          </div>
        </header>
        {!provider && (
          <div className="connect-banner">
            <span>连接你自己的模型，从第一幅作品开始。</span>
            <div>
              <Button onClick={demo} disabled={demoBusy}>
                {demoBusy ? <Busy /> : null}试用演示
              </Button>
              <Button
                variant="primary"
                onClick={() => s.set({ page: "settings" })}
              >
                连接供应商
                <ArrowUpRight size={15} />
              </Button>
            </div>
          </div>
        )}
        {guideOpen && (
          <WorkflowGuide
            onClose={() => {
              setGuideOpen(false);
              localStorage.setItem("workbench-guide", "closed");
            }}
          />
        )}
        <div
          className={`page-layout ${s.page === "canvas" ? "with-composer" : ""}`}
        >
          <main className={`page page-${s.page}`}>
            {s.page === "canvas" ? (
              <CanvasPage />
            ) : s.page === "settings" ? (
              <SettingsPage />
            ) : s.page === "models" ? (
              <ModelsPage />
            ) : s.page === "tasks" ? (
              <TasksPage />
            ) : s.page === "gallery" ? (
              <GalleryPage />
            ) : s.page === "costs" ? (
              <CostsPage />
            ) : (
              <MemoryPage />
            )}
          </main>
          {s.page === "canvas" && <Composer />}
        </div>
      </div>
      {s.notice && (
        <div className="toast" role="status">
          <Check size={16} />
          {s.notice}
        </div>
      )}
      {s.error && (
        <div className="error-toast" role="alert">
          <span>{s.error}</span>
          <button
            aria-label="关闭错误"
            className="icon-btn"
            onClick={() => s.set({ error: "" })}
          >
            <X size={18} />
          </button>
        </div>
      )}
      {projectModal && (
        <Modal
          title="给新的灵感起个名字"
          onClose={() => setProjectModal(false)}
        >
          <Field label="项目名称">
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：暖木工坊 · 封面探索"
            />
          </Field>
          <Button
            variant="primary"
            disabled={!name.trim()}
            onClick={async () => {
              try {
                const result = await post<{
                  project: Project;
                  session: Session;
                }>("/projects", { name });
                await s.refresh();
                s.set({
                  projectId: result.project.id,
                  sessionId: result.session.id,
                  reference: null,
                  maskId: "",
                  canvasFocusId: "",
                });
                setProjectModal(false);
                setName("");
              } catch (e) {
                s.set({ error: (e as Error).message });
              }
            }}
          >
            创建项目
          </Button>
        </Modal>
      )}
    </div>
  );
}
