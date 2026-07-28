/**
 * Lazy singleton MCP client for Tako's hosted endpoint.
 *
 * Keyless connections land on Tako's anonymous free tier (tako_search,
 * tako_answer, tako_available_data at 10 req/min per IP). TAKO_API_TOKEN
 * sends a bearer header and unlocks the account's own limits plus
 * tako_contents. This is the companion server's outbound dependency, the
 * same class as Tavily/Daytona/OpenAI calls — the agent itself still never
 * opens MCP connections.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getLogger } from "../../../lib/logger";

const logger = getLogger(["mcp", "tako"]);

const DEFAULT_TAKO_MCP_URL = "https://mcp.tako.com/mcp";
const TAKO_CALL_TIMEOUT_MS = 15_000;

export function isTakoEnabled(): boolean {
  return process.env.TAKO_ENABLED !== "false";
}

export function isTakoAuthed(): boolean {
  return !!process.env.TAKO_API_TOKEN;
}

export function withFreeTierHint(text: string): string {
  if (isTakoAuthed()) return text;
  return `${text}\n(Tako is running on the anonymous free tier, rate-limited to 10 requests/min. Set TAKO_API_TOKEN for higher limits and the full toolset.)`;
}

export interface TakoCallResult {
  text: string;
  structured: unknown;
  isError: boolean;
}

let clientPromise: Promise<Client> | null = null;

async function connect(): Promise<Client> {
  const url = process.env.TAKO_MCP_URL ?? DEFAULT_TAKO_MCP_URL;
  const token = process.env.TAKO_API_TOKEN;
  const transport = new StreamableHTTPClientTransport(
    new URL(url),
    token ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } } : undefined,
  );
  const client = new Client({ name: "agent-rita-companion", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

function getClient(): Promise<Client> {
  if (!clientPromise) {
    clientPromise = connect().catch((err: unknown) => {
      clientPromise = null;
      throw err;
    });
  }
  return clientPromise;
}

export function resetTakoClientForTests(): void {
  clientPromise = null;
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (
      typeof item === "object" &&
      item !== null &&
      (item as { type?: unknown }).type === "text" &&
      typeof (item as { text?: unknown }).text === "string"
    ) {
      parts.push((item as { text: string }).text);
    }
  }
  return parts.join("\n");
}

/** Call one upstream Tako tool. Reconnects once on failure, then rethrows. */
export async function callTakoTool(
  name: string,
  args: Record<string, unknown>,
): Promise<TakoCallResult> {
  const attempt = async (): Promise<TakoCallResult> => {
    const client = await getClient();
    const result = await client.callTool({ name, arguments: args }, undefined, {
      timeout: TAKO_CALL_TIMEOUT_MS,
    });
    return {
      text: textOf(result.content),
      structured: result.structuredContent,
      isError: result.isError === true,
    };
  };
  try {
    return await attempt();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`Tako ${name} call failed, reconnecting once: ${msg}`);
    clientPromise = null;
    return attempt();
  }
}
