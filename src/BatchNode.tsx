import { Handle, Position } from "@xyflow/react";
import { FileText, RotateCcw } from "lucide-react";
import { useStore } from "./store";
import { money, post } from "./api";
import { useAction } from "./components";

export function BatchNode({
  data,
  selected,
}: {
  data: Record<string, unknown>;
  selected?: boolean;
}) {
  const s = useStore();
  const action = useAction();
  const tasks = (data.taskIds as string[])
    .map((id) => s.data.tasks.find((t) => t.id === id))
    .filter((t) => !!t);
  const done = tasks.filter((t) => t.status === "succeeded").length;
  const pending = tasks.some((t) => ["running", "queued"].includes(t.status));
  const failed = tasks.filter((t) => ["failed", "dead"].includes(t.status));
  const costs: Record<string, number> = {};
  for (const task of tasks)
    costs[task.currency] =
      (costs[task.currency] || 0) + (task.actualCost ?? task.estimatedCost);
  return (
    <div
      className={`work-node kind-prompt-batch ${selected ? "selected" : ""}`}
    >
      <Handle type="target" position={Position.Left} />
      <div className="node-header">
        <FileText size={15} />
        <strong>生成提示词</strong>
        <span
          className={`status ${pending ? "running" : failed.length ? "failed" : done ? "succeeded" : "cancelled"}`}
        >
          {done}/{tasks.length} 张{pending ? " · 生成中" : ""}
        </span>
      </div>
      <p className="pre-wrap nowheel">{String(data.prompt || "")}</p>
      <div className="node-meta">
        <span>{[...new Set(tasks.map((t) => t.modelName))].join(" / ")}</span>
        <span>
          {Object.entries(costs)
            .map(([c, n]) => money(n, c))
            .join(" + ")}
        </span>
      </div>
      <div className="batch-node-footer nodrag nopan">
        <button
          className="text-button"
          onClick={() => tasks[0] && s.reuseTask(tasks[0])}
        >
          <RotateCcw size={13} />
          复用提示词与参数
        </button>
      </div>
      {(pending || failed.length > 0) && (
        <details className="batch-prompt nodrag nopan">
          <summary>逐张进度与操作</summary>
          {tasks.map((task, index) => (
            <div key={task.id} className="prompt-task-row">
              <span>
                第 {index + 1} 张 ·{" "}
                {
                  {
                    queued: "排队中",
                    running: "生成中",
                    succeeded: "已完成",
                    failed: "失败",
                    dead: "重试耗尽",
                    cancelled: "已取消",
                  }[task.status]
                }
              </span>
              {task.error && <small>{task.error}</small>}
              {["failed", "dead", "queued", "running"].includes(
                task.status,
              ) && (
                <button
                  className="text-button"
                  disabled={action.busy}
                  onClick={() =>
                    action.run(async () => {
                      await post(
                        `/tasks/${task.id}/${["failed", "dead"].includes(task.status) ? "retry" : "cancel"}`,
                        {},
                      );
                      await s.refresh();
                    })
                  }
                >
                  {["failed", "dead"].includes(task.status)
                    ? "重试这一张"
                    : "取消这一张"}
                </button>
              )}
            </div>
          ))}
        </details>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
