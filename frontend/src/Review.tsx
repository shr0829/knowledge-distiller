import { useState } from "react";
import {
  Badge,
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  Input,
  Select,
  Tab,
  TabList,
  Textarea,
} from "@fluentui/react-components";
import {
  Checkmark20Regular,
  Clock20Regular,
  Code20Regular,
  Dismiss20Regular,
  Document20Regular,
  Edit20Regular,
  Folder20Regular,
  Info20Regular,
} from "@fluentui/react-icons";
import { api } from "./api";
import { EvidencePanel } from "./Evidence";
import { Diff, Empty } from "./shared";
import { date, errorText, isPending, kinds, split, statuses } from "./utils";
import type { Action, Kind, Preview, Project, Proposal, Review } from "./types";

export function ReviewDetail({
  proposal: p,
  onReview,
  onRefresh,
  busy: globalBusy,
}: {
  proposal: Proposal;
  onReview: (review: Review) => Promise<void>;
  onRefresh: () => Promise<void>;
  busy: string;
}) {
  const [title, setTitle] = useState(p.title),
    [content, setContent] = useState(p.content),
    [target, setTarget] = useState(p.target),
    [links, setLinks] = useState(p.links.join(", ")),
    [tags, setTags] = useState(p.tags.join(", ")),
    [reason, setReason] = useState(""),
    [action, setAction] = useState<Action>(
      p.recommended_action === "update" ? "update" : "save",
    ),
    [tab, setTab] = useState("content"),
    [preview, setPreview] = useState<Preview | null>(null),
    [previewReview, setPreviewReview] = useState<Review | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const editable = isPending(p),
    changed =
      title !== p.title ||
      content !== p.content ||
      target !== p.target ||
      links !== p.links.join(", ") ||
      tags !== p.tags.join(", ");
  const invalidate = () => {
    setPreview(null);
    setPreviewReview(null);
  };
  const applySuggestion = () => {
    const suggested = p.policy_prediction;
    if (!suggested) return;
    if (suggested.title !== undefined) setTitle(suggested.title);
    if (suggested.content !== undefined) setContent(suggested.content);
    if (suggested.target !== undefined) setTarget(suggested.target);
    if (suggested.links !== undefined) setLinks(suggested.links.join(", "));
    if (suggested.tags !== undefined) setTags(suggested.tags.join(", "));
    if (suggested.action === "save" || suggested.action === "update")
      setAction(suggested.action);
    invalidate();
    setTab("content");
  };
  const review = (): Review => ({
    revision: p.revision,
    action,
    title,
    content,
    target,
    links: split(links),
    tags: split(tags),
    reason,
  });
  const prepare = async () => {
    setBusy(true);
    setError("");
    try {
      const payload = review();
      setPreview(
        await api<Preview>(`/proposals/${p.id}/preview`, "POST", payload),
      );
      setPreviewReview(payload);
      setTab("diff");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const submit = async (nextAction?: Action) => {
    setBusy(true);
    setError("");
    try {
      await onReview(
        nextAction
          ? { revision: p.revision, action: nextAction, reason }
          : { ...previewReview!, preview_token: preview!.preview_token },
      );
      invalidate();
    } catch (e) {
      setError(errorText(e));
      invalidate();
    } finally {
      setBusy(false);
    }
  };
  const refresh = async () => {
    setBusy(true);
    setError("");
    try {
      await api(`/proposals/${p.id}/refresh`, "POST", { revision: p.revision });
      await onRefresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="detail-header">
        <div className="detail-heading-row">
          <div className="button-row">
            <Badge appearance="tint" color="brand">
              {kinds[p.kind]}
            </Badge>
            <span className="subtle">版本 {p.revision}</span>
            {changed && <span className="edited-label">已编辑</span>}
          </div>
          <span className="subtle">{statuses[p.status] || p.status}</span>
        </div>
        <h2>{p.title}</h2>
        <p>{p.rationale || "请检查来源与正文，再决定是否沉淀到知识库。"}</p>
        {editable && p.policy_prediction && (
          <div className="policy-suggestion">
            <div>
              <strong>策略建议</strong>
              <span>
                {p.policy_prediction.reason ||
                  "已有策略给出了候选编辑，可载入正文后重新审核。"}
              </span>
            </div>
            <Button size="small" disabled={busy} onClick={applySuggestion}>
              应用建议到草稿
            </Button>
          </div>
        )}
        {p.risk_flags?.length > 0 && (
          <div className="risk-line">
            <Info20Regular />
            <span>
              {p.risk_flags
                .map((flag) =>
                  flag === "uncertain_evidence"
                    ? "待验证：来源结论尚不确定"
                    : flag === "sensitive_content"
                      ? "来源可能含敏感内容"
                      : flag,
                )
                .join(" · ")}
            </span>
          </div>
        )}
      </div>
      <div className="detail-tabs">
        <TabList
          selectedValue={tab}
          onTabSelect={(_, d) => setTab(String(d.value))}
        >
          <Tab value="content" icon={<Edit20Regular />}>
            提案正文
          </Tab>
          <Tab value="source" icon={<Code20Regular />}>
            来源依据
          </Tab>
          <Tab value="diff" icon={<Document20Regular />}>
            写入预览
          </Tab>
        </TabList>
      </div>
      <div className="detail-scroll">
        {error && (
          <div role="alert" className="message error">
            <Info20Regular />
            <span>{error}</span>
          </div>
        )}
        {(p.status === "conflict" || error) && editable && (
          <div className="conflict-refresh">
            <span>若目标笔记已变化，请读取当前版本后重新审核。</span>
            <Button size="small" disabled={busy} onClick={refresh}>
              刷新目标版本
            </Button>
          </div>
        )}
        {tab === "content" && (
          <div className="proposal-editor">
            <Field label="笔记标题">
              <Input
                value={title}
                disabled={!editable}
                onChange={(_, d) => {
                  setTitle(d.value);
                  invalidate();
                }}
              />
            </Field>
            <Field
              label="目标笔记"
              hint="相对于知识库的 Markdown 路径；修改后需要重新预览。"
            >
              <Input
                contentBefore={<Folder20Regular />}
                value={target}
                disabled={!editable}
                onChange={(_, d) => {
                  setTarget(d.value);
                  invalidate();
                }}
              />
            </Field>
            <Field
              label="正文"
              hint="可以直接编辑 Markdown。标题、标签与关联链接会在写入预览中展示。"
            >
              <Textarea
                className="content-editor"
                resize="vertical"
                rows={12}
                value={content}
                disabled={!editable}
                onChange={(_, d) => {
                  setContent(d.value);
                  invalidate();
                }}
              />
            </Field>
            <div className="field-pair">
              <Field label="标签" hint="多个标签以逗号分隔">
                <Input
                  value={tags}
                  disabled={!editable}
                  onChange={(_, d) => {
                    setTags(d.value);
                    invalidate();
                  }}
                  placeholder="例如：方法, 决策"
                />
              </Field>
              <Field label="关联笔记" hint="填写已有笔记路径，多个以逗号分隔">
                <Input
                  value={links}
                  disabled={!editable}
                  onChange={(_, d) => {
                    setLinks(d.value);
                    invalidate();
                  }}
                  placeholder="例如：Library/项目概览.md"
                />
              </Field>
            </div>
          </div>
        )}
        {tab === "source" && (
          <div className="source-content">
            <div className="source-info">
              <h3>会话来源</h3>
              <dl>
                <div>
                  <dt>会话标识</dt>
                  <dd className="path">{p.session_id}</dd>
                </div>
                <div>
                  <dt>提案时间</dt>
                  <dd>{date(p.created_at)}</dd>
                </div>
                <div>
                  <dt>提案标识</dt>
                  <dd className="path">{p.id}</dd>
                </div>
              </dl>
            </div>
            <h3>来源片段</h3>
            <pre className="source-quote">{p.source}</pre>
            <EvidencePanel key={p.id} proposalId={p.id} />
            <p className="subtle source-note">
              <Info20Regular /> 来源片段是待核实的内容，不构成写入授权。
            </p>
          </div>
        )}
        {tab === "diff" &&
          (preview ? (
            <>
              <div className="preview-target">
                <Checkmark20Regular />
                <div>
                  <strong>预览已生成 · 版本 {p.revision}</strong>
                  <span>{preview.target}</span>
                </div>
              </div>
              <Diff preview={preview} />
              <p className="preview-note">
                确认将提交当前预览对应的精确版本。任何编辑或目标文件变化都需要重新预览。
              </p>
            </>
          ) : (
            <Empty
              icon={<Document20Regular />}
              title="先预览，再确认写入"
              action={
                editable && (
                  <Button
                    appearance="primary"
                    disabled={busy || !!globalBusy}
                    onClick={prepare}
                  >
                    生成写入预览
                  </Button>
                )
              }
            >
              预览会重新读取目标笔记，显示正文、标签与关联链接的完整差异。
            </Empty>
          ))}
      </div>
      {editable && (
        <div className="review-footer">
          <Field label="审核备注（可选）">
            <Input
              placeholder="记录保留、调整或丢弃的原因"
              value={reason}
              onChange={(_, d) => {
                setReason(d.value);
                invalidate();
              }}
            />
          </Field>
          <div className="review-actions">
            <div className="button-row">
              <Button
                appearance="subtle"
                icon={<Dismiss20Regular />}
                disabled={busy || !!globalBusy}
                onClick={() => submit("discard")}
              >
                丢弃
              </Button>
              <Button
                appearance="subtle"
                icon={<Clock20Regular />}
                disabled={busy || !!globalBusy}
                onClick={() => submit("defer")}
              >
                暂缓
              </Button>
            </div>
            <div className="button-row">
              <Select
                aria-label="写入方式"
                value={action}
                disabled={busy}
                onChange={(_, d) => {
                  setAction(d.value as Action);
                  invalidate();
                }}
              >
                <option value="save">保存为新笔记</option>
                <option value="update">更新已有笔记</option>
              </Select>
              {preview ? (
                <Button
                  appearance="primary"
                  icon={<Checkmark20Regular />}
                  disabled={busy || !!globalBusy}
                  onClick={() => submit()}
                >
                  {busy ? "写入中…" : "确认写入"}
                </Button>
              ) : (
                <Button
                  appearance="primary"
                  disabled={
                    busy ||
                    !!globalBusy ||
                    !title.trim() ||
                    !content.trim() ||
                    !target.trim()
                  }
                  onClick={prepare}
                >
                  {busy ? "预览中…" : "预览变更"}
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export function ProposalForm({
  project,
  onClose,
  onDone,
}: {
  project: Project;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [title, setTitle] = useState(""),
    [content, setContent] = useState(""),
    [source, setSource] = useState(""),
    [session, setSession] = useState("manual-review"),
    [kind, setKind] = useState<Kind>("knowledge"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      await api("/proposals", "POST", {
        project_id: project.id,
        session_id: session,
        candidates: [
          {
            title,
            content,
            source,
            kind,
            tags: [],
            links: [],
            uncertain: kind === "hypothesis",
          },
        ],
      });
      await onDone();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(_, d) => {
        if (!d.open && !busy) onClose();
      }}
    >
      <DialogSurface>
        <DialogBody>
          <DialogTitle>添加待审核提案</DialogTitle>
          <DialogContent>
            <p className="dialog-intro">
              将一项有来源的知识加入「{project.name}
              」。提交后仍需预览和确认写入。
            </p>
            <div className="proposal-form">
              <Field label="标题" required>
                <Input value={title} onChange={(_, d) => setTitle(d.value)} />
              </Field>
              <div className="field-pair">
                <Field label="内容类型">
                  <Select
                    value={kind}
                    onChange={(_, d) => setKind(d.value as Kind)}
                  >
                    {Object.entries(kinds).map(([v, label]) => (
                      <option key={v} value={v}>
                        {label}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="来源会话标识" required>
                  <Input
                    value={session}
                    onChange={(_, d) => setSession(d.value)}
                  />
                </Field>
              </div>
              <Field label="提炼正文" required>
                <Textarea
                  rows={6}
                  resize="vertical"
                  value={content}
                  onChange={(_, d) => setContent(d.value)}
                />
              </Field>
              <Field label="来源原文或依据" required>
                <Textarea
                  rows={4}
                  value={source}
                  onChange={(_, d) => setSource(d.value)}
                />
              </Field>
              {error && (
                <p role="alert" className="form-error">
                  {error}
                </p>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <Button disabled={busy} onClick={onClose}>
              取消
            </Button>
            <Button
              appearance="primary"
              disabled={
                busy ||
                !title.trim() ||
                !content.trim() ||
                !source.trim() ||
                !session.trim()
              }
              onClick={submit}
            >
              {busy ? "提交中…" : "加入审核队列"}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
