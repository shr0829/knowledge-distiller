import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  FluentProvider,
  Input,
  Select,
  Tooltip,
  webLightTheme,
} from "@fluentui/react-components";
import {
  ArrowClockwise20Regular,
  BookOpen24Regular,
  Checkmark20Regular,
  ChevronRight16Regular,
  DataUsage20Regular,
  Dismiss20Regular,
  Document20Regular,
  DocumentAdd20Regular,
  Filter20Regular,
  History20Regular,
  Info20Regular,
  Link20Regular,
  List20Regular,
  Search20Regular,
  Settings20Regular,
  ShieldCheckmark20Regular,
} from "@fluentui/react-icons";
import { api } from "./api";
import { ProposalForm, ReviewDetail } from "./Review";
import { History, Learning, NotesGraph, SettingsPage } from "./Secondary";
import { KnowledgePage } from './Knowledge';
import { Diff, Empty } from "./shared";
import { actions, date, errorText, isPending, kinds, statuses } from "./utils";
import type { AppState, Preview, Proposal, Review } from "./types";
import "./App.css";

type Page = "review" | "knowledge" | "history" | "graph" | "learning" | "settings";
type BatchItem = { proposal: Proposal; review: Review; preview: Preview };
const batchEligible = (p: Proposal) =>
  isPending(p) && ["save", "update"].includes(p.recommended_action);
const pages = [
  { id: "knowledge" as Page, label: "项目知识加工", icon: <Document20Regular /> },
  { id: "review" as Page, label: "审核队列", icon: <List20Regular /> },
  { id: "history" as Page, label: "写入记录", icon: <History20Regular /> },
  { id: "graph" as Page, label: "笔记与关联", icon: <Link20Regular /> },
  { id: "learning" as Page, label: "反馈与学习", icon: <DataUsage20Regular /> },
  { id: "settings" as Page, label: "项目与设置", icon: <Settings20Regular /> },
];

