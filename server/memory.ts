import { all, get } from "./db";
import type { Memory, Session, ImageAsset } from "../shared/types";
export function injectMemory(
  deviceId: string,
  projectId: string,
  sessionId: string,
  prompt: string,
  parentId?: string,
) {
  const terms = new Set(
    [
      ...new Intl.Segmenter("zh-CN", { granularity: "word" }).segment(
        prompt.toLowerCase(),
      ),
    ]
      .filter((s) => s.isWordLike)
      .map((s) => s.segment),
  );
  const relevant = all<Memory>("memories", deviceId).filter(
    (m) =>
      m.enabled &&
      m.projectId === projectId &&
      (m.scope === "project" ||
        (m.scope === "session" && m.sessionId === sessionId) ||
        (m.scope === "image" && m.imageId === parentId)),
  );
  const scored = relevant
    .map((m) => ({
      m,
      score: [...terms].reduce(
        (n, t) => n + (m.content.toLowerCase().includes(t) ? 1 : 0),
        0,
      ),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 12)
    .map((v) => v.m);
  const session = get<Session>("sessions", sessionId, deviceId);
  const parent = parentId
    ? get<ImageAsset>("images", parentId, deviceId)
    : undefined;
  const pieces = [
    ...scored.map((m) => `[${m.scope}记忆] ${m.content}`),
    session?.summary ? `[会话摘要] ${session.summary}` : "",
    ...(session?.messages || [])
      .slice(-4)
      .map(
        (m) =>
          `[最近${m.role === "user" ? "要求" : "回复"}] ${m.content.slice(0, 900)}`,
      ),
    parent
      ? `[参考图元数据] 原提示词：${parent.prompt}; 模型：${parent.model}; 评分：${parent.rating}/5。`
      : "",
  ].filter(Boolean);
  const context = pieces.join("\n").slice(0, 7000);
  return {
    effectivePrompt: context
      ? `以下是可参考的历史上下文；与本次要求冲突时，以本次要求为准。\n${context}\n\n本次要求：\n${prompt}`
      : prompt,
    memoryIds: scored.map((m) => m.id),
  };
}
