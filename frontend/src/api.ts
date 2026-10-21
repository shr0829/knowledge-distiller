let token: string | undefined;
let sessionRequest: Promise<void> | undefined;
async function session() {
  if (token) return;
  if (!sessionRequest)
    sessionRequest = (async () => {
      const reviewer = new URLSearchParams(location.hash.slice(1)).get(
        "review-token",
      );
      const response = await fetch("/api/session", {
        credentials: "same-origin",
        headers: reviewer ? { "X-Library-Reviewer": reviewer } : {},
      });
      if (!response.ok)
        throw new Error(
          response.status === 403
            ? "请使用启动脚本打开审核面板；直接访问地址没有审核权限。"
            : "无法建立本地审核会话，请刷新页面重试。",
        );
      token = (await response.json()).csrf_token;
      if (reviewer)
        history.replaceState(null, "", location.pathname + location.search);
    })().finally(() => {
      sessionRequest = undefined;
    });
  return sessionRequest;
}
export async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  if (__LIBRARY_MCP_APP__) {
    const { requestFromSidebar } = await import("./mcpApp");
    const result = await requestFromSidebar(path, method, body);
    if (result.status >= 400) {
      const detail = (result.body as { detail?: unknown })?.detail;
      throw new Error(typeof detail === "string" ? detail : `操作失败（${result.status}），请检查输入后重试。`);
    }
    return result.body as T;
  }
  await session();
  const response = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(method !== "GET" ? { "X-Library-Token": token! } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 403) token = undefined;
    const detail =
      typeof result.detail === "string"
        ? result.detail
        : Array.isArray(result.detail)
          ? result.detail
              .map(
                (d: { msg: string; loc: string[] }) =>
                  `${d.loc?.slice(1).join(".")}: ${d.msg}`,
              )
              .join("；")
          : `请求失败（${response.status}），请重试。`;
    throw new Error(detail);
  }
  return result as T;
}
