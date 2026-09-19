import { useEffect, useState, useRef, useCallback } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  MiniMap,
  Handle,
  Position,
  applyNodeChanges,
  applyEdgeChanges,
  addEdge,
  useReactFlow,
  useViewport,
  type Edge,
  type NodeChange,
  type EdgeChange,
  type Connection,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  Plus,
  Undo2,
  Redo2,
  Group,
  Copy,
  Trash2,
  Download,
  Upload,
  History,
  Maximize2,
  Sparkles,
  ImagePlus,
  MessageSquare,
  Split,
  FileText,
  ArrowUpRight,
  CheckCircle2,
  Clock,
  Hand,
  MousePointer2,
  Minus,
  ChevronDown,
  LocateFixed,
} from "lucide-react";
import { useStore } from "./store";
import { api, post, put, downloadJSON, money } from "./api";
import {
  Button,
  Modal,
  ImageDetail,
  ImageActions,
  useAction,
} from "./components";
import type {
  Canvas,
  Project,
  Session,
  Task,
  ImageAsset,
} from "../shared/types";
import {
  reconcileCanvas,
  nodeForImage,
  nodeImageIds,
  nodeTaskIds,
  hiddenAfterRemoving,
  type WorkNode,
  type Graph,
} from "./canvas-graph";
import { BatchNode } from "./BatchNode";
const statusLabel: Record<string, string> = {
  queued: "等待中",
  running: "正在生成",
  succeeded: "已完成",
  failed: "失败",
  dead: "重试耗尽",
  cancelled: "已取消",
};
function WorkNodeView({ data, selected }: NodeProps<WorkNode>) {
  const s = useStore();
  const image = s.data.images.find((i) => i.id === data.imageId);
  const task = s.data.tasks.find((t) => t.id === data.taskId);
  const type = String(data.kind || "prompt");
  if (type === "batch") return <BatchNode data={data} selected={selected} />;
  return (
    <div className={`work-node ${selected ? "selected" : ""} kind-${type}`}>
      <Handle type="target" position={Position.Left} />
      {type === "image" ? (
        image ? (
          <>
            <img
              className="node-image"
              src={image.thumbnailUrl}
              draggable={false}
            />
            <div className="node-image-caption">
              <span>{image.model}</span>
              <small>
                {image.width} × {image.height}
              </small>
            </div>
            <ImageActions image={image} compact />
          </>
        ) : (
          <div className="missing-image">
            此图片不在当前设备上
            <br />
            可重新导入原图
          </div>
        )
      ) : type === "generation" ? (
        <>
          <div className="node-header">
            <Sparkles size={15} />
            <strong>{task?.modelName || "生成任务"}</strong>
            <span className={`status ${task?.status}`}>
              {statusLabel[task?.status || "queued"]}
            </span>
          </div>
          <p>{task?.prompt || String(data.text || "")}</p>
          <div className="node-meta">
            <span>{task?.params.size}</span>
            <span>
              {task
                ? money(task.actualCost ?? task.estimatedCost, task.currency)
                : ""}
            </span>
          </div>
          {task?.error && <small className="node-error">{task.error}</small>}
        </>
      ) : (
        <>
          <div className="node-header">
            {type === "chat" ? (
              <MessageSquare size={15} />
            ) : (
              <FileText size={15} />
            )}
            <strong>{type === "chat" ? "追问记录" : "提示词"}</strong>
          </div>
          <p className="pre-wrap">{String(data.text || "双击编辑提示词")}</p>
          <button
            className="node-use nodrag nopan"
            onClick={() => {
              s.setPrompt(String(data.text || ""));
              s.set({ composerFocus: Date.now() });
            }}
          >
            用这段提示词
            <ArrowUpRight size={13} />
          </button>
        </>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
const nodeTypes = { work: WorkNodeView };
function ZoomControls() {
  const flow = useReactFlow();
  const { zoom } = useViewport();
  return (
    <div className="canvas-zoom" aria-label="画布缩放">
      <button
        aria-label="缩小画布"
        disabled={zoom <= 0.12}
        onClick={() => flow.zoomOut({ duration: 160 })}
      >
        <Minus size={16} />
      </button>
      <button
        className="zoom-value"
        aria-label="恢复到 100% 缩放"
        title="点击恢复 100%"
        onClick={() => flow.zoomTo(1, { duration: 160 })}
      >
        {Math.round(zoom * 100)}%
      </button>
      <button
        aria-label="放大画布"
        disabled={zoom >= 2.5}
        onClick={() => flow.zoomIn({ duration: 160 })}
      >
        <Plus size={16} />
      </button>
    </div>
  );
}
export function CanvasPage() {
  const projectId = useStore((s) => s.projectId);
  return (
    <ReactFlowProvider key={projectId}>
      <CanvasInner />
    </ReactFlowProvider>
  );
}
function CanvasInner() {
  const s = useStore();
  const flow = useReactFlow<WorkNode>();
  const [graph, setGraph] = useState<Graph>({
    nodes: [],
    edges: [],
    hiddenTaskIds: [],
    hiddenImageIds: [],
  });
  const graphRef = useRef(graph);
  graphRef.current = graph;
  const [dirty, setDirty] = useState(0);
  const [saved, setSaved] = useState("已保存");
  const revision = useRef(0);
  const loaded = useRef("");
  const [undo, setUndo] = useState<Graph[]>([]);
  const [redo, setRedo] = useState<Graph[]>([]);
  const [interaction, setInteraction] = useState<"pan" | "select">("pan");
  const stageRef = useRef<HTMLDivElement>(null);
  const [context, setContext] = useState<{
    x: number;
    y: number;
    node: WorkNode;
  } | null>(null);
  const [detail, setDetail] = useState<string>("");
  const [edit, setEdit] = useState<{ id: string; text: string } | null>(null);
  const [versions, setVersions] = useState<
    { id: string; name: string; createdAt: number; canvas: Canvas }[] | null
  >(null);
  const importRef = useRef<HTMLInputElement>(null);
  const action = useAction();
  const project = s.data.projects.find((p) => p.id === s.projectId);
  const images = s.data.images.filter(
    (i) => i.projectId === s.projectId && i.prompt !== "局部重绘遮罩",
  );
  const tasks = s.data.tasks.filter((t) => t.projectId === s.projectId);
  const selectedNodes = graph.nodes.filter((n) => n.selected);
  const selectedImage =
    selectedNodes.length === 1
      ? images.find(
          (i) =>
            i.id === selectedNodes[0].data.imageId ||
            (i.id === s.selectedImageId &&
              nodeImageIds(selectedNodes[0]).includes(i.id)),
        )
      : undefined;
  const latestImageNode = images
    .sort((a, b) => b.createdAt - a.createdAt)
    .find((i) => nodeForImage(graph.nodes, i.id));
  const pendingSave = useRef(false);
  const savePromise = useRef<Promise<void> | null>(null);
  function checkpoint() {
    setUndo((v) => [...v.slice(-39), structuredClone(graphRef.current)]);
    setRedo([]);
  }
  function change(next: Graph | ((g: Graph) => Graph)) {
    const value = typeof next === "function" ? next(graphRef.current) : next;
    graphRef.current = value;
    setGraph(value);
    pendingSave.current = true;
    setDirty((n) => n + 1);
    setSaved("正在保存…");
  }
  useEffect(() => {
    if (!project || loaded.current === project.id) return;
    loaded.current = project.id;
    revision.current = project.revision;
    const value = {
      nodes: project.canvas.nodes as WorkNode[],
      edges: project.canvas.edges,
      hiddenTaskIds: project.canvas.hiddenTaskIds || [],
      hiddenImageIds: project.canvas.hiddenImageIds || [],
    };
    graphRef.current = value;
    setGraph(value);
    setUndo([]);
    setRedo([]);
    setDirty(0);
    setSaved("已保存");
    if (project.canvas.viewport) void flow.setViewport(project.canvas.viewport);
  }, [project?.id]);
  useEffect(() => {
    if (!project || loaded.current !== project.id) return;
    const current = graphRef.current;
    const next = reconcileCanvas(current, tasks, images);
    if (next !== current) change(next);
  }, [
    s.projectId,
    tasks.map((t) => t.id).join(","),
    images.map((i) => i.id).join(","),
    project?.id,
  ]);
  const persist = useCallback(async () => {
    if (!loaded.current) return;
    if (savePromise.current) return savePromise.current;
    savePromise.current = (async () => {
      while (pendingSave.current) {
        pendingSave.current = false;
        const projectId = loaded.current;
        const snapshot = graphRef.current;
        try {
          const body = JSON.stringify({
            revision: revision.current,
            canvas: { ...snapshot, viewport: flow.getViewport() },
          });
          const p = await api<Project>("/projects/" + projectId + "/canvas", {
            method: "PUT",
            body,
            keepalive: new Blob([body]).size < 60000,
          });
          revision.current = p.revision;
          const current = useStore.getState();
          current.set({
            data: {
              ...current.data,
              projects: current.data.projects.map((v) =>
                v.id === p.id ? p : v,
              ),
            },
          });
          setSaved(pendingSave.current ? "正在保存…" : "已保存");
        } catch (e) {
          pendingSave.current = true;
          setSaved("保存失败");
          s.set({ error: (e as Error).message });
          break;
        }
      }
    })();
    try {
      await savePromise.current;
    } finally {
      savePromise.current = null;
    }
  }, []);
  useEffect(() => {
    if (!dirty) return;
    const timer = setTimeout(() => void persist(), 700);
    return () => clearTimeout(timer);
  }, [dirty, persist]);
  useEffect(() => {
    const flush = async () => {
      await persist();
      if (pendingSave.current)
        throw new Error("画布尚未保存，请重试后再切换页面");
    };
    useStore.getState().set({ flushCanvas: flush });
    const onHide = () => void persist();
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      if (useStore.getState().flushCanvas === flush)
        useStore.getState().set({ flushCanvas: undefined });
      void persist();
    };
  }, [persist]);
  useEffect(() => {
    const target =
      graph.nodes.find((n) => n.id === s.canvasFocusId) ||
      (s.canvasFocusId.startsWith("image-")
        ? nodeForImage(graph.nodes, s.canvasFocusId.slice(6))
        : undefined);
    if (!target) {
      const hiddenImage = images.find(
        (i) =>
          "image-" + i.id === s.canvasFocusId &&
          (graph.hiddenImageIds.includes(i.id) ||
            graph.hiddenTaskIds.includes(i.taskId || "")),
      );
      if (hiddenImage) {
        setDetail(hiddenImage.id);
        s.set({ canvasFocusId: "" });
      }
      return;
    }
    if (!target?.measured?.width) return;
    const next = {
      ...graphRef.current,
      nodes: graphRef.current.nodes.map((n) => ({
        ...n,
        selected: n.id === target.id,
      })),
    };
    graphRef.current = next;
    setGraph(next);
    void flow.fitView({
      nodes: [{ id: target.id }],
      padding: 0.3,
      maxZoom: 1,
      duration: 250,
    });
    stageRef.current?.parentElement?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
    s.set({
      canvasFocusId: "",
      ...(s.canvasFocusId.startsWith("image-")
        ? { selectedImageId: s.canvasFocusId.slice(6) }
        : {}),
    });
  }, [s.canvasFocusId, graph.nodes]);
  function note(kind = "prompt", text = "") {
    const bounds = stageRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const center = flow.screenToFlowPosition({
      x: bounds.left + bounds.width / 2,
      y: bounds.top + bounds.height / 2,
    });
    checkpoint();
    change((g) => ({
      ...g,
      nodes: [
        ...g.nodes,
        {
          id: crypto.randomUUID(),
          type: "work",
          position: { x: center.x - 145, y: center.y - 70 },
          data: { kind, text: text || s.prompt || "在这里写下你的创作想法…" },
        },
      ],
    }));
  }
  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      note(detail.type, detail.text);
    };
    window.addEventListener("canvas-add-note", listener);
    return () => window.removeEventListener("canvas-add-note", listener);
  }, [s.prompt]);
  function deleteSelected() {
    const selected = new Set(
      graph.nodes.filter((n) => n.selected).map((n) => n.id),
    );
    const children = graph.nodes.filter(
      (n) => n.parentId && selected.has(n.parentId),
    );
    children.forEach((n) => selected.add(n.id));
    checkpoint();
    change((g) => ({
      ...g,
      nodes: g.nodes.filter((n) => !selected.has(n.id)),
      edges: g.edges.filter(
        (e) => !selected.has(e.source) && !selected.has(e.target),
      ),
      ...hiddenAfterRemoving(g, selected),
    }));
  }
  function duplicate() {
    const selected = graph.nodes.filter((n) => n.selected && !n.parentId);
    if (!selected.length) return;
    checkpoint();
    change((g) => ({
      ...g,
      nodes: [
        ...g.nodes.map((n) => ({ ...n, selected: false })),
        ...selected.map((n) => ({
          ...structuredClone(n),
          id: crypto.randomUUID(),
          position: { x: n.position.x + 40, y: n.position.y + 40 },
        })),
      ],
    }));
  }
  function group() {
    const selected = graph.nodes.filter(
      (n) => n.selected && !n.parentId && n.type !== "group",
    );
    if (!selected.length) return;
    checkpoint();
    const x = Math.min(...selected.map((n) => n.position.x)) - 30;
    const y = Math.min(...selected.map((n) => n.position.y)) - 50;
    const id = crypto.randomUUID();
    change((g) => ({
      ...g,
      nodes: [
        {
          id,
          type: "group",
          position: { x, y },
          style: {
            width:
              Math.max(
                ...selected.map(
                  (n) => n.position.x + (n.measured?.width || 330),
                ),
              ) -
              x +
              25,
            height:
              Math.max(
                ...selected.map(
                  (n) => n.position.y + (n.measured?.height || 250),
                ),
              ) -
              y +
              30,
          },
          data: { label: "创作分组" },
        },
        ...g.nodes.map((n) =>
          selected.some((v) => v.id === n.id)
            ? {
                ...n,
                parentId: id,
                position: { x: n.position.x - x, y: n.position.y - y },
                extent: "parent" as const,
              }
            : n,
        ),
      ],
    }));
  }
  function ungroup() {
    const parents = graph.nodes.filter((n) => n.selected && n.type === "group");
    if (!parents.length) return;
    checkpoint();
    change((g) => ({
      ...g,
      nodes: g.nodes
        .filter((n) => !parents.some((p) => p.id === n.id))
        .map((n) => {
          const p = parents.find((p) => p.id === n.parentId);
          return p
            ? {
                ...n,
                parentId: undefined,
                extent: undefined,
                position: {
                  x: n.position.x + p.position.x,
                  y: n.position.y + p.position.y,
                },
              }
            : n;
        }),
    }));
  }
  function undoAction() {
    if (!undo.length) return;
    setRedo((v) => [...v, graph]);
    change(undo[undo.length - 1]);
    setUndo((v) => v.slice(0, -1));
  }
  function redoAction() {
    if (!redo.length) return;
    setUndo((v) => [...v, graph]);
    change(redo[redo.length - 1]);
    setRedo((v) => v.slice(0, -1));
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input,textarea,[contenteditable]"))
        return;
      if ((e.ctrlKey || e.metaKey) && e.key === "z") {
        e.preventDefault();
        e.shiftKey ? redoAction() : undoAction();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "d") {
        e.preventDefault();
        duplicate();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [graph, undo, redo]);
  function nodesChange(changes: NodeChange<WorkNode>[]) {
    const remove = changes.filter((c) => c.type === "remove");
    if (remove.length) {
      checkpoint();
      change((g) => ({
        ...g,
        nodes: applyNodeChanges(changes, g.nodes),
        ...hiddenAfterRemoving(g, new Set(remove.map((c) => c.id))),
      }));
    } else if (changes.some((c) => c.type === "position"))
      change((g) => ({ ...g, nodes: applyNodeChanges(changes, g.nodes) }));
    else {
      const next = {
        ...graphRef.current,
        nodes: applyNodeChanges(changes, graphRef.current.nodes),
      };
      graphRef.current = next;
      setGraph(next);
    }
  }
  const imageDetail = s.data.images.find((i) => i.id === detail);
  const contextImage = s.data.images.find(
    (i) => i.id === context?.node.data.imageId,
  );
  return (
    <div className="canvas-page">
      <div className="canvas-heading">
        <div>
          <h1>创作画布</h1>
          <p>一份提示词连向多张图片，从任意图片继续分支创作。</p>
        </div>
        <div className="canvas-save">
          <span className="status-dot live" />
          {saved}
        </div>
        <Button
          className="canvas-compose-link"
          onClick={() => s.set({ composerFocus: Date.now() })}
        >
          <Sparkles size={14} />
          写描述，生成图片
        </Button>
      </div>
      <div className="canvas-toolbar">
        <div>
          <div className="canvas-modes" aria-label="画布操作模式">
            <button
              aria-pressed={interaction === "pan"}
              onClick={() => setInteraction("pan")}
              title="左键拖空白移动画布，拖图片移动节点"
            >
              <Hand size={15} />
              拖动
            </button>
            <button
              aria-pressed={interaction === "select"}
              onClick={() => setInteraction("select")}
              title="左键拖空白框选多个节点，也可按住 Shift 框选"
            >
              <MousePointer2 size={15} />
              框选
            </button>
          </div>
          <span className="toolbar-rule" />
          <button
            className="icon-btn"
            title="撤销 Ctrl+Z"
            disabled={!undo.length}
            onClick={undoAction}
          >
            <Undo2 size={17} />
          </button>
          <button
            className="icon-btn"
            title="重做 Ctrl+Shift+Z"
            disabled={!redo.length}
            onClick={redoAction}
          >
            <Redo2 size={17} />
          </button>
        </div>
        <div>
          <Button
            title="缩放并居中显示所有节点"
            onClick={() =>
              flow.fitView({ padding: 0.15, maxZoom: 1, duration: 250 })
            }
          >
            <Maximize2 size={15} />
            查看全部
          </Button>
          <details className="canvas-more">
            <summary>
              更多工具
              <ChevronDown size={14} />
            </summary>
            <div
              className="canvas-tool-menu"
              onClick={(e) =>
                e.currentTarget.closest("details")?.removeAttribute("open")
              }
            >
              <button onClick={() => note()}>
                <Plus size={15} />
                添加提示词节点
              </button>
              <button onClick={() => note("chat")}>
                <MessageSquare size={15} />
                添加笔记节点
              </button>
              <hr />
              <button
                disabled={
                  !selectedNodes.some((n) => !n.parentId && n.type !== "group")
                }
                onClick={group}
              >
                <Group size={15} />
                编组所选节点
              </button>
              <button
                disabled={!selectedNodes.some((n) => n.type === "group")}
                onClick={ungroup}
              >
                <Split size={15} />
                取消所选分组
              </button>
              <button
                disabled={!selectedNodes.some((n) => !n.parentId)}
                onClick={duplicate}
              >
                <Copy size={15} />
                复制所选
              </button>
              <button disabled={!selectedNodes.length} onClick={deleteSelected}>
                <Trash2 size={15} />
                从画布移除所选
              </button>
              <hr />
              <button
                title="版本历史"
                onClick={() =>
                  action.run(async () => {
                    await persist();
                    setVersions(
                      await api("/projects/" + s.projectId + "/versions"),
                    );
                  })
                }
              >
                <History size={15} />
                版本历史
              </button>
              <button
                title="导出项目 JSON"
                onClick={() =>
                  action.run(async () => {
                    await persist();
                    downloadJSON(
                      (project?.name || "project") + ".json",
                      await api("/projects/" + s.projectId + "/export"),
                    );
                  })
                }
              >
                <Download size={15} />
                导出项目 JSON
              </button>
              <button
                title="导入项目 JSON"
                onClick={() => importRef.current?.click()}
              >
                <Upload size={15} />
                导入项目 JSON
              </button>
            </div>
          </details>
        </div>
      </div>
      <div className="canvas-help">
        <span className="desktop-canvas-help">
          {interaction === "pan"
            ? "拖空白移画布 · 拖图片改位置 · Shift 框选 · 滚轮缩放"
            : "拖空白框选 · 中键移动画布 · 点击「拖动」返回"}
        </span>
        <span className="touch-canvas-help">
          {interaction === "pan"
            ? "单指拖动画布或图片 · 双指缩放"
            : "拖空白框选 · 点击「拖动」返回"}
        </span>
        {latestImageNode && (
          <button
            className="text-button"
            onClick={() =>
              s.set({ canvasFocusId: "image-" + latestImageNode.id })
            }
          >
            <LocateFixed size={13} />
            最新作品
          </button>
        )}
      </div>
      <input
        type="file"
        ref={importRef}
        accept="application/json"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file)
            void action.run(async () => {
              const data = await post<{ project: Project; session: Session }>(
                "/projects/import",
                JSON.parse(await file.text()),
              );
              await s.refresh();
              s.set({ projectId: data.project.id, sessionId: data.session.id });
            });
          e.target.value = "";
        }}
      />
      <div className={`flow-stage mode-${interaction}`} ref={stageRef}>
        <ReactFlow
          nodes={graph.nodes}
          edges={graph.edges}
          nodeTypes={nodeTypes}
          onNodesChange={nodesChange}
          onEdgesChange={(changes) => {
            if (changes.some((c) => c.type === "remove")) checkpoint();
            change((g) => ({
              ...g,
              edges: applyEdgeChanges(changes, g.edges),
            }));
          }}
          onConnect={(connection) => {
            checkpoint();
            change((g) => ({ ...g, edges: addEdge(connection, g.edges) }));
          }}
          onNodeDragStart={checkpoint}
          onSelectionDragStart={checkpoint}
          onNodeDoubleClick={(_e, node) =>
            node.data.imageId
              ? setDetail(String(node.data.imageId))
              : ["prompt", "chat"].includes(String(node.data.kind))
                ? setEdit({ id: node.id, text: String(node.data.text || "") })
                : undefined
          }
          onNodeContextMenu={(e, node) => {
            e.preventDefault();
            setContext({
              x: Math.min(e.clientX, window.innerWidth - 240),
              y: Math.min(e.clientY, window.innerHeight - 290),
              node,
            });
          }}
          onPaneClick={() => setContext(null)}
          onMoveEnd={() => {
            pendingSave.current = true;
            setDirty((n) => n + 1);
            setSaved("正在保存…");
          }}
          minZoom={0.12}
          maxZoom={2.5}
          deleteKeyCode={["Backspace", "Delete"]}
          selectionOnDrag={interaction === "select"}
          panOnDrag={interaction === "pan" ? [0, 1, 2] : [1, 2]}
          selectionKeyCode="Shift"
          nodeDragThreshold={4}
          zoomOnDoubleClick={false}
          fitView={!project?.canvas.viewport}
          fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
          defaultEdgeOptions={{
            style: { stroke: "#bca38e", strokeWidth: 1.6 },
            type: "smoothstep",
          }}
        >
          <Background color="#d9d5cc" gap={24} size={1} />
          <MiniMap
            nodeColor={(n) =>
              n.data.kind === "image"
                ? "#b96549"
                : n.data.kind === "generation"
                  ? "#899276"
                  : "#d8c9b6"
            }
            maskColor="rgba(245,243,238,.65)"
            pannable
            zoomable
          />
        </ReactFlow>
        {!graph.nodes.length && (
          <div className="canvas-welcome">
            <div className="welcome-symbol">
              <Sparkles size={36} strokeWidth={1} />
            </div>
            <h2>好作品，从一个想法开始。</h2>
            <p>
              在生成面板描述你的画面。
              <br />
              生成的图片会来到这里，连接成你的创作历程。
            </p>
            <div className="idea-chips">
              {[
                "暖木工坊里的午后阳光",
                "柔和光线中的静物摄影",
                "一张极简的奇幻游戏封面",
              ].map((text) => (
                <button
                  key={text}
                  onClick={() =>
                    s.set({ prompt: text, composerFocus: Date.now() })
                  }
                >
                  {text}
                  <ArrowUpRight size={13} />
                </button>
              ))}
            </div>
            <small>点选上方示例，或打开生成面板写下你的想法</small>
          </div>
        )}
        <ZoomControls />
        {selectedNodes.length > 0 &&
          !(
            selectedNodes.length === 1 && selectedNodes[0].data.kind === "batch"
          ) && (
            <div className="canvas-selection-bar">
              {selectedImage ? (
                <>
                  <span>已选图片</span>
                  <button
                    onClick={() => {
                      s.beginEdit(selectedImage);
                      s.toast("已选好原图，写下修改要求后点击“生成新版本”");
                    }}
                  >
                    <ImagePlus size={15} />
                    修改这张图
                  </button>
                  <button onClick={() => setDetail(selectedImage.id)}>
                    <Maximize2 size={14} />
                    查看原图
                  </button>
                </>
              ) : (
                <>
                  <span>已选 {selectedNodes.length} 项</span>
                  <button
                    onClick={group}
                    disabled={
                      !selectedNodes.some(
                        (n) => !n.parentId && n.type !== "group",
                      )
                    }
                  >
                    <Group size={15} />
                    编组
                  </button>
                  <button
                    onClick={duplicate}
                    disabled={!selectedNodes.some((n) => !n.parentId)}
                  >
                    <Copy size={15} />
                    复制
                  </button>
                </>
              )}
            </div>
          )}
        <div className="canvas-bottom-note">
          {images.length} 张作品<span>·</span>
          {tasks.filter((t) => t.status === "running").length} 个任务正在创作
        </div>
      </div>
      {context && (
        <div
          className="context-menu"
          style={{ left: context.x, top: context.y }}
          onMouseLeave={() => setContext(null)}
        >
          {contextImage ? (
            <>
              <button
                onClick={() => {
                  s.beginEdit(contextImage);
                  setContext(null);
                }}
              >
                修改这张图
              </button>
              <button
                onClick={() => {
                  s.beginEdit(contextImage, "保持角色与构图，改成温暖的夜景。");
                  setContext(null);
                }}
              >
                快捷修改：改成夜景
              </button>
              <button
                onClick={() => {
                  s.beginEdit(
                    contextImage,
                    "保持人物设定与画风，探索新的构图变体。",
                  );
                  setContext(null);
                }}
              >
                生成变体
              </button>
              <button
                onClick={() => {
                  s.beginEdit(
                    contextImage,
                    "只重绘遮罩区域，其他内容保持一致。",
                  );
                  s.toast("请在修改面板点击“可选：只修改局部区域”");
                  setContext(null);
                }}
              >
                局部重绘
              </button>
              <button
                onClick={() => {
                  setDetail(contextImage.id);
                  setContext(null);
                }}
              >
                查看原图与元数据
              </button>
            </>
          ) : context.node.data.kind === "batch" ? (
            <button
              onClick={() => {
                const task = tasks.find((t) =>
                  nodeTaskIds(context.node).includes(t.id),
                );
                if (task) s.reuseTask(task);
                setContext(null);
              }}
            >
              复用本轮提示词与参数
            </button>
          ) : (
            <button
              onClick={() => {
                setEdit({
                  id: context.node.id,
                  text: String(context.node.data.text || ""),
                });
                setContext(null);
              }}
            >
              编辑内容
            </button>
          )}
        </div>
      )}
      {imageDetail && (
        <ImageDetail image={imageDetail} onClose={() => setDetail("")} />
      )}{" "}
      {edit && (
        <Modal title="编辑节点" onClose={() => setEdit(null)}>
          <textarea
            rows={7}
            value={edit.text}
            onChange={(e) => setEdit({ ...edit, text: e.target.value })}
          />
          <Button
            variant="primary"
            onClick={() => {
              checkpoint();
              change((g) => ({
                ...g,
                nodes: g.nodes.map((n) =>
                  n.id === edit.id
                    ? { ...n, data: { ...n.data, text: edit.text } }
                    : n,
                ),
              }));
              setEdit(null);
            }}
          >
            保存内容
          </Button>
        </Modal>
      )}
      {versions && (
        <Modal title="画布版本" onClose={() => setVersions(null)}>
          <p className="muted">
            快照保存节点和连线。回滚不会删除已经生成的图片。
          </p>
          <Button
            onClick={() =>
              action.run(async () => {
                await persist();
                await post("/projects/" + s.projectId + "/versions", {
                  name: "快照 " + new Date().toLocaleTimeString(),
                });
                setVersions(
                  await api("/projects/" + s.projectId + "/versions"),
                );
              })
            }
          >
            <Plus size={15} />
            保存当前快照
          </Button>
          {versions.map((v) => (
            <div className="version-row" key={v.id}>
              <span>{v.name}</span>
              <div>
                <Button
                  onClick={() =>
                    action.run(async () => {
                      const result = await post<Project>(
                        "/projects/" + s.projectId + "/restore/" + v.id,
                      );
                      revision.current = result.revision;
                      setGraph({
                        nodes: result.canvas.nodes as WorkNode[],
                        edges: result.canvas.edges,
                        hiddenTaskIds: result.canvas.hiddenTaskIds || [],
                        hiddenImageIds: result.canvas.hiddenImageIds || [],
                      });
                      await s.refresh();
                      setVersions(null);
                    })
                  }
                >
                  回滚
                </Button>
                <Button
                  onClick={() =>
                    action.run(async () => {
                      const result = await post<{
                        project: Project;
                        session: Session;
                      }>("/projects/import", {
                        schemaVersion: 1,
                        project: {
                          name: project?.name + " 分支",
                          canvas: v.canvas,
                        },
                      });
                      await s.refresh();
                      s.set({
                        projectId: result.project.id,
                        sessionId: result.session.id,
                      });
                      setVersions(null);
                    })
                  }
                >
                  分支
                </Button>
              </div>
            </div>
          ))}
        </Modal>
      )}
    </div>
  );
}
