import { useEffect, useState } from "react";
import {
  Badge,
  Button,
  Field,
  Input,
  Select,
  Switch,
} from "./ui";
import {
  ArrowDownload20Regular,
  ArrowUndo20Regular,
  Document20Regular,
  Folder20Regular,
  History20Regular,
  Info20Regular,
  Link20Regular,
  Search20Regular,
  Sparkle20Regular,
} from "./icons";
import { api } from "./api";
import { Diff, Empty } from "./shared";
import {
  actions,
  date,
  errorText,
  kinds,
  split,
  statuses,
  textValue,
} from "./utils";
import type {
  Action,
  AppState,
  Kind,
  NotesData,
  Policy,
  Project,
  Run,
  Settings,
} from "./types";

export function History({
  state,
  projectId,
  run,
  busy,
}: {
  state: AppState;
  projectId: string;
  run: Run;
  busy: string;
}) {
  const [expanded, setExpanded] = useState(""),
    [confirm, setConfirm] = useState(""),
    [undoDiff, setUndoDiff] = useState<Record<string, string>>({});
  const writes = state.writes.filter((w) => w.project_id === projectId);
  if (!writes.length)
    return (
      <Empty icon={<History20Regular />} title="还没有写入记录">
        确认提案后，你可以在这里查看变更、来源与恢复状态。
      </Empty>
    );
  return (
    <div className="records">
      <div className="records-header">
        <span>共 {writes.length} 次写入</span>
        <span>撤销前会校验笔记，后续编辑不会被直接覆盖。</span>
      </div>
      {writes.map((w) => (
        <article className="write-row" key={w.id}>
          <div className="write-summary">
            <Document20Regular />
            <div className="write-title">
              <strong>
                {state.proposals.find((p) => p.id === w.proposal_id)?.title ||
                  w.target}
              </strong>
              <span className="path">{w.target}</span>
            </div>
            <time>{date(w.created_at)}</time>
            <Badge
              appearance="outline"
              color={
                ["failed", "conflict", "undo_conflict"].includes(w.status)
                  ? "danger"
                  : "informative"
              }
            >
              {statuses[w.status] || w.status}
            </Badge>
            <Button
              size="small"
              onClick={() => setExpanded(expanded === w.id ? "" : w.id)}
            >
              {expanded === w.id ? "收起差异" : "查看差异"}
            </Button>
            {["applied", "undo_conflict", "conflict"].includes(w.status) && (
              <Button
                size="small"
                icon={<ArrowUndo20Regular />}
                disabled={!!busy}
                onClick={() => setConfirm(w.id)}
              >
                撤销
              </Button>
            )}
          </div>
          {expanded === w.id && (
            <Diff
              preview={{
                before: w.before,
                after: w.after,
                diff: simpleDiff(w.before, w.after),
              }}
            />
          )}
          {undoDiff[w.id] && (
            <>
              <p className="form-error">
                当前笔记已有后续编辑，未自动撤销。请核对以下反向差异并在笔记中人工处理。
              </p>
              <Diff preview={{ before: "", after: "", diff: undoDiff[w.id] }} />
            </>
          )}
          {confirm === w.id && (
            <div className="inline-confirm">
              <span>撤销本次对「{w.target}」的写入？</span>
              <Button size="small" onClick={() => setConfirm("")}>
                取消
              </Button>
              <Button
                size="small"
                appearance="primary"
                disabled={!!busy}
                onClick={() =>
                  run(
                    `undo-${w.id}`,
                    async () => {
                      const result = await api<{
                        status: string;
                        requires_review?: boolean;
                        error?: string;
                        diff?: string;
                      }>(`/writes/${w.id}/undo`, "POST", {});
                      setConfirm("");
                      if (
                        result.requires_review ||
                        result.status === "conflict"
                      ) {
                        setUndoDiff((prev) => ({
                          ...prev,
                          [w.id]: result.diff || "目标已有后续编辑。",
                        }));
                        throw new Error(
                          result.error ||
                            "笔记已有后续编辑，未自动撤销；请查看反向差异。",
                        );
                      }
                    },
                    "本次写入已撤销。",
                  )
                }
              >
                确认撤销
              </Button>
            </div>
          )}
        </article>
      ))}
    </div>
  );
}
function simpleDiff(before = "", after = "") {
  return `--- 写入前\n+++ 写入后\n${
    before
      ? before
          .split("\n")
          .map((l) => `-${l}`)
          .join("\n") + "\n"
      : ""
  }${after
    .split("\n")
    .map((l) => `+${l}`)
    .join("\n")}`;
}

