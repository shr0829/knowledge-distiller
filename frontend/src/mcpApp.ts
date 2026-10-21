import { App } from "@modelcontextprotocol/ext-apps";

const app = new App({ name: "知序", version: "0.2.0" }, {});
let connected: Promise<void> | undefined;

export async function requestFromSidebar(path: string, method: string, body?: unknown) {
  connected ??= app.connect(undefined, { timeout: 15000 }).catch((error) => {
    connected = undefined;
    throw error;
  });
  await connected;
  const result = await app.callServerTool({
    name: method === "GET" ? "library_ui_read" : "library_ui_request",
    arguments: method === "GET" ? { path } : { path, method, body: body ?? null },
  });
  if (result.isError) {
    const detail = result.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join(" ").slice(0, 400);
    if (/unknown tool|unsupported sidebar operation|not found/i.test(detail))
      throw new Error("知序后台版本与面板不一致。请重新连接知序插件，再关闭并重新打开面板。");
    throw new Error(detail
      ? `知序后台操作失败：${detail}`
      : "知序后台操作失败。请重新连接知序插件后重试。");
  }
  if (result.structuredContent) return result.structuredContent as { status: number; body: unknown };
  const content = result.content.find((item) => item.type === "text");
  if (!content || content.type !== "text") throw new Error("知序后台未返回有效数据。");
  return JSON.parse(content.text) as { status: number; body: unknown };
}
