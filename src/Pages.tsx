import { useEffect, useRef, useState } from "react";
import {
  Search,
  Plus,
  RefreshCw,
  Star,
  Check,
  ArrowUpRight,
  Server,
  Link2,
  FolderOpen,
  KeyRound,
  Trash2,
  Heart,
  Grid2x2,
  Columns2,
  LayoutList,
  Download,
  AlertCircle,
  X,
  Play,
  Square,
  RotateCcw,
  ChevronRight,
  Clock,
  CheckCircle2,
  Coins,
  FileJson,
  Sparkles,
  LogOut,
  Edit3,
  Power,
  Upload,
  Braces,
} from "lucide-react";
import { useStore } from "./store";
import { drawingFields, imageParameters } from "../shared/drawing";
import { api, post, patch, put, downloadJSON, money, time } from "./api";
import {
  Button,
  Field,
  Modal,
  Empty,
  Busy,
  ImageActions,
  ImageDetail,
  useAction,
} from "./components";
import type {
  Provider,
  Config,
  Settings,
  Model,
  Capability,
  Task,
  ImageAsset,
  Memory,
  Session,
} from "../shared/types";

function PageHeading({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {children && <div className="row">{children}</div>}
    </div>
  );
}
const caps: Record<Capability, string> = {
  text2image: "文生图",
  image2image: "图生图",
  vision: "视觉",
  chat: "对话",
  streaming: "流式",
  mask: "局部重绘",
};
const labels: Record<string, string> = {
  queued: "等待中",
  running: "生成中",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消",
  dead: "死信 / 重试耗尽",
};

