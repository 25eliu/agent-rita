/**
 * Module-scope BridgeSessionManager. Process-wide singleton because bridge
 * state is process-scoped, not request-scoped (long-lived WS connections,
 * pending command map). Workspace tool handlers import this directly.
 */

import { makeBridgeSessionManager } from "./state";

const PORT = Number(process.env.MCP_PORT ?? 8787);
const BASE_URL =
  process.env.MCP_PUBLIC_BASE_URL ?? `http://127.0.0.1:${PORT}`;
const COMMAND_TIMEOUT_MS = Number(
  process.env.MCP_BRIDGE_COMMAND_TIMEOUT_MS ?? 15_000,
);

export const bridgeManager = makeBridgeSessionManager({
  baseUrl: BASE_URL,
  websocketPath: "/bridge/ws",
  commandTimeoutMs: COMMAND_TIMEOUT_MS,
});
