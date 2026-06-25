/**
 * Bridge HTTP + WebSocket routes for the rita MCP server.
 *
 * - POST /bridge/session/start: mints session_id + token, returns WS URL
 * - GET  /bridge/ws:            WebSocket upgrade for the OpenBB Workspace tab
 * - GET  /bridge/health:        liveness + counts (sessions, pending commands)
 *
 * StreamableHTTPTransport handles `/mcp` separately and does not consume
 * `/bridge/ws` upgrade frames — paths are independent in Hono's router.
 */

import type { Hono } from "hono";
import { createBunWebSocket } from "hono/bun";
import type { ServerWebSocket } from "bun";

import { getLogger } from "../lib/logger";
import {
  BrowserSessionStartRequestSchema,
  type BrowserSessionStartResponse,
} from "./types";
import {
  BrowserUnavailableError,
  type BridgeSessionManager,
  type BridgeSocket,
} from "./state";

const logger = getLogger(["mcp", "bridge", "routes"]);

export interface MountBridgeResult {
  /** Bun.serve websocket handler — must be included in the default export. */
  websocket: ReturnType<typeof createBunWebSocket<ServerWebSocket>>["websocket"];
}

export function mountBridgeRoutes(
  app: Hono,
  manager: BridgeSessionManager,
): MountBridgeResult {
  const { upgradeWebSocket, websocket } = createBunWebSocket<ServerWebSocket>();

  app.post("/bridge/session/start", async (c) => {
    let body: unknown = {};
    try {
      body = await c.req.json();
    } catch {
      // Empty body OK — schema fills in defaults.
    }
    const parsed = BrowserSessionStartRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: "invalid_request",
            message: "Invalid session start request.",
            details: { issues: parsed.error.issues.slice(0, 3) },
          },
        },
        400,
      );
    }
    const out: BrowserSessionStartResponse = manager.startSession(parsed.data);
    return c.json(out);
  });

  app.get(
    "/bridge/ws",
    upgradeWebSocket((c) => {
      const sessionId = c.req.query("session_id") ?? "";
      const token = c.req.query("token") ?? "";

      return {
        onOpen(_evt, ws) {
          const socket: BridgeSocket = {
            send: (data) => ws.send(data),
            close: (code, reason) => ws.close(code, reason),
          };
          try {
            const session = manager.connectBrowser({
              sessionId,
              token,
              socket,
            });
            ws.send(
              JSON.stringify({ type: "session_ready", session }),
            );
          } catch (err) {
            const msg =
              err instanceof BrowserUnavailableError
                ? err.message
                : "Bridge connection rejected.";
            ws.send(
              JSON.stringify({
                type: "error",
                error: {
                  code: "unauthorized",
                  message: msg,
                  retryable: false,
                },
              }),
            );
            ws.close(1008, "unauthorized");
          }
        },

        onMessage(evt) {
          const text =
            typeof evt.data === "string"
              ? evt.data
              : evt.data instanceof ArrayBuffer
                ? new TextDecoder().decode(evt.data)
                : String(evt.data);
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch {
            logger.warn("Bridge received non-JSON message", {
              sessionId,
              preview: text.slice(0, 120),
            });
            return;
          }
          manager.handleBrowserMessage(sessionId, parsed);
        },

        onClose() {
          manager.disconnectBrowser({ sessionId });
        },

        onError(evt) {
          logger.error("Bridge WebSocket error", {
            sessionId,
            error: String(evt),
          });
          manager.disconnectBrowser({ sessionId });
        },
      };
    }),
  );

  app.get("/bridge/health", (c) => c.json(manager.health()));

  return { websocket };
}