function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [page, setPage] = useState<Page>("review");
  const [projectId, setProjectId] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState("all");
  const [filter, setFilter] = useState("pending");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [checked, setChecked] = useState<Record<string, number>>({});
  const [batch, setBatch] = useState<BatchItem[] | null>(null);
  const [batchError, setBatchError] = useState("");
  const [newProposal, setNewProposal] = useState(false);
  const [online, setOnline] = useState(false);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const reload = useCallback(async () => {
    const data = await api<AppState>("/state");
    setState(data);
    setOnline(true);
    setProjectId((prev) =>
      data.projects.some((p) => p.id === prev)
        ? prev
        : data.projects.find((p) => p.id === data.preferred_project_id)?.id ||
          data.projects.find((p) => !p.synthetic)?.id || data.projects[0]?.id || "",
    );
  }, []);
  useEffect(() => {
    void Promise.resolve()
      .then(reload)
      .catch((e) => { setOnline(false); setError(errorText(e)); });
  }, [reload]);
  useEffect(() => {
    if (busy) return;
    let active = true;
    let refreshing = false;
    const refresh = async () => {
      if (refreshing || document.visibilityState === "hidden") return;
      refreshing = true;
      try {
        const runtime = await api<{ build_id: string }>("/runtime");
        if (active) setUpdateAvailable(runtime.build_id !== __LIBRARY_BUILD_ID__);
        await reload();
      } catch (e) {
        if (active) { setOnline(false); setError(errorText(e)); }
      } finally { refreshing = false; }
    };
    const timer = window.setInterval(() => { void refresh(); }, 15000);
    window.addEventListener("focus", refresh);
    return () => { active = false; window.clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, [busy, reload]);
  const run = async (
    key: string,
    operation: () => Promise<unknown>,
    success?: string,
  ) => {
    setBusy(key);
    setError("");
    setNotice("");
    try {
      await operation();
      await reload();
      if (success) setNotice(success);
    } catch (e) {
      if (key === "refresh") setOnline(false);
      setError(errorText(e));
      await reload().catch(() => {});
    } finally {
      setBusy("");
    }
  };
  const project = state?.projects.find((p) => p.id === projectId);
  const mode = state?.learning?.[projectId]?.mode || "ASSISTED";
  const projectProposals = useMemo(
    () => state?.proposals.filter((p) => p.project_id === projectId) || [],
    [state, projectId],
  );
  const pending = projectProposals.filter(isPending);
  const visible = projectProposals.filter(
    (p) =>
      (filter === "all" ||
        (filter === "pending" ? isPending(p) : p.status === filter)) &&
      (kind === "all" || p.kind === kind) &&
      (!search ||
        `${p.title} ${p.content} ${p.target} ${p.source}`
          .toLocaleLowerCase()
          .includes(search.toLocaleLowerCase())),
  );
  const selected = visible.find((p) => p.id === selectedId) || visible[0];
  const selectedCount = Object.keys(checked).length;
  const changeProject = (id: string) => {
    setProjectId(id);
    setChecked({});
    setSelectedId("");
    setSearch("");
  };
  const startBatch = async () => {
    setBusy("batch");
    setError("");
    setBatchError("");
    try {
      const items: BatchItem[] = [];
      for (const [id, revision] of Object.entries(checked)) {
        const proposal = projectProposals.find(
          (p) => p.id === id && p.revision === revision && batchEligible(p),
        );
        if (!proposal)
          throw new Error("选中的提案版本已变化，请重新选择后预览。");
        const review: Review = {
          revision,
          action: proposal.recommended_action === "update" ? "update" : "save",
          reason: "",
        };
        items.push({
          proposal,
          review,
          preview: await api<Preview>(
            `/proposals/${id}/preview`,
            "POST",
            review,
          ),
        });
      }
      setBatch(items);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy("");
    }
  };
  const confirmBatch = async () => {
    if (!batch) return;
    setBusy("batch-confirm");
    setBatchError("");
    const remaining = [...batch];
    let done = 0;
    try {
      for (const item of batch) {
        await api(`/proposals/${item.proposal.id}/review`, "POST", {
          ...item.review,
          preview_token: item.preview.preview_token,
        });
        done += 1;
        remaining.shift();
        setChecked((prev) => {
          const next = { ...prev };
          delete next[item.proposal.id];
          return next;
        });
      }
      setBatch(null);
      setNotice(`已确认并写入 ${done} 项提案。`);
    } catch (e) {
      setBatch(remaining);
      setBatchError(
        `已完成 ${done} 项，剩余 ${remaining.length} 项未写入。${errorText(e)} 请关闭后重新预览剩余项。`,
      );
    } finally {
      await reload().catch((e) => setError(errorText(e)));
      setBusy("");
    }
  };
  return (
    <FluentProvider theme={webLightTheme} className="app-provider">
      <a className="skip-link" href="#main">
        跳到主要内容
      </a>
      <div className="app-shell">
        <aside className="sidebar" aria-label="主导航">
          <div className="brand">
            <span className="brand-mark">
              <BookOpen24Regular />
            </span>
            <div>
              <strong>知序</strong>
              <span>Codex · Obsidian</span>
            </div>
          </div>
          <div className="project-picker">
            <label htmlFor="project-picker">当前项目</label>
            <Select
              id="project-picker"
              value={projectId}
              onChange={(_, d) => changeProject(d.value)}
              disabled={!state?.projects.length}
            >
              {!state?.projects.length && (
                <option value="">尚未连接项目</option>
              )}
              {state?.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </div>
          <nav>
            {pages.map((item) => (
              <button
                key={item.id}
                className={`nav-item ${page === item.id ? "active" : ""}`}
                aria-current={page === item.id ? "page" : undefined}
                title={item.label}
                onClick={() => setPage(item.id)}
              >
                {item.icon}
                <span>{item.label}</span>
                {item.id === "review" && pending.length > 0 && (
                  <span className="nav-count">{pending.length}</span>
                )}
              </button>
            ))}
          </nav>
          <div className="sidebar-footer">
            <ShieldCheckmark20Regular />
            <div>
              <strong>
                {mode === "AUTO_LIMITED"
                  ? "限定自动化模式"
                  : mode === "SHADOW"
                    ? "影子验证模式"
                    : "人工审核模式"}
              </strong>
              <span>
                {mode === "AUTO_LIMITED"
                  ? "仅授权范围可自动写入"
                  : "每次写入由你确认"}
              </span>
            </div>
          </div>
        </aside>
        <div className="workspace">
          <header className="topbar">
            <div className="breadcrumb">
              <span>知识工作台</span>
              <ChevronRight16Regular />
              <strong>{pages.find((p) => p.id === page)?.label}</strong>
            </div>
            <div className="topbar-status">
              <span className={`status-dot ${online ? "online" : ""}`} />
              <span>{online ? "本地服务已连接" : state ? "本地连接已中断" : "连接本地服务"}</span>
              <Tooltip content={`面板构建 ${__LIBRARY_BUILD_ID__}`} relationship="description">
                <span className="muted">构建 {__LIBRARY_BUILD_ID__.slice(0, 6)}</span>
              </Tooltip>
              <Tooltip content="刷新本地数据" relationship="label">
                <Button
                  appearance="subtle"
                  size="small"
                  icon={<ArrowClockwise20Regular />}
                  disabled={!!busy}
                  onClick={() => run("refresh", reload, "已刷新本地数据。")}
                />
              </Tooltip>
            </div>
          </header>
          <main
            id="main"
            className={`main ${page === "review" ? "main-review" : ""}`}
          >
            {updateAvailable && (
              <div className="message" role="status">
                <Info20Regular />
                <span>{__LIBRARY_MCP_APP__
                  ? "面板有新版本。请关闭并重新打开知序面板。"
                  : "面板有新版本。重新加载页面即可更新。"} 当前编辑内容请先保留。</span>
                {!__LIBRARY_MCP_APP__ && <Button size="small" onClick={() => location.reload()}>重新加载</Button>}
              </div>
            )}
            {error && (
              <div className="message error" role="alert">
                <Info20Regular />
                <span>{error}</span>
                <Button
                  size="small"
                  appearance="subtle"
                  icon={<Dismiss20Regular />}
                  aria-label="关闭错误消息"
                  onClick={() => setError("")}
                />
              </div>
            )}
            {notice && (
              <div className="message success" role="status">
                <Checkmark20Regular />
                <span>{notice}</span>
                <Button
                  size="small"
                  appearance="subtle"
                  icon={<Dismiss20Regular />}
                  aria-label="关闭提示"
                  onClick={() => setNotice("")}
                />
              </div>
            )}
            {!state ? (
              error ? (
                <Empty
                  title="尚未连接审核会话"
                  action={
                    <Button onClick={() => run("retry", reload)}>
                      重新连接
                    </Button>
                  }
                >
                  请从本地启动脚本打开面板，然后重新连接。
                </Empty>
              ) : (
                <div
                  className="loading"
                  aria-busy="true"
                  aria-label="正在加载工作台"
                >
                  <div className="skeleton title" />
                  <div className="skeleton" />
                  <div className="skeleton" />
                  <div className="skeleton" />
                </div>
              )
            ) : !project && page !== "settings" ? (
              <Empty
                title="让有价值的对话，成为可复用的知识"
                action={
                  <div className="button-row">
                    <Button
                      appearance="primary"
                      onClick={() => setPage("settings")}
                    >
                      连接项目与知识库
                    </Button>
                    <Button
                      disabled={!!busy}
                      onClick={() =>
                        run(
                          "demo",
                          () => api("/demo", "POST", {}),
                          "已创建独立演示项目，所有示例内容均为合成数据。",
                        )
                      }
                    >
                      {busy === "demo" ? "正在创建…" : "试用合成演示数据"}
                    </Button>
                  </div>
                }
              >
                连接一个项目后，Codex
                提炼的知识会出现在审核队列。你可以查看来源、编辑内容，并确认每一次写入。
              </Empty>
            ) : (
              <>
                <div className="page-heading">
                  <div>
                    <h1>{pages.find((p) => p.id === page)?.label}</h1>
                    <p>
                      {page === "review"
                        ? "从对话中提炼，在确认后沉淀。"
                        : page === "knowledge"
                          ? "原始快照保持只读，第二层自动归纳材料，第三层抽象进入审核。"
                        : page === "history"
                          ? "追溯每次写入，按需撤销单项变更。"
                          : page === "graph"
                            ? "查看已落盘的笔记，以及 Markdown 内部链接。"
                            : page === "learning"
                              ? "用真实审核改进建议，授权始终由你控制。"
                              : "配置本地项目、知识库与可选模型。"}
                    </p>
                  </div>
                  <div className="heading-actions">
                    {project?.synthetic && (
                      <Badge appearance="outline" color="warning">
                        合成演示数据
                      </Badge>
                    )}
                    {page === "review" && (
                      <Button
                        appearance="primary"
                        icon={<DocumentAdd20Regular />}
                        onClick={() => setNewProposal(true)}
                      >
                        添加提案
                      </Button>
                    )}
                  </div>
                </div>
                {page === "review" && (
                  <>
                    <div className="queue-summary">
                      <span>
                        <strong>{pending.length}</strong> 待处理
                      </span>
                      <span>
                        <strong>
                          {
                            projectProposals.filter(
                              (p) => p.status === "deferred",
                            ).length
                          }
                        </strong>{" "}
                        已暂缓
                      </span>
                      <span>
                        <strong>
                          {
                            state.writes.filter(
                              (w) => w.project_id === projectId,
                            ).length
                          }
                        </strong>{" "}
                        写入记录
                      </span>
                      <span className="summary-note">
                        <ShieldCheckmark20Regular />{" "}
                        {mode === "AUTO_LIMITED"
                          ? "仅通过评估的授权范围自动写入"
                          : "提案不会自动写入知识库"}
                      </span>
                    </div>
                    <div className="review-layout">
                      <section className="queue-panel" aria-label="提案列表">
                        <div className="queue-tools">
                          <Input
                            contentBefore={<Search20Regular />}
                            placeholder="搜索标题、正文或来源"
                            aria-label="搜索提案"
                            value={search}
                            onChange={(_, d) => setSearch(d.value)}
                          />
                          <div className="filter-row">
                            <Select
                              aria-label="按处理状态筛选"
                              value={filter}
                              onChange={(_, d) => setFilter(d.value)}
                            >
                              <option value="pending">待处理</option>
                              <option value="deferred">已暂缓</option>
                              <option value="all">全部提案</option>
                            </Select>
                            <Select
                              aria-label="按内容类型筛选"
                              icon={<Filter20Regular />}
                              value={kind}
                              onChange={(_, d) => setKind(d.value)}
                            >
                              <option value="all">全部类型</option>
                              {Object.entries(kinds).map(([value, label]) => (
                                <option key={value} value={value}>
                                  {label}
                                </option>
                              ))}
                            </Select>
                          </div>
                        </div>
                        {visible.some(batchEligible) && (
                          <div className="selection-bar">
                            <Checkbox
                              aria-label="选择当前列表所有待处理版本"
                              checked={
                                visible.filter(batchEligible).length > 0 &&
                                visible
                                  .filter(batchEligible)
                                  .every((p) => checked[p.id] === p.revision)
                              }
                              onChange={(_, d) =>
                                setChecked((prev) => {
                                  const next = { ...prev };
                                  visible.filter(batchEligible).forEach((p) => {
                                    if (d.checked) next[p.id] = p.revision;
                                    else delete next[p.id];
                                  });
                                  return next;
                                })
                              }
                            />
                            <span>
                              {selectedCount
                                ? `已选 ${selectedCount} 项`
                                : `${visible.length} 项提案`}
                            </span>
                            {selectedCount > 0 && (
                              <Button
                                size="small"
                                appearance="subtle"
                                onClick={() => setChecked({})}
                              >
                                清空
                              </Button>
                            )}
                          </div>
                        )}
                        <div className="proposal-list">
                          {visible.map((p) => (
                            <div
                              key={p.id}
                              className={`proposal-row ${selected?.id === p.id ? "selected" : ""}`}
                            >
                              {batchEligible(p) && (
                                <Checkbox
                                  aria-label={`选择 ${p.title} 版本 ${p.revision}`}
                                  checked={checked[p.id] === p.revision}
                                  onChange={(_, d) =>
                                    setChecked((prev) => {
                                      const next = { ...prev };
                                      if (d.checked) next[p.id] = p.revision;
                                      else delete next[p.id];
                                      return next;
                                    })
                                  }
                                />
                              )}
                              <button
                                className="proposal-open"
                                onClick={() => setSelectedId(p.id)}
                                aria-pressed={selected?.id === p.id}
                              >
                                <div className="proposal-meta">
                                  <span className="kind-label">
                                    {kinds[p.kind]}
                                  </span>
                                  <span>{date(p.created_at)}</span>
                                </div>
                                <h3>{p.title}</h3>
                                <p>{p.rationale || p.content}</p>
                                <div className="proposal-bottom">
                                  <span>
                                    <Document20Regular />
                                    {p.recommended_action === "update"
                                      ? "更新笔记"
                                      : "新建笔记"}
                                  </span>
                                  <span>
                                    {p.status === "deferred"
                                      ? "已暂缓"
                                      : isPending(p)
                                        ? `版本 ${p.revision}`
                                        : statuses[p.status] || p.status}
                                  </span>
                                </div>
                              </button>
                            </div>
                          ))}
                          {visible.length === 0 && (
                            <div className="list-empty">
                              <Checkmark20Regular />
                              <strong>
                                {search ? "没有匹配的提案" : "当前队列已清空"}
                              </strong>
                              <span>
                                {search
                                  ? "尝试其他关键词或筛选条件。"
                                  : "新的会话提案会保留在这里，等待你审核。"}
                              </span>
                            </div>
                          )}
                        </div>
                        {selectedCount > 0 && (
                          <div className="batch-bar">
                            <Button
                              appearance="primary"
                              disabled={!!busy}
                              onClick={startBatch}
                            >
                              预览选中 {selectedCount} 项
                            </Button>
                            <span>逐项核对后批量确认</span>
                          </div>
                        )}
                      </section>
                      <section className="detail-panel" aria-label="提案详情">
                        {selected ? (
                          <ReviewDetail
                            key={`${selected.id}:${selected.revision}`}
                            proposal={selected}
                            busy={busy}
                            onRefresh={reload}
                            onReview={async (review) => {
                              await api(
                                `/proposals/${selected.id}/review`,
                                "POST",
                                review,
                              );
                              setChecked((prev) => {
                                const next = { ...prev };
                                delete next[selected.id];
                                return next;
                              });
                              await reload();
                              setNotice(
                                review.action === "defer"
                                  ? "已暂缓；不会记录为接受或拒绝样本。"
                                  : review.action === "discard"
                                    ? "已丢弃并记录审核反馈。"
                                    : "已按确认的版本写入知识库。",
                              );
                            }}
                          />
                        ) : (
                          <Empty title="选择一项提案开始审核">
                            来源、正文与差异会显示在这里。只有确认后的内容才会进入知识库。
                          </Empty>
                        )}
                      </section>
                    </div>
                  </>
                )}
                {page === "history" && (
                  <History
                    state={state}
                    projectId={projectId}
                    run={run}
                    busy={busy}
                  />
                )}
                {page === 'knowledge' && project && (
                  <KnowledgePage key={project.id} project={project} onReview={() => { void reload(); setPage('review'); }} />
                )}
                {page === "graph" && project && (
                  <NotesGraph key={project.id} project={project} />
                )}
                {page === "learning" && project && (
                  <Learning
                    key={project.id}
                    state={state}
                    project={project}
                    run={run}
                    busy={busy}
                  />
                )}
                {page === "settings" && (
                  <SettingsPage
                    state={state}
                    run={run}
                    busy={busy}
                    onProject={(id) => {
                      changeProject(id);
                      setPage("review");
                    }}
                  />
                )}
              </>
            )}
          </main>
          <footer className="workspace-footer">
            <span>本地优先 · Markdown 知识库</span>
            <span>
              {project
                ? `${project.name} / ${project.writable_dirs.join("、")}`
                : "尚未连接知识库"}
            </span>
          </footer>
        </div>
      </div>
      <Dialog
        open={batch !== null}
        onOpenChange={(_, d) => {
          if (!busy) setBatch(d.open ? batch : null);
        }}
      >
        <DialogSurface className="batch-dialog">
          <DialogBody>
            <DialogTitle>确认批量写入</DialogTitle>
            <DialogContent>
              <p className="dialog-intro">
                以下是已选择的精确提案版本与完整差异。每项单独写入；若中途失败，会保留已完成结果并停止后续项目。
              </p>
              {batchError && (
                <div role="alert" className="message error">
                  {batchError}
                </div>
              )}
              {batch?.map((item) => (
                <section className="batch-item" key={item.proposal.id}>
                  <h3>
                    {item.proposal.title}
                    <Badge appearance="outline">
                      版本 {item.review.revision}
                    </Badge>
                  </h3>
                  <p className="path">
                    {actions[item.review.action]} · {item.preview.target}
                  </p>
                  <Diff preview={item.preview} />
                </section>
              ))}
            </DialogContent>
            <DialogActions>
              <Button disabled={!!busy} onClick={() => setBatch(null)}>
                返回审核
              </Button>
              <Button
                appearance="primary"
                disabled={!!busy || !!batchError || !batch?.length}
                onClick={confirmBatch}
              >
                {busy === "batch-confirm"
                  ? "正在逐项写入…"
                  : `确认写入 ${batch?.length || 0} 项`}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
      {newProposal && project && (
        <ProposalForm
          project={project}
          onClose={() => setNewProposal(false)}
          onDone={async () => {
            await reload();
            setNewProposal(false);
            setNotice("已添加提案，等待人工审核。");
          }}
        />
      )}
    </FluentProvider>
  );
}
export default App;
