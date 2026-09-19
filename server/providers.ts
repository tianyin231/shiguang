import {
  fetch as httpFetch,
  Agent,
  ProxyAgent,
  FormData,
  type Dispatcher,
} from "undici";
import { readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { Provider, Model, GenerationParams } from "../shared/types";
import { uid } from "./db";
import { nativeDrawingParams, nearestAspectRatio } from "../shared/drawing";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public retryAfter = 0,
  ) {
    super(message);
  }
}
const agents = new Map<string, Dispatcher>();
export function apiBase(p: Provider) {
  const base = p.baseUrl.replace(/\/+$/, "");
  if (p.adapter === "gemini")
    return /\/v1(beta)?$/.test(base) ? base : base + "/v1beta";
  return /\/v\d+(beta)?$/.test(base) ? base : base + "/v1";
}
export async function upstream(
  p: Provider,
  route: string,
  options: {
    method?: string;
    body?: string | FormData | Buffer;
    contentType?: string;
    signal?: AbortSignal;
    idempotencyKey?: string;
  } = {},
) {
  const agentKey = p.proxyUrl || "direct";
  if (!agents.has(agentKey))
    agents.set(
      agentKey,
      p.proxyUrl
        ? new ProxyAgent({ uri: p.proxyUrl, headersTimeout: 0, bodyTimeout: 0 })
        : new Agent({ headersTimeout: 0, bodyTimeout: 0 }),
    );
  const headers: Record<string, string> = {};
  if (p.adapter === "gemini") headers["x-goog-api-key"] = p.apiKey || "";
  else if (p.adapter === "anthropic") {
    headers["x-api-key"] = p.apiKey || "";
    headers["anthropic-version"] = "2023-06-01";
  } else headers.Authorization = "Bearer " + (p.apiKey || "");
  if (options.contentType) headers["Content-Type"] = options.contentType;
  if (options.idempotencyKey)
    headers["Idempotency-Key"] = options.idempotencyKey;
  const response = await httpFetch(apiBase(p) + route, {
    method: options.method || "GET",
    headers,
    body: options.body,
    signal: options.signal,
    dispatcher: agents.get(agentKey),
  });
  if (!response.ok) {
    const text = await response.text();
    let message = text;
    try {
      const json = JSON.parse(text);
      message = json.error?.message || json.message || text;
    } catch {}
    const redacted = p.apiKey
      ? message.split(p.apiKey).join("[redacted]")
      : message;
    const retry = response.headers.get("retry-after");
    throw new ApiError(
      response.status,
      redacted.slice(0, 1200),
      retry
        ? Number(retry) * 1000 || Math.max(0, Date.parse(retry) - Date.now())
        : 0,
    );
  }
  return response;
}
export function defaultModel(
  providerId: string,
  name: string,
  adapter: Provider["adapter"],
): Model {
  // 模型名推断仅供初始化，能力矩阵始终显示“待验证”。
  const image = /image|dall-e|flux|stable|sdxl|imagen/i.test(name);
  const capabilities: Model["capabilities"] =
    adapter === "anthropic"
      ? ["chat", "vision", "streaming"]
      : image
        ? ["text2image"]
        : ["chat", "streaming"];
  if (/gpt-image|gemini.*image|demo-image/i.test(name))
    capabilities.push("image2image");
  if (/gpt-image|demo-image/i.test(name)) capabilities.push("mask");
  return {
    id: uid(),
    providerId,
    name,
    capabilities,
    sizes: ["1024x1024", "1536x864", "1536x1024", "1024x1536"],
    qualities: ["auto", "low", "medium", "high"],
    supportsSeed: false,
    supportsN: false,
    maxConcurrency: 4,
    favorite: false,
    isDefault: false,
    verified: {},
    price: {
      type: image ? "image" : "token",
      unit: 0,
      outputUnit: 0,
      currency: "USD",
      qualityMultiplier: {},
    },
  };
}
export async function discover(
  p: Provider,
  signal: AbortSignal,
): Promise<string[]> {
  if (p.adapter === "demo") return ["demo-image", "demo-chat"];
  const names: string[] = [];
  let next = "";
  for (let page = 0; page < 20; page++) {
    const suffix = next
      ? (p.adapter === "gemini" ? "?pageToken=" : "?after_id=") +
        encodeURIComponent(next)
      : "";
    const res = await upstream(p, "/models" + suffix, { signal });
    const json = (await res.json()) as {
      data?: { id: string }[];
      models?: { name: string }[];
      nextPageToken?: string;
      has_more?: boolean;
      last_id?: string;
    };
    names.push(
      ...(json.data || json.models || []).map((m) =>
        "id" in m ? m.id : m.name.replace(/^models\//, ""),
      ),
    );
    next = json.nextPageToken || (json.has_more ? json.last_id : "") || "";
    if (!next) break;
  }
  return [...new Set(names)];
}
export interface ChatMessage {
  role: string;
  content: unknown;
}
export function chatRequest(p: Provider, body: Record<string, unknown>) {
  if (p.adapter === "gemini") {
    const messages = (body.messages || []) as ChatMessage[];
    const system = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n");
    const contents = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts:
          typeof m.content === "string"
            ? [{ text: m.content }]
            : (
                m.content as {
                  type: string;
                  text?: string;
                  image_url?: { url: string };
                }[]
              ).map((c) => {
                if (c.type === "text") return { text: c.text };
                const match = c.image_url?.url.match(
                  /^data:([^;]+);base64,(.+)$/s,
                );
                if (!match)
                  throw new ApiError(
                    400,
                    "Gemini 原生适配器需要 data URL 图片",
                  );
                return { inlineData: { mimeType: match[1], data: match[2] } };
              }),
      }));
    return {
      route: `/models/${encodeURIComponent(String(body.model))}:${body.stream ? "streamGenerateContent?alt=sse" : "generateContent"}`,
      body: {
        contents,
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        generationConfig: { maxOutputTokens: body.max_tokens || 2048 },
      },
    };
  }
  if (p.adapter === "anthropic") {
    const messages = (body.messages || []) as ChatMessage[];
    return {
      route: "/messages",
      body: {
        model: body.model,
        max_tokens: body.max_tokens || 2048,
        stream: !!body.stream,
        system: messages
          .filter((m) => m.role === "system")
          .map((m) => m.content)
          .join("\n"),
        messages: messages
          .filter((m) => m.role !== "system")
          .map((m) => ({
            role: m.role,
            content:
              typeof m.content === "string"
                ? m.content
                : (
                    m.content as {
                      type: string;
                      text?: string;
                      image_url?: { url: string };
                    }[]
                  ).map((c) => {
                    if (c.type === "text")
                      return { type: "text", text: c.text };
                    const match = c.image_url?.url.match(
                      /^data:([^;]+);base64,(.+)$/s,
                    );
                    if (!match)
                      throw new ApiError(
                        400,
                        "Anthropic 适配器需要 data URL 图片",
                      );
                    return {
                      type: "image",
                      source: {
                        type: "base64",
                        media_type: match[1],
                        data: match[2],
                      },
                    };
                  }),
          })),
      },
    };
  }
  return { route: "/chat/completions", body };
}
export async function chat(
  p: Provider,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  if (p.adapter === "demo")
    return {
      text:
        "保持主体与构图，采用更清晰的块面光影和温暖木色。" +
        String((body.messages as ChatMessage[]).at(-1)?.content || ""),
      inputTokens: 100,
      outputTokens: 50,
      cost: 0,
    };
  const req = chatRequest(p, body);
  const res = await upstream(p, req.route, {
    method: "POST",
    body: JSON.stringify(req.body),
    contentType: "application/json",
    signal,
  });
  const json = (await res.json()) as any;
  return {
    text:
      p.adapter === "gemini"
        ? (json.candidates?.[0]?.content?.parts || [])
            .map((v: any) => v.text || "")
            .join("")
        : p.adapter === "anthropic"
          ? (json.content || []).map((v: any) => v.text || "").join("")
          : json.choices?.[0]?.message?.content || "",
    inputTokens:
      json.usage?.prompt_tokens ||
      json.usage?.input_tokens ||
      json.usageMetadata?.promptTokenCount ||
      0,
    outputTokens:
      json.usage?.completion_tokens ||
      json.usage?.output_tokens ||
      json.usageMetadata?.candidatesTokenCount ||
      0,
    cost:
      typeof json.cost === "number"
        ? json.cost
        : typeof json.usage?.cost === "number"
          ? json.usage.cost
          : undefined,
  };
}
export interface Generated {
  buffers: Buffer[];
  actualCost?: number;
  inputTokens?: number;
  outputTokens?: number;
}
export async function generate(
  p: Provider,
  model: Model,
  prompt: string,
  params: GenerationParams,
  referencePath: string | undefined,
  maskPath: string | undefined,
  signal: AbortSignal,
  taskId: string,
): Promise<Generated> {
  if (p.adapter === "demo") {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 1100);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(signal.reason);
        },
        { once: true },
      );
    });
    // 本地可使用自有样图；公开版本不附带用户图片。
    const sample = await readFile(
      path.resolve("public/samples/workshop.png"),
    ).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return sharp(
        Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" width="1536" height="864"><rect width="1536" height="864" fill="#f4ecdc"/><circle cx="1130" cy="280" r="170" fill="#d4a66a"/><path d="M0 864V680L430 460L820 750L1250 420L1536 610V864Z" fill="#9b9e83"/><path d="M650 864L1100 550L1536 820V864Z" fill="#b96549"/><text x="90" y="170" fill="#665545" font-size="56" font-family="sans-serif">SHIGUANG / DEMO</text></svg>',
        ),
      )
        .png()
        .toBuffer();
    });
    return {
      buffers: [sample],
      actualCost: 0,
    };
  }
  if (p.adapter === "anthropic")
    throw new ApiError(
      400,
      "Anthropic 原生适配器只提供对话与视觉，请选择图像模型",
    );
  let route = "/images/generations";
  let body: string | FormData;
  let contentType: string | undefined;
  if (p.adapter === "gemini") {
    const parts: unknown[] = [{ text: prompt }];
    if (referencePath)
      parts.push({
        inlineData: {
          mimeType: "image/png",
          data: (await readFile(referencePath)).toString("base64"),
        },
      });
    const ratio = nearestAspectRatio(params.size);
    route = `/models/${encodeURIComponent(model.name)}:generateContent`;
    body = JSON.stringify({
      contents: [{ role: "user", parts }],
      generationConfig: {
        responseModalities: ["TEXT", "IMAGE"],
        ...(model.supportsSeed && params.seed !== undefined
          ? { seed: params.seed }
          : {}),
        imageConfig: {
          ...(ratio ? { aspectRatio: ratio } : {}),
          ...(params.imageSize ? { imageSize: params.imageSize } : {}),
        },
      },
    });
    contentType = "application/json";
  } else {
    const fields: Record<string, unknown> = {
      ...nativeDrawingParams(model, params, !!referencePath),
      model: model.name,
      prompt,
    };
    if (model.supportsN) fields.n = 1;
    if (params.size && params.size !== "auto") fields.size = params.size;
    if (params.quality && params.quality !== "auto")
      fields.quality = params.quality;
    if (params.seed !== undefined && model.supportsSeed)
      fields.seed = params.seed;
    if (referencePath) {
      route = "/images/edits";
      const form = new FormData();
      for (const [k, v] of Object.entries(fields))
        form.set(k, typeof v === "string" ? v : JSON.stringify(v));
      form.set(
        "image",
        new Blob([new Uint8Array(await readFile(referencePath))], {
          type: "image/png",
        }),
        "reference.png",
      );
      if (maskPath)
        form.set(
          "mask",
          new Blob([new Uint8Array(await readFile(maskPath))], {
            type: "image/png",
          }),
          "mask.png",
        );
      body = form;
    } else {
      body = JSON.stringify(fields);
      contentType = "application/json";
    }
  }
  const res = await upstream(p, route, {
    method: "POST",
    body,
    contentType,
    signal,
    idempotencyKey: taskId,
  });
  const json = (await res.json()) as any;
  const buffers: Buffer[] = [];
  if (p.adapter === "gemini") {
    for (const part of json.candidates?.[0]?.content?.parts || []) {
      const data = part.inlineData || part.inline_data;
      if (data?.data) buffers.push(Buffer.from(data.data, "base64"));
    }
  } else
    for (const item of json.data || []) {
      if (item.b64_json)
        buffers.push(
          Buffer.from(item.b64_json.replace(/^data:[^,]+,/, ""), "base64"),
        );
      else if (item.url?.startsWith("data:"))
        buffers.push(Buffer.from(item.url.split(",")[1], "base64"));
      else if (item.url) {
        if (!/^https?:\/\//.test(item.url))
          throw new ApiError(502, "图片 URL 不是 HTTP(S)");
        const download = await httpFetch(item.url, {
          signal,
          dispatcher: agents.get(p.proxyUrl || "direct"),
        });
        if (!download.ok)
          throw new ApiError(
            502,
            `下载图片失败 ${download.status}，供应商可能已扣费`,
          );
        buffers.push(Buffer.from(await download.arrayBuffer()));
      }
    }
  if (!buffers.length)
    throw new ApiError(502, "供应商没有返回图片，请检查模型能力或内容过滤结果");
  const rawCost = json.actual_cost ?? json.cost ?? json.usage?.cost;
  return {
    buffers,
    actualCost:
      typeof rawCost === "number" && Number.isFinite(rawCost) && rawCost >= 0
        ? rawCost
        : undefined,
    inputTokens:
      json.usage?.input_tokens || json.usageMetadata?.promptTokenCount || 0,
    outputTokens:
      json.usage?.output_tokens ||
      json.usageMetadata?.candidatesTokenCount ||
      0,
  };
}
