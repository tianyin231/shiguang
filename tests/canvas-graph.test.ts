import { test } from "node:test";
import assert from "node:assert/strict";
import {
  reconcileCanvas,
  nodeForImage,
  hiddenAfterRemoving,
  separateOverlappingImages,
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

test("逐张回填的倒序图片列表不会覆盖先到图片，缺失任务也预留一行", () => {
  const tasks = [task("1"), task("2"), task("3")];
  const last = image("c", "3");
  const first = reconcileCanvas(empty(), tasks, [last]);
  assert.deepEqual(nodeForImage(first.nodes, "c")!.position, {
    x: 440,
    y: 760,
  });
  const second = reconcileCanvas(first, tasks, [image("b", "2"), last]);
  const final = reconcileCanvas(second, tasks, [
    last,
    image("b", "2"),
    image("a", "1"),
  ]);
  assert.deepEqual(
    ["a", "b", "c"].map((id) => nodeForImage(final.nodes, id)!.position),
    [
      { x: 440, y: 80 },
      { x: 440, y: 420 },
      { x: 440, y: 760 },
    ],
  );
  assert.equal(nodeForImage(final.nodes, "c"), nodeForImage(first.nodes, "c"));
  assert.equal(
    reconcileCanvas(final, tasks, [image("a", "1"), last, image("b", "2")]),
    final,
  );
});

test("任务按时间和 ID 排序，同任务多图按创建时间和 ID 排序", () => {
  const tasks = [task("b", { createdAt: 2 }), task("a", { createdAt: 2 })];
  const a1 = { ...image("a1", "a"), createdAt: 1 };
  const a2 = { ...image("a2", "a"), createdAt: 1 };
  const a3 = { ...image("a3", "a"), createdAt: 2 };
  const b = { ...image("b", "b"), createdAt: 0 };
  const next = reconcileCanvas(empty(), tasks, [b, a3, a2, a1]);
  assert.deepEqual(
    ["a1", "a2", "a3", "b"].map(
      (id) => nodeForImage(next.nodes, id)!.position.y,
    ),
    [80, 420, 760, 1100],
  );
  const partial = reconcileCanvas(empty(), tasks, [a3]);
  const completed = reconcileCanvas(partial, tasks, [a1, a2, a3]);
  const ys = ["a1", "a2", "a3"]
    .map((id) => nodeForImage(completed.nodes, id)!.position.y)
    .sort((a, b) => a - b);
  assert.ok(ys[1] - ys[0] >= 320 && ys[2] - ys[1] >= 320);
  assert.equal(
    nodeForImage(completed.nodes, "a3"),
    nodeForImage(partial.nodes, "a3"),
  );
});

test("新图片绕开用户拖动的宽高节点，原节点和手动位置不变", () => {
  const tasks = [task("1")];
  const initial = reconcileCanvas(empty(), tasks, []);
  const obstacle = {
    id: "wide-note",
    position: { x: 300, y: 80 },
    measured: { width: 700, height: 620 },
    data: { kind: "prompt" },
  };
  const current = { ...initial, nodes: [...initial.nodes, obstacle] };
  const next = reconcileCanvas(current, tasks, [image("a", "1")]);
  assert.ok(nodeForImage(next.nodes, "a")!.position.y >= 740);
  assert.equal(
    next.nodes.find((node) => node.id === obstacle.id),
    obstacle,
  );
  assert.deepEqual(obstacle.position, { x: 300, y: 80 });
});

test("新分支避开已拖动分支，并以最终父节点位置排列结果", () => {
  const originalTasks = [
    task("1"),
    task("2", { batchId: "branch-1", parentImageId: "a" }),
  ];
  const originalImages = [image("a", "1"), image("b", "2")];
  const initial = reconcileCanvas(empty(), originalTasks, originalImages);
  const branch = initial.nodes.find((node) =>
    (node.data.taskIds as string[] | undefined)?.includes("2"),
  )!;
  branch.position = { x: 820, y: 520 };
  branch.measured = { width: 290, height: 500 };
  const tasks = [
    ...originalTasks,
    task("3", { batchId: "branch-2", parentImageId: "a" }),
  ];
  const next = reconcileCanvas(initial, tasks, [
    ...originalImages,
    image("c", "3"),
  ]);
  const added = next.nodes.find((node) =>
    (node.data.taskIds as string[] | undefined)?.includes("3"),
  )!;
  assert.ok(added.position.y >= 1060);
  assert.deepEqual(nodeForImage(next.nodes, "c")!.position, {
    x: added.position.x + 380,
    y: added.position.y,
  });
  assert.deepEqual(next.nodes.find((node) => node.id === branch.id)!.position, {
    x: 820,
    y: 520,
  });
  assert.equal(nodeForImage(next.nodes, "b"), nodeForImage(initial.nodes, "b"));
});

test("同次恢复的父图若被避碰移动，子分支与结果沿用最终父图位置", () => {
  const tasks = [
    task("1"),
    task("2", { batchId: "branch", parentImageId: "a" }),
  ];
  const current = {
    ...empty(),
    nodes: [
      {
        id: "note",
        position: { x: 440, y: 80 },
        data: { kind: "prompt" },
        measured: { width: 290, height: 700 },
      },
    ],
  };
  const next = reconcileCanvas(current, tasks, [
    image("b", "2"),
    image("a", "1"),
  ]);
  const parent = nodeForImage(next.nodes, "a")!;
  const child = next.nodes.find((node) =>
    (node.data.taskIds as string[] | undefined)?.includes("2"),
  )!;
  assert.ok(parent.position.y >= 820);
  assert.deepEqual(child.position, {
    x: parent.position.x + 380,
    y: parent.position.y,
  });
  assert.deepEqual(nodeForImage(next.nodes, "b")!.position, {
    x: child.position.x + 380,
    y: child.position.y,
  });
});

test("整理只移动重叠图片，保留后面的正常图片并且再次整理无变化", () => {
  const nodes = [
    {
      id: "a",
      position: { x: 440, y: 80 },
      data: { kind: "image", imageId: "a" },
    },
    {
      id: "b",
      position: { x: 440, y: 80 },
      data: { kind: "image", imageId: "b" },
    },
    {
      id: "c",
      position: { x: 440, y: 420 },
      data: { kind: "image", imageId: "c" },
    },
  ];
  const current = { ...empty(), nodes };
  const next = separateOverlappingImages(current);
  assert.equal(next.nodes[0], nodes[0]);
  assert.equal(next.nodes[2], nodes[2]);
  assert.ok(next.nodes[1].position.y >= 780);
  assert.deepEqual(current.nodes[1].position, { x: 440, y: 80 });
  assert.equal(separateOverlappingImages(next), next);
});

test("整理保留编组内图片与相对坐标，新图会避开分组的实际边界", () => {
  const current: Graph = {
    ...empty(),
    nodes: [
      {
        id: "group",
        type: "group",
        position: { x: 400, y: 50 },
        style: { width: 600, height: 900 },
        data: {},
      },
      {
        id: "inside-a",
        parentId: "group",
        extent: "parent",
        position: { x: 20, y: 20 },
        data: { kind: "image", imageId: "inside-a" },
      },
      {
        id: "inside-b",
        parentId: "group",
        extent: "parent",
        position: { x: 20, y: 20 },
        data: { kind: "image", imageId: "inside-b" },
      },
    ],
  };
  assert.equal(separateOverlappingImages(current), current);
  const next = reconcileCanvas(current, [task("1")], [image("a", "1")]);
  assert.ok(nodeForImage(next.nodes, "a")!.position.y >= 990);
  assert.equal(
    next.nodes.find((node) => node.id === "inside-a"),
    current.nodes[1],
  );
  assert.equal(
    next.nodes.find((node) => node.id === "inside-b"),
    current.nodes[2],
  );
});
