import type { Edge, Node } from "@xyflow/react";
import type { ImageAsset, Task } from "../shared/types";

export type WorkNode = Node<Record<string, unknown>>;
export type Graph = {
  nodes: WorkNode[];
  edges: Edge[];
  hiddenTaskIds: string[];
  hiddenImageIds: string[];
};
export const nodeTaskIds = (node: WorkNode): string[] =>
  Array.isArray(node.data.taskIds)
    ? (node.data.taskIds as string[])
    : node.data.taskId
      ? [String(node.data.taskId)]
      : [];
export const nodeImageIds = (node: WorkNode): string[] =>
  Array.isArray(node.data.imageIds)
    ? (node.data.imageIds as string[])
    : node.data.imageId
      ? [String(node.data.imageId)]
      : [];
export const nodeForImage = (nodes: WorkNode[], id: string) =>
  nodes.find((node) => nodeImageIds(node).includes(id));

export function hiddenAfterRemoving(graph: Graph, removed: Set<string>) {
  const kept = graph.nodes.filter((node) => !removed.has(node.id));
  const deleted = graph.nodes.filter((node) => removed.has(node.id));
  return {
    hiddenTaskIds: [
      ...new Set([
        ...graph.hiddenTaskIds,
        ...deleted
          .flatMap(nodeTaskIds)
          .filter((id) => !kept.some((n) => nodeTaskIds(n).includes(id))),
      ]),
    ],
    hiddenImageIds: [
      ...new Set([
        ...graph.hiddenImageIds,
        ...deleted
          .flatMap(nodeImageIds)
          .filter((id) => !kept.some((n) => nodeImageIds(n).includes(id))),
      ]),
    ],
  };
}

