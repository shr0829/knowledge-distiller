import type { Action, Kind, Proposal } from "./types";
export const kinds: Record<Kind, string> = {
  knowledge: "知识",
  decision: "决策",
  experience: "经验",
  preference: "偏好",
  task: "待办",
  hypothesis: "待验证",
};
export const actions: Record<Action, string> = {
  save: "保存为新笔记",
  update: "更新已有笔记",
  discard: "丢弃",
  defer: "暂缓",
};
export const statuses: Record<string, string> = {
  pending: "待审核",
  deferred: "已暂缓",
  saved: "已保存",
  updated: "已更新",
  accepted: "已确认",
  discarded: "已丢弃",
  applied: "已写入",
  completed: "已完成",
  success: "成功",
  undone: "已撤销",
  reverted: "已撤销",
  failed: "失败",
  active: "使用中",
  candidate: "候选",
  shadow: "影子验证",
  draft: "草案",
  rolled_back: "已回退",
  blocked: "未达门槛",
  conflict: "存在冲突",
  undo_conflict: "撤销冲突",
  prepared: "写入准备中",
  aborted: "已停止",
};
export const date = (value: string) =>
  value
    ? new Intl.DateTimeFormat("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(new Date(value))
    : "—";
export const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "操作未完成，请重试。";
export const split = (value: string) =>
  value
    .split(/[,，\n]/)
    .map((v) => v.trim())
    .filter(Boolean);
export const textValue = (value: unknown) =>
  typeof value === "string" ? value : JSON.stringify(value, null, 2);
export const isPending = (p: Proposal) =>
  ["pending", "deferred", "conflict"].includes(p.status);