export function SettingsPage() {
  const s = useStore();
  const [form, setForm] = useState({
    id: "",
    name: "",
    baseUrl: "",
    apiKey: "",
    adapter: "openai" as Provider["adapter"],
    proxyUrl: "",
    concurrency: 4,
  });
  const [localSettings, setSettings] = useState<Settings | null>(
    s.config?.settings || null,
  );
  const [budgets, setBudgets] = useState(
    JSON.stringify(s.config?.settings.totalBudgets || {}, null, 2),
  );
  const action = useAction();
  const [discovery, setDiscovery] = useState<{
    form: string;
    names: string[];
  } | null>(null);
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const [modelSearch, setModelSearch] = useState("");
  const currentDiscovery =
    discovery?.form === JSON.stringify(form) ? discovery : null;
  async function discoverModels() {
    setDiscovery(null);
    setSelectedModels([]);
    const result = await post<{ names: string[] }>("/models/preview", {
      ...form,
      id: form.id || undefined,
    });
    setDiscovery({ form: JSON.stringify(form), names: result.names });
    setModelSearch("");
  }
  useEffect(() => {
    if (s.config) {
      setSettings(s.config.settings);
      setBudgets(JSON.stringify(s.config.settings.totalBudgets, null, 2));
    }
  }, [s.config?.settings]);
  function edit(p: Provider) {
    setForm({
      id: p.id,
      name: p.name,
      baseUrl: p.baseUrl,
      apiKey: "",
      adapter: p.adapter,
      proxyUrl: p.proxyUrl,
      concurrency: p.concurrency,
    });
  }
  async function save(withModels = false) {
    const config = await post<Config>("/config", {
      ...form,
      id: form.id || undefined,
      selectedModels:
        withModels && currentDiscovery ? selectedModels : undefined,
    });
    s.set({ config });
    if (config.deviceToken)
      localStorage.setItem("workbench-token", config.deviceToken);
    s.toast(
      withModels ? "连接与勾选的模型已保存" : "连接已保存，可稍后添加模型",
    );
    setDiscovery(null);
    await s.refresh();
    setForm({ ...form, id: config.activeProviderId || "", apiKey: "" });
  }
  return (
    <div className="page-padding">
      <PageHeading
        title="连接与偏好"
        description="模型由你选择，作品留在自己的目录。"
      />
      <div className="settings-layout">
        <section className="surface">
          <div className="section-heading">
            <h2>供应商连接</h2>
            <Button
              variant="ghost"
              onClick={() =>
                setForm({
                  id: "",
                  name: "",
                  baseUrl: "",
                  apiKey: "",
                  adapter: "openai",
                  proxyUrl: "",
                  concurrency: 4,
                })
              }
            >
              <Plus size={15} />
              新增
            </Button>
          </div>
          <div className="provider-list">
            {s.config?.providers.map((p) => (
              <div
                key={p.id}
                className={`provider-item ${p.id === s.config?.activeProviderId ? "active" : ""}`}
              >
                <div className="provider-icon">
                  <Server size={20} />
                </div>
                <div>
                  <strong>{p.name}</strong>
                  <small>
                    {p.adapter} · {p.keyHint || "无需密钥"}
                  </small>
                </div>
                <Button variant="ghost" onClick={() => edit(p)}>
                  编辑
                </Button>
                <Button
                  variant={
                    p.id === s.config?.activeProviderId ? "ghost" : "secondary"
                  }
                  onClick={() =>
                    action.run(async () => {
                      const config = await post<Config>("/config/active", {
                        providerId: p.id,
                      });
                      s.set({ config });
                    })
                  }
                >
                  {p.id === s.config?.activeProviderId ? (
                    <Check size={16} />
                  ) : (
                    "切换"
                  )}
                </Button>
              </div>
            ))}
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void action.run(() =>
                save(!!currentDiscovery && selectedModels.length > 0),
              );
            }}
          >
            <div className="field-grid">
              <Field label="供应商名称（可选）">
                <input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="例如：我的图像网关"
                />
              </Field>
              <Field label="接口类型">
                <select
                  value={form.adapter}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      adapter: e.target.value as Provider["adapter"],
                    })
                  }
                >
                  <option value="openai">OpenAI 兼容 / 第三方</option>
                  <option value="gemini">Gemini 原生</option>
                  <option value="anthropic">Anthropic 原生</option>
                  {form.adapter === "demo" && (
                    <option value="demo">本地演示</option>
                  )}
                </select>
              </Field>
            </div>
            <Field
              label="Base URL"
              hint="支持 localhost、局域网和自定义 /v1 路径。"
            >
              <input
                required
                type="url"
                value={form.baseUrl}
                onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
                placeholder="https://api.example.com/v1"
              />
            </Field>
            <Field
              label="API Key"
              hint={
                form.id
                  ? "留空保留已保存的 Key。"
                  : "Key 保存到服务端；刷新和重开浏览器无需重新填写。"
              }
            >
              <input
                type="password"
                autoComplete="off"
                value={form.apiKey}
                onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
                placeholder={form.id ? "已保存，留空不修改" : "sk-…"}
              />
            </Field>
            <div className="field-grid">
              <Field label="HTTP(S) 代理（可选）">
                <input
                  value={form.proxyUrl}
                  onChange={(e) =>
                    setForm({ ...form, proxyUrl: e.target.value })
                  }
                  placeholder="http://127.0.0.1:7890"
                />
              </Field>
              <Field label="供应商最大并发">
                <input
                  type="number"
                  min="1"
                  max="32"
                  value={form.concurrency}
                  onChange={(e) =>
                    setForm({ ...form, concurrency: +e.target.value })
                  }
                />
              </Field>
            </div>
            <div className="row" style={{ flexWrap: "wrap" }}>
              <Button
                type="button"
                disabled={action.busy || !form.baseUrl}
                onClick={() => void action.run(discoverModels)}
              >
                {action.busy ? <Busy /> : <Search size={16} />}发现模型
              </Button>
              <Button
                type="button"
                disabled={action.busy || !form.baseUrl}
                onClick={() => void action.run(() => save())}
              >
                <Link2 size={16} />
                直接保存连接
              </Button>
            </div>
            <p className="muted">
              发现模型只读取列表，不保存连接；也可直接保存，稍后添加模型。
            </p>
            {currentDiscovery && (
              <section
                className="provider-model-picker"
                aria-label="选择要加入的模型"
              >
                <strong>
                  发现 {currentDiscovery.names.length} 个模型 · 已勾选{" "}
                  {selectedModels.length} 个
                </strong>
                <Field label="搜索发现的模型">
                  <input
                    value={modelSearch}
                    onChange={(e) => setModelSearch(e.target.value)}
                    placeholder="按模型名称搜索"
                  />
                </Field>
                <div className="row">
                  <Button
                    type="button"
                    disabled={action.busy}
                    onClick={() => setSelectedModels(currentDiscovery.names)}
                  >
                    全选
                  </Button>
                  <Button
                    type="button"
                    disabled={action.busy}
                    onClick={() => setSelectedModels([])}
                  >
                    清空选择
                  </Button>
                </div>
                <div className="provider-model-options">
                  {currentDiscovery.names
                    .filter((name) =>
                      name.toLowerCase().includes(modelSearch.toLowerCase()),
                    )
                    .map((name) => (
                      <label key={name}>
                        <input
                          type="checkbox"
                          checked={selectedModels.includes(name)}
                          disabled={action.busy}
                          onChange={(e) =>
                            setSelectedModels((old) =>
                              e.target.checked
                                ? [...old, name]
                                : old.filter((item) => item !== name),
                            )
                          }
                        />
                        <span>{name}</span>
                      </label>
                    ))}
                </div>
                {!currentDiscovery.names.length && (
                  <p>未发现模型。可直接保存连接，再到模型页手动添加。</p>
                )}
                <Button
                  type="submit"
                  variant="primary"
                  disabled={action.busy || !selectedModels.length}
                >
                  保存连接并加入所选模型
                </Button>
                {form.id && (
                  <p className="muted">
                    已有模型会保留，同名模型不会重复添加。
                  </p>
                )}
              </section>
            )}
          </form>
        </section>
        <div>
          <section className="surface">
            <div className="section-heading">
              <h2>作品存储</h2>
              <FolderOpen size={19} />
            </div>
            {localSettings && (
              <>
                <Field
                  label="服务端输出目录"
                  hint="这是运行后端的机器上的路径。远程部署时不是浏览器所在电脑。"
                >
                  <input
                    value={localSettings.outputDir}
                    onChange={(e) =>
                      setSettings({
                        ...localSettings,
                        outputDir: e.target.value,
                      })
                    }
                  />
                </Field>
                <Field label="文件名模板">
                  <input
                    value={localSettings.filenameTemplate}
                    onChange={(e) =>
                      setSettings({
                        ...localSettings,
                        filenameTemplate: e.target.value,
                      })
                    }
                  />
                </Field>
                <small className="muted">
                  可用变量：{"{date} {model} {prompt_hash} {seed} {id}"}
                </small>
                <div className="field-grid storage-fields">
                  <Field label="图片配额（MB）">
                    <input
                      type="number"
                      min="1"
                      value={localSettings.quotaMB}
                      onChange={(e) =>
                        setSettings({
                          ...localSettings,
                          quotaMB: +e.target.value,
                        })
                      }
                    />
                  </Field>
                  <Field label="默认并发">
                    <input
                      type="number"
                      min="1"
                      max="32"
                      value={localSettings.concurrency}
                      onChange={(e) =>
                        setSettings({
                          ...localSettings,
                          concurrency: +e.target.value,
                        })
                      }
                    />
                  </Field>
                  <Field label="默认重试次数">
                    <input
                      type="number"
                      min="0"
                      max="5"
                      value={localSettings.retries}
                      onChange={(e) =>
                        setSettings({
                          ...localSettings,
                          retries: +e.target.value,
                        })
                      }
                    />
                  </Field>
                  <Field label="默认超时（秒）">
                    <input
                      type="number"
                      min="5"
                      max="1800"
                      value={localSettings.timeout}
                      onChange={(e) =>
                        setSettings({
                          ...localSettings,
                          timeout: +e.target.value,
                        })
                      }
                    />
                  </Field>
                </div>
                <Field
                  label="各币种总预算（JSON）"
                  hint='例如 {"USD": 20, "CNY": 100}；空对象表示不限制。'
                >
                  <textarea
                    rows={3}
                    value={budgets}
                    onChange={(e) => setBudgets(e.target.value)}
                  />
                </Field>
                <Button
                  disabled={action.busy}
                  onClick={() =>
                    action.run(async () => {
                      const settings = await put<Settings>("/settings", {
                        ...localSettings,
                        totalBudgets: JSON.parse(budgets),
                      });
                      s.set({ config: { ...s.config!, settings } });
                      s.toast("存储与预算设置已保存");
                    })
                  }
                >
                  保存偏好
                </Button>
              </>
            )}
          </section>
          <section className="connection-note">
            <KeyRound size={20} />
            <div>
              <strong>这个浏览器已经被记住</strong>
              <p>
                设备凭证保存 90 天。更换设备需要重新配置；本版本不包含账号系统。
              </p>
              <Button
                variant="ghost"
                onClick={() =>
                  action.run(async () => {
                    await post("/logout");
                    localStorage.removeItem("workbench-token");
                    localStorage.removeItem("workbench-project");
                    window.location.reload();
                  })
                }
              >
                <LogOut size={14} />
                退出并清除设备凭证
              </Button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