export function NotesGraph({ project }: { project: Project }) {
  const [data, setData] = useState<NotesData | null>(null),
    [error, setError] = useState(""),
    [active, setActive] = useState(""),
    [query, setQuery] = useState("");
  useEffect(() => {
    let live = true;
    api<NotesData>(`/projects/${project.id}/notes`)
      .then((d) => {
        if (live) {
          setData(d);
          setActive(d.notes[0]?.path || "");
        }
      })
      .catch((e) => {
        if (live) setError(errorText(e));
      });
    return () => {
      live = false;
    };
  }, [project.id]);
  if (error)
    return (
      <div role="alert" className="message error">
        {error}
      </div>
    );
  if (!data)
    return (
      <div className="loading">
        <div className="skeleton" />
        <div className="skeleton" />
      </div>
    );
  if (!data.notes.length)
    return (
      <Empty icon={<Link20Regular />} title="知识库里还没有可见笔记">
        确认一项提案后，笔记及其中真实存在的链接会显示在这里。
      </Empty>
    );
  const current = data.notes.find((n) => n.path === active);
  const nodes = data.nodes.slice(0, 40).map((n, index, arr) => {
    const angle = (index * Math.PI * 2) / arr.length - Math.PI / 2,
      radius = arr.length === 1 ? 0 : arr.length <= 4 ? 110 : 150;
    return {
      ...n,
      x: 340 + radius * Math.cos(angle),
      y: 215 + radius * Math.sin(angle),
    };
  });
  return (
    <div className="notes-layout">
      <aside className="notes-list">
        <div className="notes-list-heading">
          <strong>{data.notes.length} 篇笔记</strong>
          <Badge appearance="outline">{data.edges.length} 条关联</Badge>
        </div>
        <Input
          contentBefore={<Search20Regular />}
          placeholder="搜索笔记"
          aria-label="搜索知识库笔记"
          value={query}
          onChange={(_, d) => setQuery(d.value)}
        />
        {data.notes
          .filter((n) => `${n.title} ${n.path}`.includes(query))
          .map((n) => (
            <button
              className={`note-item ${n.path === active ? "selected" : ""}`}
              key={n.path}
              onClick={() => setActive(n.path)}
            >
              <Document20Regular />
              <span>
                <strong>{n.title}</strong>
                <small>{n.path}</small>
              </span>
            </button>
          ))}
      </aside>
      <section className="graph-main">
        <div className="section-heading">
          <h2>笔记关系</h2>
          <span>仅显示知识库中的内部链接</span>
        </div>
        <div className="graph-canvas">
          <svg
            viewBox="0 0 680 430"
            role="img"
            aria-label={`${data.notes.length} 篇笔记和 ${data.edges.length} 条实际内部链接构成的关系图`}
          >
            {data.edges.map((edge, i) => {
              const a = nodes.find((n) => n.id === edge.source),
                b = nodes.find((n) => n.id === edge.target);
              return a && b ? (
                <line
                  key={i}
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  className={
                    edge.source === active || edge.target === active
                      ? "graph-edge active"
                      : "graph-edge"
                  }
                />
              ) : null;
            })}
            {nodes.map((n) => (
              <g
                key={n.id}
                role="button"
                tabIndex={0}
                aria-label={`查看笔记 ${n.label}`}
                onClick={() => setActive(n.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setActive(n.id);
                  }
                }}
                className={n.id === active ? "graph-node active" : "graph-node"}
              >
                <circle cx={n.x} cy={n.y} r={n.id === active ? 9 : 7} />
                <text x={n.x} y={n.y + 26} textAnchor="middle">
                  {n.label.length > 15 ? n.label.slice(0, 15) + "…" : n.label}
                </text>
              </g>
            ))}
          </svg>
          {data.nodes.length > 40 && (
            <p className="graph-limit">
              图中展示前 40 篇笔记；全部笔记可在左侧搜索查看。
            </p>
          )}
        </div>
        {current && (
          <div className="note-preview">
            <div className="section-heading">
              <h2>{current.title}</h2>
              <span className="path">{current.path}</span>
            </div>
            <pre>{current.content}</pre>
          </div>
        )}
      </section>
    </div>
  );
}