// 后台仍逐张执行。画布只按一轮中的同一提示词归并，变体和下一轮各有自己的节点。
export function reconcileCanvas(
  current: Graph,
  tasks: Task[],
  images: ImageAsset[],
): Graph {
  const groups = new Map<string, Task[]>();
  const ordered = [...tasks].sort(
    (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
  );
  for (const task of ordered) {
    if (current.hiddenTaskIds.includes(task.id)) continue;
    const key = JSON.stringify([task.batchId, task.prompt]);
    groups.set(key, [...(groups.get(key) || []), task]);
  }
  const visibleImages = images.filter(
    (image) =>
      !current.hiddenImageIds.includes(image.id) &&
      !current.hiddenTaskIds.includes(image.taskId || ""),
  );
  const replacements = new Map<string, string>();
  const batchNodes: WorkNode[] = [];
  const fresh = new Set<string>();
  for (const items of groups.values()) {
    const taskIds = items.map((t) => t.id);
    const existing = current.nodes.filter(
      (n) =>
        n.data.kind === "batch" &&
        nodeTaskIds(n).some((id) => taskIds.includes(id)),
    );
    const old = current.nodes.filter(
      (n) =>
        n.data.kind === "generation" && taskIds.includes(String(n.data.taskId)),
    );
    const anchor =
      existing[0] || old.find((n) => n.data.kind === "generation") || old[0];
    // 第一个任务的 ID 稳定且全局唯一，不把长提示词写进节点 ID。
    const id = existing[0]?.id || `batch-${items[0].id}`;
    for (const node of old) replacements.set(node.id, id);
    const data = {
      kind: "batch",
      batchId: items[0].batchId,
      prompt: items[0].prompt,
      taskIds,
      imageIds: [],
    };
    if (existing.length) {
      for (const n of existing) if (nodeImageIds(n).length) fresh.add(n.id);
      // 保留用户复制出来的节点及其位置。
      batchNodes.push(
        ...existing.map((n) => ({ ...n, data: { ...n.data, ...data } })),
      );
    } else {
      const node: WorkNode = {
        id,
        type: "work",
        position: anchor?.position || {
          x: 60,
          y:
            80 +
            batchNodes.reduce(
              (height, node) =>
                height + Math.max(1, nodeTaskIds(node).length) * 340 + 100,
              0,
            ),
        },
        ...(anchor?.parentId
          ? { parentId: anchor.parentId, extent: anchor.extent }
          : {}),
        data,
      };
      batchNodes.push(node);
      if (!anchor) fresh.add(id);
    }
  }
  const nodes = current.nodes.filter(
    (n) => !replacements.has(n.id) && !batchNodes.some((b) => b.id === n.id),
  );
  nodes.push(...batchNodes);
  const newImageIds = new Set<string>();
  const absolutePosition = (node: WorkNode): { x: number; y: number } => {
    const parent = nodes.find((n) => n.id === node.parentId);
    const offset = parent ? absolutePosition(parent) : { x: 0, y: 0 };
    return { x: node.position.x + offset.x, y: node.position.y + offset.y };
  };
  for (const image of visibleImages) {
    if (nodeForImage(nodes, image.id)) continue;
    const source = batchNodes.find((n) =>
      nodeTaskIds(n).includes(image.taskId || ""),
    );
    const siblings = visibleImages.filter(
      (i) => source && nodeTaskIds(source).includes(i.taskId || ""),
    );
    const origin = source ? absolutePosition(source) : { x: 270, y: 80 };
    newImageIds.add(image.id);
    nodes.push({
      id: `image-${image.id}`,
      type: "work",
      position: {
        x: origin.x + 380,
        y:
          origin.y +
          (source
            ? siblings.indexOf(image)
            : nodes.filter((n) => n.data.kind === "image").length) *
            340,
      },
      data: { kind: "image", imageId: image.id },
    });
  }
  const edges = current.edges
    .filter((e) => !e.id.startsWith("result-") && !e.id.startsWith("parent-"))
    .map((e) => ({
      ...e,
      source: replacements.get(e.source) || e.source,
      target: replacements.get(e.target) || e.target,
    }))
    .filter(
      (e) =>
        e.source !== e.target &&
        nodes.some((n) => n.id === e.source) &&
        nodes.some((n) => n.id === e.target),
    );
  for (const node of batchNodes) {
    const task = tasks.find(
      (t) => nodeTaskIds(node).includes(t.id) && t.parentImageId,
    );
    if (!task?.parentImageId) continue;
    const parent = nodeForImage(nodes, task.parentImageId);
    if (!parent || parent.id === node.id) continue;
    if (fresh.has(node.id)) {
      const origin = absolutePosition(parent);
      const ownGroup = nodes.find((n) => n.id === node.parentId);
      const offset = ownGroup ? absolutePosition(ownGroup) : { x: 0, y: 0 };
      const siblings = batchNodes.filter((n) =>
        tasks.some(
          (t) =>
            nodeTaskIds(n).includes(t.id) &&
            t.parentImageId === task.parentImageId,
        ),
      );
      node.position = {
        x: origin.x - offset.x + 380,
        y:
          origin.y -
          offset.y +
          siblings
            .slice(0, siblings.indexOf(node))
            .reduce(
              (height, sibling) =>
                height + Math.max(1, nodeTaskIds(sibling).length) * 340 + 100,
              0,
            ),
      };
    }
    const outputs = visibleImages.filter((i) =>
      nodeTaskIds(node).includes(i.taskId || ""),
    );
    outputs.forEach((image, index) => {
      const output = nodeForImage(nodes, image.id);
      if (output && newImageIds.has(image.id)) {
        const origin = absolutePosition(node);
        output.position = { x: origin.x + 380, y: origin.y + index * 340 };
      }
    });
    edges.push({
      id: `parent-${node.id}`,
      source: parent.id,
      target: node.id,
      label: task.fallback ? "文本迭代" : "参考原图",
    });
  }
  for (const image of visibleImages) {
    const output = nodeForImage(nodes, image.id);
    const source = batchNodes.find((n) =>
      nodeTaskIds(n).includes(image.taskId || ""),
    );
    if (source && output)
      edges.push({
        id: `result-${image.id}`,
        source: source.id,
        target: output.id,
      });
  }
  // 父容器在前，其次提示词，再到独立图片；保证首次拆分与刷新顺序稳定。
  const rank = (node: WorkNode) =>
    node.type === "group" ? 0 : node.data.kind === "batch" ? 1 : 2;
  nodes.sort((a, b) => rank(a) - rank(b));
  const result = { ...current, nodes, edges };
  return JSON.stringify(result) === JSON.stringify(current) ? current : result;
}
