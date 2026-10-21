import { useState } from "react";
import type { ReactNode } from "react";
import { Tab, TabList } from "./ui";
import { BookOpen24Regular } from "./icons";
import type { Preview } from "./types";
export function Empty({
  icon = <BookOpen24Regular />,
  title,
  children,
  action,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      <h2>{title}</h2>
      <p>{children}</p>
      {action}
    </div>
  );
}
export function Diff({
  preview,
}: {
  preview: Pick<Preview, "before" | "after" | "diff">;
}) {
  const [mode, setMode] = useState("diff");
  return (
    <div className="diff">
      <div className="diff-toolbar">
        <TabList
          size="small"
          selectedValue={mode}
          onTabSelect={(_, d) => setMode(String(d.value))}
        >
          <Tab value="diff">变更差异</Tab>
          <Tab value="after">写入后全文</Tab>
          <Tab value="before">原始内容</Tab>
        </TabList>
        <span className="subtle">Markdown</span>
      </div>
      {mode === "diff" ? (
        <pre className="diff-code">
          {preview.diff ? (
            preview.diff.split("\n").map((line, i) => (
              <span
                key={i}
                className={
                  line.startsWith("+") && !line.startsWith("+++")
                    ? "diff-add"
                    : line.startsWith("-") && !line.startsWith("---")
                      ? "diff-remove"
                      : line.startsWith("@@")
                        ? "diff-range"
                        : ""
                }
              >
                {line || " "}
                <br />
              </span>
            ))
          ) : (
            <span className="subtle">没有内容差异</span>
          )}
        </pre>
      ) : (
        <pre className="diff-code">
          {(mode === "before" ? preview.before : preview.after) || "（空文件）"}
        </pre>
      )}
    </div>
  );
}
