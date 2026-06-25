const OPAQUE_SERVER_ID_PATTERN = /^\d+$/;
const NON_SERVER_TOOL_PREFIXES = new Set([
  "call",
  "cite",
  "create",
  "delete",
  "execute",
  "fetch",
  "get",
  "list",
  "manage",
  "query",
  "read",
  "search",
  "update",
  "web",
]);

function clean(value: string | undefined): string {
  return value?.trim() ?? "";
}

function isOpaqueServerId(serverId: string): boolean {
  return !serverId || serverId === "unknown" || OPAQUE_SERVER_ID_PATTERN.test(serverId);
}

function splitInferredProvider(toolName: string): { provider: string; tool: string } | undefined {
  const idx = toolName.indexOf("_");
  if (idx <= 0 || idx >= toolName.length - 1) return undefined;
  const provider = toolName.slice(0, idx);
  if (NON_SERVER_TOOL_PREFIXES.has(provider.toLowerCase())) return undefined;
  if (!/[A-Z]/.test(provider)) return undefined;
  return { provider, tool: toolName.slice(idx + 1) };
}

export function mcpDisplayName(serverId: string | undefined, toolName: string | undefined): string {
  const server = clean(serverId);
  const tool = clean(toolName) || "unknown";

  if (!isOpaqueServerId(server)) {
    const prefixed = tool.toLowerCase().startsWith(`${server.toLowerCase()}_`);
    const displayTool = prefixed ? tool.slice(server.length + 1) : tool;
    return displayTool ? `${server} - ${displayTool}` : server;
  }

  const inferred = splitInferredProvider(tool);
  if (inferred) return `${inferred.provider} - ${inferred.tool}`;
  return tool;
}