export function ModelsPage() {
  const s = useStore();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [favorite, setFavorite] = useState(false);
  const [edit, setEdit] = useState<Model | null>(null);
  const [manual, setManual] = useState(false);
  const [name, setName] = useState("");
  const [probe, setProbe] = useState<Model | null>(null);
  const [probeCap, setProbeCap] = useState<Capability>("text2image");
  const [referenceId, setReferenceId] = useState("");
  const [probeReply, setProbeReply] = useState("");
  const action = useAction();
  const models = s.data.models.filter(
    (m) =>
      m.providerId === s.config?.activeProviderId &&
      m.name.toLowerCase().includes(query.toLowerCase()) &&
      (filter === "all" || m.capabilities.includes(filter as Capability)) &&
      (!favorite || m.favorite),
  );
  return (
    <div className="page-padding">
      <PageHeading
        title="找到合适的模型"
        description="能力可以手动标记。发现模型不产生生图费用，实际能力需单独验证。"
      >
        <Button
          disabled={action.busy || !s.config?.activeProviderId}
          onClick={() =>
            action.run(async () => {
              await post("/models/discover", {
                providerId: s.config?.activeProviderId,
              });
              await s.refresh();
              s.toast("模型列表已更新");
            })
          }
        >
          <RefreshCw size={15} />
          发现模型
        </Button>
        <Button variant="primary" onClick={() => setManual(true)}>
          <Plus size={15} />
          手动添加
        </Button>
      </PageHeading>
      <div className="filter-bar">
        <div className="search">
          <Search size={17} />
          <input
            placeholder="搜索模型名称…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <select value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="all">全部能力</option>
          {Object.entries(caps).map(([id, label]) => (
            <option value={id} key={id}>
              {label}
            </option>
          ))}
        </select>
        <Button
          variant={favorite ? "primary" : "ghost"}
          onClick={() => setFavorite(!favorite)}
        >
          <Star size={15} />
          收藏
        </Button>
        <span className="muted">{models.length} 个模型</span>
      </div>
      {!models.length ? (
        <Empty
          title="把模型加入你的工具箱"
          action={<Button onClick={() => setManual(true)}>添加模型 ID</Button>}
        >
          先发现供应商模型，或者直接填入你知道的模型 ID。
        </Empty>
      ) : (
        <div className="table-wrap">
          <table className="models-table">
            <thead>
              <tr>
                <th>模型</th>
                {Object.values(caps).map((v) => (
                  <th key={v}>{v}</th>
                ))}
                <th>价格</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {models.map((m) => (
                <tr key={m.id}>
                  <td>
                    <div className="model-name">
                      <button
                        title="收藏模型"
                        className="icon-btn"
                        onClick={() =>
                          action.run(async () => {
                            await patch("/models/" + m.id, {
                              favorite: !m.favorite,
                            });
                            await s.refresh();
                          })
                        }
                      >
                        <Star
                          size={15}
                          fill={m.favorite ? "#b96549" : "none"}
                          color={m.favorite ? "#b96549" : "currentColor"}
                        />
                      </button>
                      <div>
                        <strong>{m.name}</strong>
                        <small>
                          {m.isDefault ? "默认模型 · " : ""}最高{" "}
                          {m.maxConcurrency} 并发
                        </small>
                      </div>
                    </div>
                  </td>
                  {Object.keys(caps).map((c) => (
                    <td key={c}>
                      <span
                        className={`cap-dot ${m.verified[c as Capability] === false ? "unsupported" : m.capabilities.includes(c as Capability) ? (m.verified[c as Capability] ? "verified" : "unverified") : ""}`}
                        title={
                          m.verified[c as Capability] === false
                            ? "探测未通过"
                            : m.verified[c as Capability]
                              ? "已验证"
                              : m.capabilities.includes(c as Capability)
                                ? "已标记，尚未验证"
                                : "未启用"
                        }
                      >
                        {m.verified[c as Capability] === false
                          ? "×"
                          : m.capabilities.includes(c as Capability)
                            ? m.verified[c as Capability]
                              ? "✓"
                              : "·"
                            : "—"}
                      </span>
                    </td>
                  ))}
                  <td>
                    <strong>{money(m.price.unit, m.price.currency)}</strong>
                    <small className="block muted">
                      /
                      {m.price.type === "image"
                        ? "张"
                        : m.price.type === "megapixel"
                          ? "百万像素"
                          : "百万输入 token"}
                    </small>
                  </td>
                  <td>
                    <div className="row">
                      <Button
                        variant="ghost"
                        onClick={() => setEdit(structuredClone(m))}
                      >
                        配置
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => {
                          setProbe(m);
                          setProbeCap(
                            m.capabilities.includes("text2image")
                              ? "text2image"
                              : "chat",
                          );
                          setProbeReply("");
                        }}
                      >
                        探测
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted footnote">
        ✓ 已验证　· 根据模型名推断或手动标记　× 探测未通过　—
        未启用。不同供应商的同名模型可能具有不同能力。
      </p>
      {manual && (
        <Modal title="手动添加模型" onClose={() => setManual(false)}>
          <Field label="模型 ID">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：gpt-image-2"
            />
          </Field>
          <Button
            variant="primary"
            disabled={!name || action.busy || !s.config?.activeProviderId}
            onClick={() =>
              action.run(async () => {
                const m = await post<Model>("/models", {
                  providerId: s.config?.activeProviderId,
                  name,
                });
                await s.refresh();
                setManual(false);
                setName("");
                setEdit(m);
              })
            }
          >
            添加并配置
          </Button>
        </Modal>
      )}
      {edit && (
        <Modal title={"配置 " + edit.name} onClose={() => setEdit(null)} wide>
          <div className="field-grid">
            <div>
              <Field label="能力标记">
                <div className="cap-checks">
                  {Object.entries(caps).map(([c, label]) => (
                    <label key={c}>
                      <input
                        type="checkbox"
                        checked={edit.capabilities.includes(c as Capability)}
                        onChange={(e) =>
                          setEdit({
                            ...edit,
                            capabilities: e.target.checked
                              ? [...edit.capabilities, c as Capability]
                              : edit.capabilities.filter((v) => v !== c),
                          })
                        }
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </Field>
              <Field label="支持尺寸（逗号分隔）">
                <input
                  value={edit.sizes.join(",")}
                  onChange={(e) =>
                    setEdit({ ...edit, sizes: e.target.value.split(",") })
                  }
                />
              </Field>
              <Field label="支持质量（逗号分隔）">
                <input
                  value={edit.qualities.join(",")}
                  onChange={(e) =>
                    setEdit({ ...edit, qualities: e.target.value.split(",") })
                  }
                />
              </Field>
              <Field label="最大并发">
                <input
                  type="number"
                  min="1"
                  max="32"
                  value={edit.maxConcurrency}
                  onChange={(e) =>
                    setEdit({ ...edit, maxConcurrency: +e.target.value })
                  }
                />
              </Field>
              <div className="check-stack">
                <label>
                  <input
                    type="checkbox"
                    checked={edit.supportsSeed}
                    onChange={(e) =>
                      setEdit({ ...edit, supportsSeed: e.target.checked })
                    }
                  />
                  支持 seed 参数
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={edit.supportsN}
                    onChange={(e) =>
                      setEdit({ ...edit, supportsN: e.target.checked })
                    }
                  />
                  支持 n 参数（工作台每个任务固定为 1 张）
                </label>
                <p className="parameter-hint">
                  原生绘画参数 ·
                  请按供应商文档勾选；这里只配置支持范围，不会发起收费探测。
                </p>
                {drawingFields.map((field) => (
                  <label key={field.api}>
                    <input
                      type="checkbox"
                      checked={imageParameters(edit).includes(field.api)}
                      onChange={(e) =>
                        setEdit({
                          ...edit,
                          imageParameters: e.target.checked
                            ? [...imageParameters(edit), field.api]
                            : imageParameters(edit).filter(
                                (v) => v !== field.api,
                              ),
                        })
                      }
                    />
                    {field.label} <small>{field.api}</small>
                  </label>
                ))}
                <label>
                  <input
                    type="checkbox"
                    checked={edit.isDefault}
                    onChange={(e) =>
                      setEdit({ ...edit, isDefault: e.target.checked })
                    }
                  />
                  设为默认模型
                </label>
              </div>
            </div>
            <div className="price-editor">
              <h3>价格表</h3>
              <Field label="计费方式">
                <select
                  value={edit.price.type}
                  onChange={(e) =>
                    setEdit({
                      ...edit,
                      price: {
                        ...edit.price,
                        type: e.target.value as Model["price"]["type"],
                      },
                    })
                  }
                >
                  <option value="image">按张</option>
                  <option value="megapixel">按百万像素</option>
                  <option value="token">按百万 token</option>
                </select>
              </Field>
              <div className="field-grid">
                <Field label="币种">
                  <select
                    value={edit.price.currency}
                    onChange={(e) =>
                      setEdit({
                        ...edit,
                        price: { ...edit.price, currency: e.target.value },
                      })
                    }
                  >
                    <option>USD</option>
                    <option>CNY</option>
                    <option>EUR</option>
                  </select>
                </Field>
                <Field
                  label={
                    edit.price.type === "token" ? "百万输入 token 单价" : "单价"
                  }
                >
                  <input
                    type="number"
                    min="0"
                    step="0.001"
                    value={edit.price.unit}
                    onChange={(e) =>
                      setEdit({
                        ...edit,
                        price: { ...edit.price, unit: +e.target.value },
                      })
                    }
                  />
                </Field>
              </div>
              {edit.price.type === "token" && (
                <Field label="百万输出 token 单价">
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={edit.price.outputUnit}
                    onChange={(e) =>
                      setEdit({
                        ...edit,
                        price: { ...edit.price, outputUnit: +e.target.value },
                      })
                    }
                  />
                </Field>
              )}
              {edit.qualities
                .filter((q) => q !== "auto")
                .map((q) => (
                  <Field key={q} label={q + " 质量倍率"}>
                    <input
                      type="number"
                      min="0"
                      step="0.1"
                      value={edit.price.qualityMultiplier[q] ?? 1}
                      onChange={(e) =>
                        setEdit({
                          ...edit,
                          price: {
                            ...edit.price,
                            qualityMultiplier: {
                              ...edit.price.qualityMultiplier,
                              [q]: +e.target.value,
                            },
                          },
                        })
                      }
                    />
                  </Field>
                ))}
            </div>
          </div>
          <Button
            variant="primary"
            disabled={action.busy}
            onClick={() =>
              action.run(async () => {
                await patch("/models/" + edit.id, edit);
                await s.refresh();
                setEdit(null);
                s.toast("模型能力与价格已保存");
              })
            }
          >
            保存配置
          </Button>
        </Modal>
      )}
      {probe && (
        <Modal title="验证模型能力" onClose={() => setProbe(null)}>
          <div className="warning">
            <strong>探测可能产生费用</strong>
            <p>
              将向 {probe.name}{" "}
              发送一次真实请求。图像探测会保存测试图片；结果缓存 24 小时。
            </p>
          </div>
          <Field label="测试能力">
            <select
              value={probeCap}
              onChange={(e) => setProbeCap(e.target.value as Capability)}
            >
              <option value="text2image">文生图</option>
              <option value="image2image">图生图</option>
              <option value="vision">视觉</option>
              <option value="chat">对话</option>
            </select>
          </Field>
          {["image2image", "vision"].includes(probeCap) && (
            <Field label="测试参考图">
              <select
                value={referenceId}
                onChange={(e) => setReferenceId(e.target.value)}
              >
                <option value="">选择已有图片</option>
                {s.data.images.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.prompt.slice(0, 36)}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Button
            variant="primary"
            disabled={action.busy}
            onClick={() =>
              action.run(async () => {
                const result = await post<{ reply?: string; cached?: boolean }>(
                  "/models/" + probe.id + "/probe",
                  {
                    capability: probeCap,
                    confirmCost: true,
                    projectId: s.projectId,
                    sessionId: s.sessionId,
                    referenceId: referenceId || undefined,
                  },
                );
                await s.refresh();
                setProbeReply(
                  result.cached
                    ? "使用 24 小时内的缓存结果"
                    : result.reply || "测试任务已加入队列，请在任务页查看结果",
                );
              })
            }
          >
            {action.busy ? <Busy /> : null}确认并探测
          </Button>
          {probeReply && <p>{probeReply}</p>}
          {probe.probeError && (
            <p className="inline-warning">上次：{probe.probeError}</p>
          )}
        </Modal>
      )}
    </div>
  );
}

export function TasksPage() {
  const s = useStore();
  const [filter, setFilter] = useState("all");
  const [expanded, setExpanded] = useState("");
  const action = useAction();
  const all = s.data.tasks.filter((t) => t.projectId === s.projectId);
  const tasks = all.filter((t) => filter === "all" || t.status === filter);
  const stats = ["running", "queued", "succeeded", "dead"];
  return (
    <div className="page-padding">
      <PageHeading
        title="让灵感并行发生"
        description="每次生成都有记录。关闭页面不会停止后台任务。"
      >
        <Button onClick={() => action.run(s.refresh)}>
          <RefreshCw size={15} />
          刷新状态
        </Button>
      </PageHeading>
      <div className="task-summary">
        {stats.map((k) => (
          <button
            key={k}
            onClick={() => setFilter(k)}
            className={filter === k ? "active" : ""}
          >
            <span className={`status-dot ${k === "running" ? "live" : ""}`} />
            <span>{labels[k]}</span>
            <strong>{all.filter((t) => t.status === k).length}</strong>
          </button>
        ))}
      </div>
      <div className="tabs">
        {[
          "all",
          "queued",
          "running",
          "succeeded",
          "failed",
          "dead",
          "cancelled",
        ].map((v) => (
          <button
            key={v}
            className={filter === v ? "active" : ""}
            onClick={() => setFilter(v)}
          >
            {v === "all" ? "全部任务" : labels[v]}
          </button>
        ))}
      </div>
      {!tasks.length ? (
        <Empty
          title="队列里还很安静"
          action={
            <Button onClick={() => s.set({ page: "canvas" })}>回到画布</Button>
          }
        >
          提交一次创作，进度、重试和结果都会出现在这里。
        </Empty>
      ) : (
        <div className="task-list">
          {tasks.map((t) => (
            <div className="task-card" key={t.id}>
              <div className="task-main">
                <div className={`task-status-icon ${t.status}`}>
                  {t.status === "running" ? (
                    <Busy />
                  ) : t.status === "succeeded" ? (
                    <CheckCircle2 size={21} />
                  ) : t.status === "queued" ? (
                    <Clock size={21} />
                  ) : (
                    <AlertCircle size={21} />
                  )}
                </div>
                <div className="task-text">
                  <div>
                    <strong>{t.modelName}</strong>
                    <span className={`status ${t.status}`}>
                      {labels[t.status]}
                    </span>
                    <small>{time(t.createdAt)}</small>
                  </div>
                  <p>{t.prompt}</p>
                  <small>
                    {t.params.size} · {t.params.quality} · 第 {t.attempts}{" "}
                    次请求 ·{" "}
                    {t.elapsedMs
                      ? `${Math.round(t.elapsedMs / 1000)} 秒`
                      : "等待执行"}
                    {t.fallback ? " · 文本降级" : ""}
                  </small>
                </div>
                <div className="task-price">
                  <strong>
                    {money(t.actualCost ?? t.estimatedCost, t.currency)}
                  </strong>
                  <small>
                    {t.costSource === "provider"
                      ? "供应商实际值"
                      : "价格表估算"}
                  </small>
                </div>
                <div className="task-buttons">
                  {["queued", "running"].includes(t.status) ? (
                    <Button
                      variant="ghost"
                      onClick={() =>
                        action.run(async () => {
                          await post("/tasks/" + t.id + "/cancel");
                          await s.refresh();
                        })
                      }
                    >
                      <Square size={14} />
                      取消
                    </Button>
                  ) : ["dead", "failed", "cancelled"].includes(t.status) ? (
                    <Button
                      onClick={() =>
                        action.run(async () => {
                          await post("/tasks/" + t.id + "/retry");
                          await s.refresh();
                        })
                      }
                    >
                      <RotateCcw size={14} />
                      重试
                    </Button>
                  ) : null}
                  <button
                    className="icon-btn"
                    title="任务详情"
                    onClick={() => setExpanded(expanded === t.id ? "" : t.id)}
                  >
                    <ChevronRight size={18} />
                  </button>
                </div>
              </div>
              {t.error && <div className="task-error">{t.error}</div>}
              {expanded === t.id && (
                <div className="task-details">
                  <div className="row">
                    <span>批次 {t.batchId.slice(0, 8)}</span>
                    <label>
                      优先级{" "}
                      <input
                        type="number"
                        min="0"
                        max="10"
                        defaultValue={t.priority}
                        onBlur={(e) =>
                          action.run(async () => {
                            await patch("/tasks/" + t.id, {
                              priority: +e.target.value,
                            });
                            await s.refresh();
                          })
                        }
                      />
                    </label>
                    <span>记忆 {t.memoryIds.length} 条</span>
                  </div>
                  {t.uncertainCharge && (
                    <p className="inline-warning">
                      请求曾中断，可能已计费；预算仍保留预占。重试前可核对供应商账单。
                    </p>
                  )}
                  <div className="task-log">
                    {t.logs.map((l, i) => (
                      <div key={i}>
                        <time>
                          {new Date(l.at).toLocaleTimeString("zh-CN")}
                        </time>
                        <span>{l.text}</span>
                      </div>
                    ))}
                  </div>
                  <details>
                    <summary>查看实际发送的提示词</summary>
                    <p className="pre-wrap">{t.effectivePrompt}</p>
                  </details>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function GalleryPage() {
  const s = useStore();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [model, setModel] = useState("all");
  const [view, setView] = useState("grid");
  const [selected, setSelected] = useState<string[]>([]);
  const [compare, setCompare] = useState(false);
  const [detail, setDetail] = useState("");
  const [minRating, setMinRating] = useState(0);
  const [gc, setGc] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const action = useAction();
  const images = s.data.images
    .filter((i) => i.projectId === s.projectId && i.prompt !== "局部重绘遮罩")
    .filter(
      (i) =>
        (filter === "discarded" ? i.discarded : !i.discarded) &&
        (filter !== "favorite" || i.favorite) &&
        (model === "all" || i.model === model) &&
        i.rating >= minRating &&
        i.prompt.toLowerCase().includes(query.toLowerCase()),
    )
    .sort((a, b) => b.createdAt - a.createdAt);
  const current = s.data.images.find((i) => i.id === detail);
  return (
    <div className="page-padding">
      <PageHeading
        title="你的作品，慢慢生长"
        description="留住值得继续的方向，也为偶然的惊喜留一个位置。"
      >
        <Button onClick={() => input.current?.click()}>
          <Upload size={15} />
          导入图片
        </Button>
        <Button disabled={selected.length < 2} onClick={() => setCompare(true)}>
          <Columns2 size={15} />
          对比 {selected.length || ""}
        </Button>
      </PageHeading>
      <input
        type="file"
        accept="image/*"
        ref={input}
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file)
            void action.run(async () => {
              const form = new FormData();
              form.set("image", file);
              form.set("projectId", s.projectId);
              form.set("sessionId", s.sessionId);
              await api("/images/upload", { method: "POST", body: form });
              await s.refresh();
              s.toast("图片已导入");
            });
          e.target.value = "";
        }}
      />
      <div className="filter-bar">
        <div className="search">
          <Search size={17} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索提示词…"
          />
        </div>
        <select value={model} onChange={(e) => setModel(e.target.value)}>
          <option value="all">全部模型</option>
          {[...new Set(s.data.images.map((i) => i.model))].map((v) => (
            <option key={v}>{v}</option>
          ))}
        </select>
        <select
          value={minRating}
          onChange={(e) => setMinRating(+e.target.value)}
        >
          <option value={0}>全部评分</option>
          {[1, 2, 3, 4, 5].map((v) => (
            <option value={v} key={v}>
              {v} 星及以上
            </option>
          ))}
        </select>
        <div className="segmented">
          <button
            className={view === "grid" ? "active" : ""}
            onClick={() => setView("grid")}
            title="网格"
          >
            <Grid2x2 size={17} />
          </button>
          <button
            className={view === "masonry" ? "active" : ""}
            onClick={() => setView("masonry")}
            title="瀑布流"
          >
            <Columns2 size={17} />
          </button>
        </div>
      </div>
      <div className="tabs">
        {[
          ["all", "全部作品"],
          ["favorite", "收藏"],
          ["discarded", "已淘汰"],
        ].map(([v, label]) => (
          <button
            key={v}
            className={filter === v ? "active" : ""}
            onClick={() => setFilter(v)}
          >
            {label}
          </button>
        ))}
        <span className="muted">{images.length} 张</span>
        {filter === "discarded" && (
          <Button variant="danger" onClick={() => setGc(true)}>
            清理已淘汰文件
          </Button>
        )}
      </div>
      {!images.length ? (
        <Empty
          title="第一张作品，值得期待"
          action={
            <Button onClick={() => s.set({ page: "canvas" })}>开始创作</Button>
          }
        >
          生成或导入图片后，它们会永久保存在这里。
        </Empty>
      ) : (
        <div className={`gallery ${view}`}>
          {images.map((image) => (
            <article
              className={`gallery-card ${selected.includes(image.id) ? "selected" : ""}`}
              key={image.id}
            >
              <div
                className="gallery-image"
                onClick={() => setDetail(image.id)}
              >
                <img src={image.thumbnailUrl} loading="lazy" />
                <label
                  className="image-select"
                  onClick={(e) => e.stopPropagation()}
                >
                  <input
                    aria-label="加入对比"
                    type="checkbox"
                    checked={selected.includes(image.id)}
                    onChange={(e) =>
                      setSelected(
                        e.target.checked
                          ? [...selected.slice(-3), image.id]
                          : selected.filter((id) => id !== image.id),
                      )
                    }
                  />
                </label>
                {image.parentId && (
                  <span className="iteration-tag">迭代作品</span>
                )}
              </div>
              <div className="gallery-caption">
                <strong>{image.prompt}</strong>
                <div>
                  <small>
                    {image.model} · {image.width} × {image.height}
                  </small>
                  {image.rating > 0 && <small>★ {image.rating}</small>}
                </div>
              </div>
              <ImageActions image={image} />
            </article>
          ))}
        </div>
      )}
      {current && <ImageDetail image={current} onClose={() => setDetail("")} />}{" "}
      {compare && (
        <Modal
          title="并排看，更容易找到方向"
          wide
          onClose={() => setCompare(false)}
        >
          <div className="compare-grid">
            {selected
              .map((id) => s.data.images.find((i) => i.id === id))
              .filter(Boolean)
              .map((i) => (
                <div key={i!.id}>
                  <img src={i!.url} />
                  <p>{i!.model}</p>
                  <small>
                    {i!.params.quality} · Seed {i!.params.seed ?? "自动"}
                  </small>
                  <ImageActions image={i!} />
                </div>
              ))}
          </div>
        </Modal>
      )}
      {gc && (
        <Modal title="清理淘汰作品" onClose={() => setGc(false)}>
          <p>
            将删除当前项目中已标记淘汰图片的文件、缩略图和元数据。正在被任务引用的图片会跳过；共用原图文件会保留。
          </p>
          <Button
            variant="danger"
            disabled={action.busy}
            onClick={() =>
              action.run(async () => {
                const r = await post<{ deleted: number }>("/images/gc", {
                  projectId: s.projectId,
                });
                await s.refresh();
                setGc(false);
                s.toast(`已清理 ${r.deleted} 张作品`);
              })
            }
          >
            确认删除淘汰文件
          </Button>
        </Modal>
      )}
    </div>
  );
}

type CostData = {
  totals: Record<string, { settled: number; reserved: number; total: number }>;
  tasks: Task[];
  charges: {
    id: string;
    model_id: string;
    kind: string;
    amount: number;
    currency: string;
    source: string;
    created_at: number;
  }[];
};
export function CostsPage() {
  const s = useStore();
  const [costs, setCosts] = useState<CostData | null>(null);
  const [currency, setCurrency] = useState("USD");
  const action = useAction();
  useEffect(() => {
    api<CostData>("/costs")
      .then(setCosts)
      .catch((e) => s.set({ error: e.message }));
  }, [s.data.tasks]);
  const totals = costs?.totals[currency] || {
    settled: 0,
    reserved: 0,
    total: 0,
  };
  const tasks = (costs?.tasks || []).filter(
    (t) => t.currency === currency && t.status === "succeeded",
  );
  const byModel = new Map<string, number>();
  tasks.forEach((t) =>
    byModel.set(
      t.modelName,
      (byModel.get(t.modelName) || 0) + (t.actualCost ?? t.estimatedCost),
    ),
  );
  (costs?.charges || [])
    .filter((c) => c.currency === currency)
    .forEach((c) => {
      const name =
        s.data.models.find((m) => m.id === c.model_id)?.name || c.model_id;
      byModel.set(name, (byModel.get(name) || 0) + c.amount);
    });
  const bars = [...byModel].sort((a, b) => b[1] - a[1]);
  const max = Math.max(...bars.map((b) => b[1]), 0.01);
  const batch = new Map<string, { n: number; amount: number }>();
  tasks.forEach((t) => {
    const prev = batch.get(t.batchId) || { n: 0, amount: 0 };
    batch.set(t.batchId, {
      n: prev.n + 1,
      amount: prev.amount + (t.actualCost ?? t.estimatedCost),
    });
  });
  return (
    <div className="page-padding">
      <PageHeading
        title="每一分灵感，都有数"
        description="实际费用与估算分别记录，各币种独立统计，不自动换算汇率。"
      >
        <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
          {[
            ...new Set(["USD", "CNY", ...Object.keys(costs?.totals || {})]),
          ].map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
        <a className="btn secondary" href="/api/costs/export">
          <Download size={15} />
          导出 CSV
        </a>
      </PageHeading>
      <div className="cost-summary">
        <div>
          <span>累计计入费用</span>
          <strong>{money(totals.settled, currency)}</strong>
          <small>已完成图片与对话，包括价格表估算</small>
        </div>
        <div>
          <span>任务预占</span>
          <strong>{money(totals.reserved, currency)}</strong>
          <small>排队、执行中及扣费状态不明的请求</small>
        </div>
        <div>
          <span>预算剩余</span>
          <strong>
            {s.config?.settings.totalBudgets[currency] !== undefined
              ? money(
                  Math.max(
                    0,
                    s.config.settings.totalBudgets[currency] - totals.total,
                  ),
                  currency,
                )
              : "未设上限"}
          </strong>
          <button
            className="text-button"
            onClick={() => s.set({ page: "settings" })}
          >
            调整预算
            <ArrowUpRight size={13} />
          </button>
        </div>
      </div>
      <div className="cost-grid">
        <section className="surface">
          <h2>按模型</h2>
          {bars.length ? (
            bars.map(([name, value]) => (
              <div className="cost-bar" key={name}>
                <div>
                  <span>{name}</span>
                  <strong>{money(value, currency)}</strong>
                </div>
                <div className="bar-track">
                  <i
                    style={{ width: Math.max(2, (value / max) * 100) + "%" }}
                  />
                </div>
              </div>
            ))
          ) : (
            <p className="muted">生成作品后，这里会呈现你的模型投入。</p>
          )}
        </section>
        <section className="surface">
          <h2>每轮创作</h2>
          {[...batch].map(([id, b]) => (
            <div className="cost-batch" key={id}>
              <span>
                批次 {id.slice(0, 8)}
                <small>{b.n} 张作品</small>
              </span>
              <strong>{money(b.amount, currency)}</strong>
            </div>
          ))}
          {!batch.size && <p className="muted">尚无完成的生成批次。</p>}
        </section>
      </div>
      <div className="section-heading ledger-title">
        <h2>费用明细</h2>
        <span className="muted">“实际”仅用于供应商明确返回 cost 的响应</span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>模型 / 类型</th>
              <th>时间</th>
              <th>预估</th>
              <th>记录费用</th>
              <th>来源</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((t) => (
              <tr key={t.id}>
                <td>
                  {t.modelName}
                  <small className="block muted">图片生成</small>
                </td>
                <td>{time(t.createdAt)}</td>
                <td>{money(t.estimatedCost, currency)}</td>
                <td>{money(t.actualCost ?? t.estimatedCost, currency)}</td>
                <td>
                  <span className="pill">
                    {t.costSource === "provider" ? "实际" : "估算"}
                  </span>
                </td>
              </tr>
            ))}
            {costs?.charges
              .filter((c) => c.currency === currency)
              .map((c) => (
                <tr key={c.id}>
                  <td>
                    {s.data.models.find((m) => m.id === c.model_id)?.name}
                    <small className="block muted">{c.kind}</small>
                  </td>
                  <td>{time(c.created_at)}</td>
                  <td>—</td>
                  <td>{money(c.amount, currency)}</td>
                  <td>{c.source === "provider" ? "实际" : "估算"}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function MemoryPage() {
  const s = useStore();
  const [scope, setScope] = useState<Memory["scope"]>("project");
  const [edit, setEdit] = useState<Partial<Memory> | null>(null);
  const action = useAction();
  const session = s.data.sessions.find((v) => v.id === s.sessionId);
  const items = s.data.memories.filter(
    (m) =>
      m.projectId === s.projectId &&
      m.scope === scope &&
      (scope !== "session" || m.sessionId === s.sessionId),
  );
  return (
    <div className="page-padding">
      <PageHeading
        title="让创作记住你的偏好"
        description="角色、世界观、色彩与约束，会在下一轮生成时成为上下文。"
      >
        <Button
          onClick={() =>
            downloadJSON(
              "memories.json",
              s.data.memories.filter((m) => m.projectId === s.projectId),
            )
          }
        >
          <Download size={15} />
          导出记忆
        </Button>
        <Button
          variant="primary"
          onClick={() =>
            setEdit({
              scope,
              content: "",
              enabled: true,
              imageId: s.selectedImageId,
            })
          }
        >
          <Plus size={15} />
          添加记忆
        </Button>
      </PageHeading>
      <div className="memory-intro">
        <Sparkles size={25} />
        <div>
          <strong>每一次创作，都可以从已有理解出发。</strong>
          <p>
            项目记忆长期生效，会话记忆只作用于当前会话；图像记忆在该图作为参考时参与。最终提示词可在任务详情中查看。
          </p>
        </div>
      </div>
      <div className="tabs">
        {[
          ["project", "项目记忆"],
          ["session", "会话记忆"],
          ["image", "图像记忆"],
        ].map(([v, label]) => (
          <button
            className={scope === v ? "active" : ""}
            key={v}
            onClick={() => setScope(v as Memory["scope"])}
          >
            {label}
          </button>
        ))}
      </div>
      {!items.length ? (
        <Empty
          title={
            scope === "project"
              ? "记住这个世界的设定"
              : "添加一条值得记住的线索"
          }
        >
          例如：深木色工坊、柔和暖橘光；小伞是蓝色短发、红蓝异色瞳。
        </Empty>
      ) : (
        <div className="memory-list">
          {items.map((m) => (
            <article
              key={m.id}
              className={`memory-card ${!m.enabled ? "disabled" : ""}`}
            >
              <div className="memory-card-top">
                <span className="pill">
                  {m.scope === "project"
                    ? "项目"
                    : m.scope === "session"
                      ? "会话"
                      : "图像"}
                  记忆
                </span>
                <div className="row">
                  <button
                    className="icon-btn"
                    title={m.enabled ? "停用记忆" : "启用记忆"}
                    onClick={() =>
                      action.run(async () => {
                        await post("/memories", { ...m, enabled: !m.enabled });
                        await s.refresh();
                      })
                    }
                  >
                    <Power size={16} />
                  </button>
                  <button
                    className="icon-btn"
                    title="编辑记忆"
                    onClick={() => setEdit(m)}
                  >
                    <Edit3 size={16} />
                  </button>
                  <button
                    className="icon-btn"
                    title="删除记忆"
                    onClick={() =>
                      action.run(async () => {
                        await api("/memories/" + m.id, { method: "DELETE" });
                        await s.refresh();
                      })
                    }
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>
              <p className="pre-wrap">{m.content}</p>
              <small className="muted">
                {m.enabled ? "参与后续生成" : "已停用"} · {time(m.createdAt)}
              </small>
            </article>
          ))}
        </div>
      )}
      {scope === "session" && session && (
        <section className="surface session-memory">
          <div className="section-heading">
            <h2>当前会话上下文</h2>
            <div className="row">
              <Button
                onClick={() =>
                  action.run(async () => {
                    await post("/sessions/" + session.id + "/compress");
                    await s.refresh();
                    s.toast("已压缩为最近 5000 字的本地摘要，不调用模型");
                  })
                }
              >
                压缩上下文
              </Button>
              <Button
                variant="ghost"
                onClick={() =>
                  action.run(async () => {
                    await api("/sessions/" + session.id + "/context", {
                      method: "DELETE",
                    });
                    await s.refresh();
                  })
                }
              >
                清除上下文
              </Button>
            </div>
          </div>
          {session.summary && <p className="pre-wrap">{session.summary}</p>}
          {session.messages.map((m, i) => (
            <div key={i} className="chat-line">
              <small>{m.role === "user" ? "你" : "创作助手"}</small>
              <p>{m.content}</p>
            </div>
          ))}
          {!session.messages.length && !session.summary && (
            <p className="muted">在画布里继续追问，相关对话会保存在这里。</p>
          )}
        </section>
      )}
      {scope === "image" && (
        <section className="surface">
          <h2>图像元数据记忆</h2>
          <p className="muted">
            以下信息自动参与参考图的后续生成，无需重复录入。
          </p>
          {s.data.images
            .filter((i) => i.projectId === s.projectId)
            .slice(-12)
            .reverse()
            .map((i) => (
              <div key={i.id} className="image-memory">
                <img src={i.thumbnailUrl} />
                <div>
                  <strong>{i.prompt}</strong>
                  <small>
                    {i.model} · 评分 {i.rating} ·{" "}
                    {i.parentId
                      ? "来自父图 " + i.parentId.slice(0, 8)
                      : "原始图片"}
                  </small>
                </div>
              </div>
            ))}
        </section>
      )}
      {edit && (
        <Modal
          title={edit.id ? "编辑创作记忆" : "添加创作记忆"}
          onClose={() => setEdit(null)}
        >
          <Field label="作用范围">
            <select
              value={edit.scope}
              onChange={(e) =>
                setEdit({ ...edit, scope: e.target.value as Memory["scope"] })
              }
            >
              <option value="project">整个项目</option>
              <option value="session">当前会话</option>
              <option value="image">指定图片</option>
            </select>
          </Field>
          {edit.scope === "image" && (
            <Field label="关联图片">
              <select
                value={edit.imageId || ""}
                onChange={(e) => setEdit({ ...edit, imageId: e.target.value })}
              >
                <option value="">请选择图片</option>
                {s.data.images
                  .filter((i) => i.projectId === s.projectId)
                  .map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.prompt.slice(0, 40)}
                    </option>
                  ))}
              </select>
            </Field>
          )}
          <Field label="内容">
            <textarea
              rows={7}
              value={edit.content}
              onChange={(e) => setEdit({ ...edit, content: e.target.value })}
              placeholder="记录稳定的风格偏好、角色特征或世界观设定…"
            />
          </Field>
          <Button
            variant="primary"
            disabled={action.busy || !edit.content?.trim()}
            onClick={() =>
              action.run(async () => {
                await post("/memories", {
                  ...edit,
                  projectId: s.projectId,
                  sessionId: s.sessionId,
                });
                await s.refresh();
                setEdit(null);
              })
            }
          >
            保存记忆
          </Button>
        </Modal>
      )}
    </div>
  );
}
