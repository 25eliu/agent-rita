/**
 * BridgeSessionManager — multi-session WebSocket bridge between MCP tool
 * handlers and connected OpenBB Workspace browser tabs.
 *
 * Each session = one browser tab (auth'd via session_id + token UUID pair).
 * Each session owns its own pending-command map. Tool handlers call
 * `executeCommand(sessionId, command)` and await a `WorkspaceCommandResult`
 * that the browser sends back over the same socket.
 *
 * Single-threaded JS event loop = no async lock needed (Pydantic side uses
 * asyncio.Lock to guard mutations between awaits; we get this for free).
 */

import { getLogger } from "../lib/logger";
import {
  BrowserMessageSchema,
  type BrowserSession,
  type BrowserSessionContext,
} from "./types";
import {
  WorkspaceCommandResultSchema,
  WorkspaceSnapshotSchema,
  type WorkspaceCommand,
  type WorkspaceCommandResult,
} from "./wire";

const logger = getLogger(["mcp", "bridge", "state"]);

export interface BridgeSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export class BrowserUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserUnavailableError";
  }
}

interface PendingCommand {
  commandName: string;
  resolve: (result: WorkspaceCommandResult) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

interface ConnectedBrowser {
  session: BrowserSession;
  socket: BridgeSocket | null;
  pending: Map<string, PendingCommand>;
}

export interface BridgeSessionManager {
  startSession(req: {
    client_name?: string;
    current_dashboard_id?: string | null;
    current_tab_id?: string | null;
  }): { session: BrowserSession; websocket_url: string };

  connectBrowser(args: {
    sessionId: string;
    token: string;
    socket: BridgeSocket;
  }): BrowserSession;

  disconnectBrowser(args: { sessionId: string }): void;

  handleBrowserMessage(sessionId: string, raw: unknown): void;

  executeCommand(
    sessionId: string,
    command: WorkspaceCommand,
  ): Promise<WorkspaceCommandResult>;

  getSessionContext(sessionId: string): BrowserSessionContext | null;

  /** Returns first connected session id, or null. PoC default for tools that
   * don't (yet) carry an explicit session id in their decoration. */
  getFirstConnectedSessionId(): string | null;

