import { test } from "node:test";
import assert from "node:assert/strict";
import {
  reconcileCanvas,
  nodeForImage,
  hiddenAfterRemoving,
  type Graph,
} from "../src/canvas-graph";
import type { Task, ImageAsset } from "../shared/types";

const task = (id: string, extra: Partial<Task> = {}) =>
  ({
    id,
    batchId: "round-1",
    prompt: "同一个提示词",
    createdAt: Number(id) || 10,
    ...extra,
  }) as Task;
const image = (id: string, taskId?: string) => ({ id, taskId }) as ImageAsset;
const empty = (): Graph => ({
  nodes: [],
  edges: [],
  hiddenTaskIds: [],
  hiddenImageIds: [],
});

test("删除复制的卡片不会隐藏仍在原卡片中的任务和图片", () => {
  const original = {
    id: "original",
    position: { x: 0, y: 0 },
    data: { kind: "batch", taskIds: ["1"], imageIds: ["a"] },
  };
  const graph = { ...empty(), nodes: [original, { ...original, id: "copy" }] };
  assert.deepEqual(hiddenAfterRemoving(graph, new Set(["copy"])), {
    hiddenTaskIds: [],
    hiddenImageIds: [],
  });
  assert.deepEqual(hiddenAfterRemoving(graph, new Set(["copy", "original"])), {
    hiddenTaskIds: ["1"],
    hiddenImageIds: ["a"],
  });
});

test("同轮保留一份提示词，每张图片独立连线并保留手动位置", () => {
  const tasks = [task("1"), task("2", { modelName: "另一个模型" }), task("3")];
  const images = [image("a", "1"), image("b", "2"), image("c", "3")];
  const old: Graph = {
    ...empty(),
    nodes: [
      {
        id: "note",
        position: { x: 0, y: 0 },
        data: { kind: "prompt", text: "构思" },
      },
      ...tasks.map((t, index) => ({
        id: `task-${t.id}`,
        position: { x: 80, y: 90 + index * 340 },
        data: { kind: "generation", taskId: t.id },
      })),
      ...images.map((i) => ({
        id: `image-${i.id}`,
        position: { x: 450, y: 90 },
        data: { kind: "image", imageId: i.id },
      })),
    ],
    edges: [
      { id: "manual", source: "note", target: "task-1" },
      { id: "result-a", source: "task-1", target: "image-a" },
    ],
  };
  const next = reconcileCanvas(old, tasks, images);
  assert.equal(next.nodes.length, 5);
  const group = next.nodes.find((n) => n.data.kind === "batch")!;
  assert.deepEqual(group.data.taskIds, ["1", "2", "3"]);
  assert.deepEqual(group.data.imageIds, []);
  assert.deepEqual(group.position, { x: 80, y: 90 });
  assert.deepEqual(
    next.edges.filter((e) => e.id === "manual"),
    [{ id: "manual", source: "note", target: group.id }],
  );
  assert.equal(nodeForImage(next.nodes, "b")?.id, "image-b");
  assert.deepEqual(
    next.edges
      .filter((e) => e.id.startsWith("result-"))
      .map((e) => [e.source, e.target]),
    [
      [group.id, "image-a"],
      [group.id, "image-b"],
      [group.id, "image-c"],
    ],
  );
  assert.equal(
    reconcileCanvas(next, tasks, images),
    next,
    "刷新不能反复迁移或改变位置",
  );
});

test("不同提示词变体和不同轮各自成组，二次生图指向具体父图序号", () => {
  const tasks = [
    task("1"),
    task("2"),
    task("3", { prompt: "另一种构图" }),
    task("4", { batchId: "round-2", parentImageId: "b" }),
  ];
  const next = reconcileCanvas(empty(), tasks, [
    image("a", "1"),
    image("b", "2"),
    image("c", "3"),
    image("d", "4"),
  ]);
  assert.equal(next.nodes.length, 7);
  assert.equal(next.edges.length, 5);
  const branch = next.edges.find((e) => e.id.startsWith("parent-"))!;
  assert.equal(branch.source, "image-b");
  assert.equal(
    branch.target,
    next.nodes.find((n) =>
      (n.data.taskIds as string[] | undefined)?.includes("4"),
    )?.id,
  );
  assert.ok(
    next.edges.some(
      (e) => e.source === branch.target && e.target === "image-d",
    ),
  );
});

test("删除一组后，延迟返回的图片不会让节点复活，独立上传图片保留", () => {
  const tasks = [task("1"), task("2")];
  const hidden = {
    ...empty(),
    hiddenTaskIds: ["1", "2"],
    hiddenImageIds: ["a"],
  };
  const next = reconcileCanvas(hidden, tasks, [
    image("a", "1"),
    image("later", "2"),
    image("upload"),
  ]);
  assert.equal(next.nodes.length, 1);
  assert.equal(next.nodes[0].data.imageId, "upload");
});

test("运行中任务回填图片保持节点 ID、拖动位置、分组与用户复制", () => {
  const tasks = [task("1"), task("2")];
  const initial = reconcileCanvas(empty(), tasks, []);
  const node = {
    ...initial.nodes[0],
    position: { x: 460, y: 320 },
    parentId: "folder",
    extent: "parent" as const,
  };
  const copy = { ...node, id: "user-copy", position: { x: 60, y: 100 } };
  const current = {
    ...initial,
    nodes: [
      { id: "folder", type: "group", position: { x: 10, y: 20 }, data: {} },
      node,
      copy,
    ],
  };
  const next = reconcileCanvas(current, tasks, [
    image("a", "1"),
    image("b", "2"),
  ]);
  assert.equal(next.nodes.length, 5);
  assert.deepEqual(
    next.nodes.find((n) => n.id === node.id)?.position,
    node.position,
  );
  assert.equal(next.nodes.find((n) => n.id === node.id)?.parentId, "folder");
  assert.deepEqual(next.nodes.find((n) => n.id === copy.id)?.data.imageIds, []);
  assert.deepEqual(nodeForImage(next.nodes, "a")?.position, { x: 850, y: 340 });
});

test("旧集合卡片拆分为提示词与独立图片，子分支从具体原图发出", () => {
  const tasks = [
    task("1"),
    task("2"),
    task("3", { batchId: "next", parentImageId: "b" }),
  ];
  const images = [image("a", "1"), image("b", "2"), image("c", "3")];
  const old: Graph = {
    ...empty(),
    nodes: [
      {
        id: "old-batch",
        position: { x: 60, y: 80 },
        data: { kind: "batch", taskIds: ["1", "2"], imageIds: ["a", "b"] },
      },
      {
        id: "old-child",
        position: { x: 680, y: 80 },
        data: { kind: "batch", taskIds: ["3"], imageIds: ["c"] },
      },
    ],
    edges: [
      { id: "parent-old-child", source: "old-batch", target: "old-child" },
    ],
  };
  const next = reconcileCanvas(old, tasks, images);
  assert.equal(next.nodes.length, 5);
  assert.deepEqual(next.nodes.find((n) => n.id === "old-batch")?.position, {
    x: 60,
    y: 80,
  });
  assert.ok(
    next.edges.some((e) => e.source === "image-b" && e.target === "old-child"),
  );
  assert.ok(
    next.edges.some((e) => e.source === "old-child" && e.target === "image-c"),
  );
  assert.equal(nodeForImage(next.nodes, "c")!.position.x, 1200);
  assert.equal(reconcileCanvas(next, tasks, images), next);
});
