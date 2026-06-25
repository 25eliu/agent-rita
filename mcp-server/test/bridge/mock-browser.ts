/**
 * Mock OpenBB Workspace browser for bridge integration tests.
 *
 * Connects to a `/bridge/session/start` + `/bridge/ws` endpoint, sends
 * configurable canned `command_result` payloads in response to incoming
 * `command_request` events, and exposes the WS frames it received for
 * assertion.
 *
 * Wire shapes mirror workspace_mcp/workspace_mcp/models.py byte-for-byte.
 */

export interface IncomingCommand {
  command: string;
  request_id: string;
  payload: Record<string, unknown>;
}

type CommandHandler = (cmd: IncomingCommand) => {
  ok?: boolean;
  message?: string;
  data?: unknown;
  error?: { code: string; message: string; retryable?: boolean };
};

export interface MockBrowser {
  readonly sessionId: string;
  readonly token: string;
  readonly receivedCommands: IncomingCommand[];
  on(commandName: string, handler: CommandHandler): void;
  sendRaw(payload: Record<string, unknown>): void;
  close(): void;
  waitReady(): Promise<void>;
}

export async function startMockBrowser(opts: {
  baseUrl: string;
  clientName?: string;
  current_dashboard_id?: string | null;
  current_tab_id?: string | null;
}): Promise<MockBrowser> {
  const startRes = await fetch(`${opts.baseUrl}/bridge/session/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: opts.clientName ?? "mock-browser",
      current_dashboard_id: opts.current_dashboard_id ?? null,
      current_tab_id: opts.current_tab_id ?? null,
    }),
  });
  if (!startRes.ok) {
    throw new Error(
      `session/start failed ${startRes.status}: ${await startRes.text()}`,
    );
  }
  const startBody = (await startRes.json()) as {
    session: { session_id: string; token: string };
    websocket_url: string;
  };

  // Ignore the server's returned websocket_url — it may carry a stale port
  // when the manager was constructed before the Bun server picked an
  // ephemeral port. Compute the canonical WS URL from `opts.baseUrl`.
  const wsUrl =
    opts.baseUrl.replace(/^http/, "ws") +
    `/bridge/ws?session_id=${startBody.session.session_id}` +
    `&token=${startBody.session.token}`;

  const ws = new WebSocket(wsUrl);
  const handlers = new Map<string, CommandHandler>();
  const received: IncomingCommand[] = [];
  let ready = false;
  let readyResolve: (() => void) | null = null;
  const readyPromise = new Promise<void>((resolve) => {
    readyResolve = resolve;
  });

  ws.addEventListener("message", (evt) => {
    let msg: { type: string; [k: string]: unknown };
    try {
      msg = JSON.parse(typeof evt.data === "string" ? evt.data : "");
    } catch {
      return;
    }
    if (msg.type === "session_ready") {
      ready = true;
      readyResolve?.();
      return;
    }
    if (msg.type === "command_request") {
      const command = msg.command as { command: string; request_id: string };
      const incoming: IncomingCommand = {
        command: command.command,
        request_id: command.request_id,
        payload: command as Record<string, unknown>,
      };
      received.push(incoming);
      const handler = handlers.get(command.command);
      const result = handler
        ? handler(incoming)
        : { ok: true, message: `mock ${command.command} ok`, data: { mocked: true } };
      ws.send(
        JSON.stringify({
          type: "command_result",
          result: {
            ok: result.ok ?? true,
            command: command.command,
            request_id: command.request_id,
            message: result.message ?? "ok",
            data: result.data ?? null,
            error: result.error ?? null,
          },
        }),
      );
    }
  });

  return {
    sessionId: startBody.session.session_id,
    token: startBody.session.token,
    receivedCommands: received,
    on(commandName, handler) {
      handlers.set(commandName, handler);
    },
    sendRaw(payload) {
      ws.send(JSON.stringify(payload));
    },
    close() {
      try {
        ws.close();
      } catch {
        // ignore
      }
    },
    async waitReady() {
      if (ready) return;
      await readyPromise;
    },
  };
}