  health(): {
    ok: true;
    sessions: number;
    connected: number;
    pending_total: number;
  };
}

export function makeBridgeSessionManager(opts: {
  baseUrl: string;
  websocketPath: string;
  commandTimeoutMs: number;
}): BridgeSessionManager {
  const browsers = new Map<string, ConnectedBrowser>();

  const failPending = (
    browser: ConnectedBrowser,
    code: "unavailable" | "invalid_request" | "timeout" | "command_failed",
    message: string,
    details: Record<string, unknown> | null = null,
  ): void => {
    for (const [requestId, pending] of browser.pending) {
      browser.pending.delete(requestId);
      clearTimeout(pending.timeoutId);
      pending.resolve({
        ok: false,
        command: pending.commandName,
        request_id: requestId,
        message,
        data: null,
        error: { code, message, retryable: code === "timeout", details },
      });
    }
  };

  const newRequestId = (): string =>
    `cmd_${crypto.randomUUID().replace(/-/g, "")}`;

  /**
   * Mirror workspace_mcp/state.py:274-322 — `_normalize_result` +
   * `_inject_session_context`. Two responsibilities:
   *
   *   1. For `get_workspace_snapshot` ok=true results, validate `data` against
   *      WorkspaceSnapshotSchema. On failure, replace with an `invalid_request`
   *      error result so callers see schema-driven feedback instead of garbage.
   *   2. For every ok=true result with object `data`, merge a `session_context`
   *      sub-object (current_dashboard_uuid, current_tab_id) so the agent
   *      doesn't have to round-trip another snapshot before its next write.
   */
  const normalizeResult = (
    browser: ConnectedBrowser,
    commandName: string,
    result: WorkspaceCommandResult,
  ): WorkspaceCommandResult => {
    let normalized = result;

    if (commandName === "get_workspace_snapshot" && normalized.ok) {
      const parsed = WorkspaceSnapshotSchema.safeParse(normalized.data);
      if (!parsed.success) {
        const message =
          "Browser returned an invalid workspace snapshot payload.";
        return {
          ok: false,
          command: commandName,
          request_id: normalized.request_id ?? null,
          message,
          data: null,
          error: {
            code: "invalid_request",
            message,
            retryable: false,
            details: { errors: parsed.error.issues },
          },
        };
      }
    }

    if (
      !normalized.ok ||
      typeof normalized.data !== "object" ||
      normalized.data === null ||
      Array.isArray(normalized.data)
    ) {
      return normalized;
    }

    const data = normalized.data as Record<string, unknown>;
    if ("session_context" in data) return normalized;
    return {
      ...normalized,
      data: {
        ...data,
        session_context: {
          current_dashboard_uuid:
            browser.session.current_dashboard_id ?? null,
          current_tab_id: browser.session.current_tab_id ?? null,
        },
      },
    };
  };

  return {
    startSession(req) {
      const session: BrowserSession = {
        session_id: crypto.randomUUID(),
        token: crypto.randomUUID(),
        client_name: req.client_name ?? "workspace-ui",
        current_dashboard_id: req.current_dashboard_id ?? null,
        current_tab_id: req.current_tab_id ?? null,
      };
      browsers.set(session.session_id, {
        session,
        socket: null,
        pending: new Map(),
      });
      const wsBase = opts.baseUrl.replace(/^http/, "ws");
      const websocket_url =
        `${wsBase}${opts.websocketPath}?session_id=${session.session_id}&token=${session.token}`;
      logger.info("Bridge session started", {
        sessionId: session.session_id,
        clientName: session.client_name,
        totalSessions: browsers.size,
      });
      return { session, websocket_url };
    },

    connectBrowser({ sessionId, token, socket }) {
      const browser = browsers.get(sessionId);
      if (!browser) {
        throw new BrowserUnavailableError(
          "No bridge session has been started for this id.",
        );
      }
      if (browser.session.token !== token) {
        throw new BrowserUnavailableError(
          "Invalid bridge session credentials.",
        );
      }
      browser.socket = socket;
      logger.info("Browser connected", { sessionId });
      return browser.session;
    },

    disconnectBrowser({ sessionId }) {
      const browser = browsers.get(sessionId);
      if (!browser) return;
      browser.socket = null;
      failPending(
        browser,
        "unavailable",
        "Workspace browser disconnected before the command completed.",
      );
      browsers.delete(sessionId);
      logger.info("Browser disconnected", {
        sessionId,
        remainingSessions: browsers.size,
      });
    },

    handleBrowserMessage(sessionId, raw) {
      const browser = browsers.get(sessionId);
      if (!browser) {
        logger.warn("Message for unknown session", { sessionId });
        return;
      }
      const parsed = BrowserMessageSchema.safeParse(raw);
      if (!parsed.success) {
        // Mirror workspace_mcp/state.py:130-148: an invalid wire frame fails
        // ALL pending commands with `invalid_request`. Socket stays open;
        // callers see schema feedback instead of hanging until timeout.
        logger.warn("Invalid browser message — failing all pending", {
          sessionId,
          pendingCount: browser.pending.size,
          issues: parsed.error.issues.slice(0, 3),
        });
        failPending(
          browser,
          "invalid_request",
          "Workspace browser sent an invalid websocket payload. " +
            "This can happen when the connected browser build does not " +
            "implement the requested bridge command.",
          { errors: parsed.error.issues },
        );
        return;
      }
      const msg = parsed.data;
      switch (msg.type) {
        case "ping":
          return;

        case "session_context_changed":
          browser.session.current_dashboard_id =
            msg.session.current_dashboard_id ?? null;
          browser.session.current_tab_id = msg.session.current_tab_id ?? null;
          return;

        case "command_result": {
          const resultParsed = WorkspaceCommandResultSchema.safeParse(
            msg.result,
          );
          if (!resultParsed.success) {
            // Same semantics as outer parse failure — Python's discriminated
            // union catches malformed result bodies in the outer parse, so we
            // mirror by failing all pending here.
            logger.warn(
              "Invalid command_result body — failing all pending",
              {
                sessionId,
                pendingCount: browser.pending.size,
                issues: resultParsed.error.issues.slice(0, 3),
              },
            );
            failPending(
              browser,
              "invalid_request",
              "Workspace browser sent an invalid command_result body.",
              { errors: resultParsed.error.issues },
            );
            return;
          }
          const result = resultParsed.data;
          if (!result.request_id) {
            logger.warn("command_result missing request_id", { sessionId });
            return;
          }
          const pending = browser.pending.get(result.request_id);
          if (!pending) {
            logger.warn("command_result for unknown/expired request", {
              sessionId,
              requestId: result.request_id,
            });
            return;
          }
          browser.pending.delete(result.request_id);
          clearTimeout(pending.timeoutId);
          pending.resolve(normalizeResult(browser, pending.commandName, result));
          return;
        }
      }
    },

    async executeCommand(sessionId, command) {
      const browser = browsers.get(sessionId);
      if (!browser) {
        throw new BrowserUnavailableError(
          `No bridge session: ${sessionId}.`,
        );
      }
      if (!browser.socket) {
        throw new BrowserUnavailableError(
          "Workspace browser is not connected to this session.",
        );
      }

      const requestId = command.request_id ?? newRequestId();
      const stamped = { ...command, request_id: requestId };

      // Pending resolutions go through `normalizeResult` from
      // `handleBrowserMessage`; timeout/send-failure paths bypass that since
      // they are already structured `error` results that don't need
      // session_context injection.
      return new Promise<WorkspaceCommandResult>((resolve) => {
        const timeoutId = setTimeout(() => {
          if (!browser.pending.has(requestId)) return;
          browser.pending.delete(requestId);
          resolve({
            ok: false,
            command: command.command,
            request_id: requestId,
            message: "Workspace command timed out waiting for the browser.",
            data: null,
            error: {
              code: "timeout",
              message: `No response within ${opts.commandTimeoutMs}ms.`,
              retryable: true,
              details: null,
            },
          });
        }, opts.commandTimeoutMs);

        browser.pending.set(requestId, {
          commandName: command.command,
          resolve,
          timeoutId,
        });

        try {
          browser.socket!.send(
            JSON.stringify({ type: "command_request", command: stamped }),
          );
        } catch (err) {
          browser.pending.delete(requestId);
          clearTimeout(timeoutId);
          const msg = err instanceof Error ? err.message : String(err);
          resolve({
            ok: false,
            command: command.command,
            request_id: requestId,
            message: `Failed to send command to browser: ${msg}`,
            data: null,
            error: {
              code: "unavailable",
              message: msg,
              retryable: true,
              details: null,
            },
          });
        }
      });
    },

    getSessionContext(sessionId) {
      const browser = browsers.get(sessionId);
      if (!browser) return null;
      return {
        current_dashboard_id: browser.session.current_dashboard_id ?? null,
        current_tab_id: browser.session.current_tab_id ?? null,
      };
    },

    getFirstConnectedSessionId() {
      for (const [sessionId, browser] of browsers) {
        if (browser.socket) return sessionId;
      }
      return null;
    },

    health() {
      let connected = 0;
      let pendingTotal = 0;
      for (const browser of browsers.values()) {
        if (browser.socket) connected++;
        pendingTotal += browser.pending.size;
      }
      return {
        ok: true,
        sessions: browsers.size,
        connected,
        pending_total: pendingTotal,
      };
    },
  };
}