export function Learning({
  state,
  project,
  run,
  busy,
}: {
  state: AppState;
  project: Project;
  run: Run;
  busy: string;
}) {
  const feedback = state.feedback.filter(
      (f) => f.project_id === project.id && !f.synthetic,
    ),
    policies = state.policies.filter((p) => p.project_id === project.id);
  const samples = state.learning?.[project.id]?.human_samples ?? 0;
  const sessions = state.learning?.[project.id]?.human_sessions ?? 0;
  const [kind, setKind] = useState<Kind>("knowledge"),
    [action, setAction] = useState("save"),
    [authorizationDraft, setAuthorizationDraft] = useState<
      boolean | undefined
    >();
  const authorization =
    authorizationDraft ??
    Boolean(
      project.authorizations?.find(
        (scope) => scope.kind === kind && scope.action === action,
      )?.enabled,
    );
  return (
    <div className="learning-layout">
      <section className="learning-overview">
        <div className="section-heading">
          <h2>审核样本</h2>
          <Badge appearance="tint" color="brand">
            项目内隔离
          </Badge>
        </div>
        <p>
          真实人工反馈用于学习内容、目标与链接偏好。暂缓和合成演示数据不计入有效样本。
        </p>
        <div className="learning-metrics">
          <div>
            <strong>{samples}</strong>
            <span>真实审核样本</span>
            <small>进入评估至少 {project.min_samples} 项</small>
          </div>
          <div>
            <strong>{sessions}</strong>
            <span>来源会话</span>
            <small>至少覆盖 {project.min_sessions} 个会话</small>
          </div>
          <div>
            <strong>{policies.length}</strong>
            <span>策略版本</span>
            <small>候选策略需要独立验证</small>
          </div>
        </div>
        <div className="sample-progress">
          <div
            style={{
              width: `${Math.min((samples / project.min_samples) * 100, 100)}%`,
            }}
          />
        </div>
        <div className="learning-status">
          <Info20Regular />
          <span>
            {samples < project.min_samples || sessions < project.min_sessions
              ? "样本仍在积累。可以生成候选规则，但不会据此开放自动写入。"
              : "样本数量达到基础门槛。能否使用候选策略还取决于独立评估结果。"}
          </span>
          <Button
            appearance="primary"
            icon={<Sparkle20Regular />}
            disabled={!!busy}
            onClick={() =>
              run(
                "learn",
                () => api(`/projects/${project.id}/learn`, "POST", {}),
                "候选策略任务已完成，请查看版本与评估结果。",
              )
            }
          >
            {busy === "learn" ? "生成中…" : "生成候选策略"}
          </Button>
          {state.settings.enabled && state.settings.learning_enabled && (
            <Button
              disabled={!!busy}
              onClick={() =>
                run(
                  "optimize",
                  () => api(`/projects/${project.id}/optimize`, "POST", {}),
                  "已生成模型辅助候选策略；尚未启用自动写入。",
                )
              }
            >
              {busy === "optimize" ? "优化中…" : "模型辅助优化"}
            </Button>
          )}
        </div>
      </section>
      <section className="policy-section">
        <div className="section-heading">
          <h2>策略版本</h2>
          <span>发布与回退保留记录</span>
        </div>
        {!policies.length ? (
          <div className="compact-empty">
            还没有策略版本。完成真实审核后，可以生成可读的候选偏好规则。
          </div>
        ) : (
          policies.map((p) => (
            <PolicyRow key={p.id} policy={p} busy={busy} run={run} />
          ))
        )}
      </section>
      <section className="authorization-section">
        <div className="section-heading">
          <h2>自动化授权</h2>
          <Badge appearance="outline">独立于学习策略</Badge>
        </div>
        <p>
          授权仅针对当前项目、指定内容类型与操作。满足评估门槛后，系统才可在这一范围内执行；学习不会自行扩大范围。
        </p>
        <div className="authorization-form">
          <Field label="内容类型">
            <Select
              value={kind}
              onChange={(_, d) => {
                setKind(d.value as Kind);
                setAuthorizationDraft(undefined);
              }}
            >
              {Object.entries(kinds).map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="操作类型">
            <Select
              value={action}
              onChange={(_, d) => {
                setAction(d.value);
                setAuthorizationDraft(undefined);
              }}
            >
              <option value="save">新建笔记</option>
              <option value="update">更新笔记</option>
            </Select>
          </Field>
          <Switch
            checked={authorization}
            onChange={(_, d) => setAuthorizationDraft(d.checked)}
            label="允许此范围的自动写入"
          />
          <Button
            disabled={!!busy}
            onClick={() =>
              run(
                "authorization",
                async () => {
                  await api(`/projects/${project.id}/authorization`, "POST", {
                    kind,
                    action,
                    enabled: authorization,
                  });
                  setAuthorizationDraft(undefined);
                },
                authorization
                  ? "已保存此范围的授权；执行仍受评估与风险门槛约束。"
                  : "已关闭此范围的自动写入授权。",
              )
            }
          >
            保存范围授权
          </Button>
        </div>
        {project.authorizations?.length ? (
          <div className="scope-list">
            {project.authorizations.map((scope, i) => (
              <Badge key={i} appearance="outline">
                {kinds[scope.kind as Kind] || scope.kind} ·{" "}
                {actions[scope.action as Action] || scope.action} ·{" "}
                {scope.enabled ? "已授权" : "已关闭"}
              </Badge>
            ))}
          </div>
        ) : (
          <p className="subtle">当前项目尚未授权任何自动写入范围。</p>
        )}
      </section>
      <section className="feedback-section">
        <div className="section-heading">
          <h2>最近的人工反馈</h2>
          <span>来源与编辑内容可追溯</span>
        </div>
        {!feedback.length ? (
          <div className="compact-empty">尚无真实人工反馈。</div>
        ) : (
          feedback.slice(0, 15).map((f) => (
            <details className="feedback-row" key={f.id}>
              <summary>
                <span>{String(f.original?.title || f.proposal_id)}</span>
                <Badge appearance="outline">
                  {actions[f.decision?.action as Action] ||
                    String(f.decision?.action || "已审核")}
                </Badge>
                <time>{date(f.created_at)}</time>
              </summary>
              <pre>
                {textValue({
                  source_session: f.session_id,
                  original: f.original,
                  decision: f.decision,
                })}
              </pre>
            </details>
          ))
        )}
      </section>
    </div>
  );
}
function PolicyRow({
  policy: p,
  run,
  busy,
}: {
  policy: Policy;
  run: Run;
  busy: string;
}) {
  return (
    <article className="policy-row">
      <div className="policy-summary">
        <div>
          <strong>
            {String(p.name || p.version || `策略 ${p.id.slice(0, 8)}`)}
          </strong>
          <span>{date(p.created_at)}</span>
        </div>
        <Badge
          appearance="outline"
          color={p.status === "active" ? "success" : "informative"}
        >
          {statuses[p.status] || p.status}
        </Badge>
        {p.status !== "active" && p.status !== "rolled_back" && (
          <Button
            size="small"
            disabled={!!busy}
            onClick={() =>
              run(
                `activate-${p.id}`,
                () => api(`/policies/${p.id}/activate`, "POST", {}),
                "已处理策略启用请求。",
              )
            }
          >
            启用策略
          </Button>
        )}
        {p.status === "active" && (
          <Button
            size="small"
            disabled={!!busy}
            onClick={() =>
              run(
                `rollback-${p.id}`,
                () => api(`/policies/${p.id}/rollback`, "POST", {}),
                "已回退策略。",
              )
            }
          >
            回退策略
          </Button>
        )}
      </div>
      <details>
        <summary>查看规则与评估依据</summary>
        <pre>{textValue(p)}</pre>
      </details>
    </article>
  );
}

export function SettingsPage({
  state,
  run,
  busy,
  onProject,
}: {
  state: AppState;
  run: Run;
  busy: string;
  onProject: (id: string) => void;
}) {
  const [name, setName] = useState(""),
    [root, setRoot] = useState(""),
    [vault, setVault] = useState(""),
    [dirs, setDirs] = useState("Library"),
    [excluded, setExcluded] = useState(".obsidian, .git"),
    [capture, setCapture] = useState(true),
    [model, setModel] = useState<Settings>(state.settings),
    [projectError, setProjectError] = useState("");
  return (
    <div className="settings-layout">
      <section className="settings-section">
        <div className="section-heading">
          <h2>会话捕获与提炼</h2>
          <span>最近 {state.events.length} 条事件</span>
        </div>
        <p>
          捕获失败、模型不可用与待抽查内容会保留在这里。重试仅生成待审核提案。
        </p>
        {!state.events.length ? (
          <div className="compact-empty">
            尚未收到会话事件。连接项目并启用捕获后，事件状态会显示在这里。
          </div>
        ) : (
          state.events.slice(0, 30).map((event) => {
            const eventStatus = String(event.status || "queued");
            const labels: Record<string, string> = {
              queued: "等待提炼",
              needs_agent: "等待 Codex 提炼",
              extracting: "提炼中",
              extracted: "已提炼",
              submitted: "已生成提案",
              filtered: "待抽查过滤内容",
              malformed: "事件格式错误",
              unknown_format: "未知格式",
              oversized: "超出输入限制",
              model_error: "模型调用失败",
              planning_error: "提案规划失败",
              capture_disabled: "捕获已关闭",
              budget_exhausted: "调用预算已用尽",
            };
            const canRetry = [
              "queued",
              "needs_agent",
              "model_error",
              "planning_error",
              "budget_exhausted",
            ].includes(eventStatus);
            return (
              <article className="capture-event" key={String(event.id)}>
                <div className="capture-summary">
                  <div>
                    <strong>
                      {state.projects.find((p) => p.id === event.project_id)
                        ?.name || "未知项目"}
                    </strong>
                    <span className="path">
                      {String(event.session_id || event.id)}
                    </span>
                  </div>
                  <Badge
                    appearance="outline"
                    color={
                      [
                        "malformed",
                        "unknown_format",
                        "oversized",
                        "model_error",
                        "budget_exhausted",
                      ].includes(eventStatus)
                        ? "warning"
                        : "informative"
                    }
                  >
                    {labels[eventStatus] || eventStatus}
                  </Badge>
                  {canRetry && (
                    <Button
                      size="small"
                      disabled={!!busy}
                      onClick={() =>
                        run(
                          `extract-${event.id}`,
                          () =>
                            api(
                              `/events/${String(event.id)}/extract`,
                              "POST",
                              {},
                            ),
                          "已处理提炼请求，请核对事件状态与审核队列。",
                        )
                      }
                    >
                      重试提炼
                    </Button>
                  )}
                </div>
                <details>
                  <summary>查看事件记录</summary>
                  <pre>{textValue(event)}</pre>
                </details>
              </article>
            );
          })
        )}
      </section>
      <section className="settings-section">
        <div className="section-heading">
          <h2>已连接项目</h2>
          <span>{state.projects.length} 个项目</span>
        </div>
        {state.projects.length ? (
          state.projects.map((p) => (
            <div className="project-setting-row" key={p.id}>
              <Folder20Regular />
              <div>
                <strong>
                  {p.name}{" "}
                  {p.synthetic && (
                    <Badge appearance="outline" color="warning">
                      合成演示
                    </Badge>
                  )}
                </strong>
                <span className="path">{p.vault}</span>
                <small>
                  可写目录：{p.writable_dirs.join("、")} ·{" "}
                  {p.capture_enabled ? "会话捕获已启用" : "会话捕获已关闭"}
                </small>
              </div>
              <Button onClick={() => onProject(p.id)}>打开项目</Button>
              <Button
                disabled={!!busy}
                onClick={() =>
                  run(
                    `capture-${p.id}`,
                    () =>
                      api(`/projects/${p.id}/capture`, "PUT", {
                        enabled: !p.capture_enabled,
                      }),
                    p.capture_enabled
                      ? "已关闭此项目的会话捕获。"
                      : "已启用此项目的会话捕获。",
                  )
                }
              >
                {p.capture_enabled ? "关闭捕获" : "启用捕获"}
              </Button>
            </div>
          ))
        ) : (
          <p className="subtle">尚未连接项目。你也可以先创建独立演示环境。</p>
        )}
        <Button
          icon={<ArrowDownload20Regular />}
          disabled={!!busy}
          onClick={() =>
            run(
              "demo",
              () => api("/demo", "POST", {}),
              "合成演示项目已就绪，可从左侧项目选择器打开。",
            )
          }
        >
          创建合成演示项目
        </Button>
      </section>
      <section className="settings-section">
        <h2>连接新项目</h2>
        <p>
          指定项目工作目录与 Obsidian 知识库。仅允许在明确指定的目录中写入
          Markdown。
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setProjectError("");
            run(
              "project-create",
              async () => {
                try {
                  const p = await api<Project>("/projects", "POST", {
                    name,
                    root,
                    vault,
                    writable_dirs: split(dirs),
                    excluded_dirs: split(excluded),
                    capture_enabled: capture,
                  });
                  setName("");
                  setRoot("");
                  setVault("");
                  onProject(p.id);
                } catch (err) {
                  setProjectError(errorText(err));
                  throw err;
                }
              },
              "项目已连接，可以开始接收提案。",
            );
          }}
        >
          <div className="form-grid">
            <Field label="项目名称" required>
              <Input
                required
                value={name}
                onChange={(_, d) => setName(d.value)}
                placeholder="例如：研究工作台"
              />
            </Field>
            <Field label="项目工作目录" required>
              <Input
                required
                value={root}
                onChange={(_, d) => setRoot(d.value)}
                placeholder="E:\Projects\my-project"
              />
            </Field>
            <Field label="Obsidian 知识库路径" required>
              <Input
                required
                value={vault}
                onChange={(_, d) => setVault(d.value)}
                placeholder="E:\Knowledge\MyVault"
              />
            </Field>
            <Field
              label="允许写入的目录"
              required
              hint="相对于知识库；多个目录以逗号分隔"
            >
              <Input
                required
                value={dirs}
                onChange={(_, d) => setDirs(d.value)}
              />
            </Field>
            <Field label="排除目录" hint="多个目录以逗号分隔">
              <Input
                value={excluded}
                onChange={(_, d) => setExcluded(d.value)}
              />
            </Field>
            <Switch
              checked={capture}
              onChange={(_, d) => setCapture(d.checked)}
              label="启用此项目的会话捕获"
            />
          </div>
          {projectError && (
            <p role="alert" className="form-error">
              {projectError}
            </p>
          )}
          <Button
            appearance="primary"
            type="submit"
            disabled={!!busy || !name || !root || !vault || !dirs}
          >
            {busy === "project-create" ? "正在连接…" : "连接项目"}
          </Button>
        </form>
      </section>
      <section className="settings-section">
        <h2>可选模型接入</h2>
        <p>
          后台提炼与策略优化使用这里的模型。远程端点会接收筛选后的内容，请仅启用你认可的服务。
        </p>
        <div className="form-grid">
          <Field label="后台提炼方式">
            <Select value={model.provider || 'openai_compatible'} onChange={e => setModel({ ...model, provider: e.target.value as 'openai_compatible' | 'codex_cli' })}>
              <option value="openai_compatible">OpenAI 兼容接口</option>
              <option value="codex_cli">本机 Codex CLI</option>
            </Select>
          </Field>
          <Field label="OpenAI 兼容端点">
            <Input
              value={model.endpoint}
              onChange={(_, d) => setModel({ ...model, endpoint: d.value })}
            />
          </Field>
          <Field label="模型名称">
            <Input
              value={model.model}
              onChange={(_, d) => setModel({ ...model, model: d.value })}
              placeholder="填写提供方的模型标识"
            />
          </Field>
          <Field
            label="密钥环境变量名称"
            hint="只保存变量名称；不要在这里填写密钥。"
          >
            <Input
              value={model.key_env}
              onChange={(_, d) => setModel({ ...model, key_env: d.value })}
            />
          </Field>
          <Field label="每日调用上限">
            <Input
              type="number"
              min={0}
              max={1000}
              value={String(model.daily_calls)}
              onChange={(_, d) =>
                setModel({ ...model, daily_calls: Number(d.value) })
              }
            />
          </Field>
          <Field label="单批输入字符上限">
            <Input
              type="number"
              min={1000}
              max={100000}
              value={String(model.max_input_chars)}
              onChange={(_, d) =>
                setModel({ ...model, max_input_chars: Number(d.value) })
              }
            />
          </Field>
          <Field label="单次输出 token 上限">
            <Input
              type="number"
              min={100}
              max={8000}
              value={String(model.max_tokens)}
              onChange={(_, d) =>
                setModel({ ...model, max_tokens: Number(d.value) })
              }
            />
          </Field>
        </div>
        <div className="model-toggles">
          <Switch
            checked={model.enabled}
            onChange={(_, d) => setModel({ ...model, enabled: d.checked })}
            label="启用模型调用并允许向此端点发送内容"
          />
          <Switch
            checked={model.learning_enabled}
            onChange={(_, d) =>
              setModel({ ...model, learning_enabled: d.checked })
            }
            label="启用模型辅助策略学习"
          />
        </div>
        <Button
          appearance="primary"
          disabled={!!busy}
          onClick={() =>
            run(
              "settings",
              () => api("/settings", "PUT", model),
              "模型设置已保存。",
            )
          }
        >
          保存模型设置
        </Button>
      </section>
    </div>
  );
}
