/**
 * Bridge integration test: boot a minimal Hono app with the bridge routes,
 * connect a mock browser, and drive each of the 5 PoC workspace commands
 * end-to-end. Asserts wire-level command shape + round-trip result delivery.
 *
 * Mini-app pattern (no full server.ts boot) keeps tests independent of the
 * MCP transport layer and avoids module-scope side-effect ordering issues.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { makeBridgeSessionManager } from "../../src/bridge/state";
import { mountBridgeRoutes } from "../../src/bridge/routes";
import { executeBridgeCommand } from "../../src/bridge/execute";
import { startMockBrowser, type MockBrowser } from "./mock-browser";

let server: ReturnType<typeof Bun.serve>;
let manager: ReturnType<typeof makeBridgeSessionManager>;
let baseUrl: string;
let mock: MockBrowser;

beforeAll(async () => {
  const app = new Hono();
  manager = makeBridgeSessionManager({
    baseUrl: "http://127.0.0.1:0",
    websocketPath: "/bridge/ws",
    commandTimeoutMs: 2_000,
  });
  const { websocket } = mountBridgeRoutes(app, manager);
  server = Bun.serve({ fetch: app.fetch, port: 0, websocket });
  baseUrl = `http://127.0.0.1:${server.port}`;
  mock = await startMockBrowser({ baseUrl, clientName: "integration-test" });
  await mock.waitReady();
});

afterAll(() => {
  mock?.close();
  server?.stop();
});

describe("bridge integration — 5 PoC workspace commands", () => {
  test("get_workspace_snapshot round-trip", async () => {
    mock.on("get_workspace_snapshot", () => ({
      ok: true,
      message: "snapshot ok",
      data: {
        generated_at: 1_700_000_000,
        dashboards: [{ id: "d1", name: "Dash1" }],
      },
    }));
    const sessionId = manager.getFirstConnectedSessionId();
    expect(sessionId).not.toBeNull();
    const { result } = await executeBridgeCommand(
      manager,
      { command: "get_workspace_snapshot" },
      { sessionId: sessionId! },
    );
    expect(result?.ok).toBe(true);
    expect(result?.command).toBe("get_workspace_snapshot");
    expect((result?.data as { dashboards: unknown[] }).dashboards).toHaveLength(1);
  });

  test("list_available_widgets round-trip with origin filter", async () => {
    mock.on("list_available_widgets", (cmd) => ({
      ok: true,
      data: { received: cmd.payload },
    }));
    const { result } = await executeBridgeCommand(
      manager,
      { command: "list_available_widgets", origin: "OpenBB", backend_id: null },
      { sessionId: manager.getFirstConnectedSessionId()! },
    );
    expect(result?.ok).toBe(true);
    const echoed = (result?.data as { received: { origin: string } }).received;
    expect(echoed.origin).toBe("OpenBB");
  });

  test("get_widget_schema round-trip", async () => {
    mock.on("get_widget_schema", () => ({
      ok: true,
      data: { schema: { params: [{ name: "ticker" }] } },
    }));
    const { result } = await executeBridgeCommand(
      manager,
      { command: "get_widget_schema", origin: "OpenBB", widget_id: "stock_chart" },
      { sessionId: manager.getFirstConnectedSessionId()! },
    );
    expect(result?.ok).toBe(true);
  });

  test("read_widget round-trip", async () => {
    mock.on("read_widget", () => ({
      ok: true,
      data: { widget_uuid: "w-1", payload: { foo: "bar" } },
    }));
    const { result } = await executeBridgeCommand(
      manager,
      {
        command: "read_widget",
        widget_uuid: "w-1",
        widget_id: null,
        dashboard_id: null,
      },
      { sessionId: manager.getFirstConnectedSessionId()! },
    );
    expect(result?.ok).toBe(true);
  });

  test("delete_widget round-trip", async () => {
    mock.on("delete_widget", () => ({ ok: true, message: "deleted" }));
    const { result } = await executeBridgeCommand(
      manager,
      {
        command: "delete_widget",
        widget_uuid: "w-1",
        widget_id: null,
        dashboard_id: null,
      },
      { sessionId: manager.getFirstConnectedSessionId()! },
    );
    expect(result?.ok).toBe(true);
    expect(result?.message).toBe("deleted");
  });

  test("no connected browser → unavailable error", async () => {
    // Simulate by passing an unknown sessionId.
    const { content, result } = await executeBridgeCommand(
      manager,
      { command: "get_workspace_snapshot" },
      { sessionId: "unknown-session-id" },
    );
    expect(result).toBeNull();
    const parsed = JSON.parse(content[0].text) as {
      $rita_kind: string;
      error: { code: string };
    };
    expect(parsed.$rita_kind).toBe("error");
    expect(parsed.error.code).toBe("unavailable");
  });

  test("timeout when browser does not respond", async () => {
    mock.on("get_workspace_snapshot", () => {
      throw new Error("ignored — overridden by silent handler below");
    });
    // Replace the WS so it eats messages without sending a result.
    // Easier: override the handler to a function that returns nothing
    // and patch the mock to suppress send. Instead use a fresh manager
    // that has very short timeout and a session with no connected socket.
    const m2 = makeBridgeSessionManager({
      baseUrl: "http://127.0.0.1:0",
      websocketPath: "/bridge/ws",
      commandTimeoutMs: 50,
    });
    const start = m2.startSession({ client_name: "silent" });
    // Connect a fake socket that never replies
    m2.connectBrowser({
      sessionId: start.session.session_id,
      token: start.session.token,
      socket: { send: () => {}, close: () => {} },
    });
    const { result } = await executeBridgeCommand(
      m2,
      { command: "get_workspace_snapshot" },
      { sessionId: start.session.session_id },
    );
    expect(result?.ok).toBe(false);
    expect(result?.error?.code).toBe("timeout");
  });
});

describe("bridge state — session lifecycle", () => {
  test("session_context_changed updates tracked context", async () => {
    mock.sendRaw({
      type: "session_context_changed",
      session: { current_dashboard_id: "dash-9", current_tab_id: "tab-3" },
    });
    // Allow event loop to process the message.
    await new Promise((r) => setTimeout(r, 50));
    const ctx = manager.getSessionContext(mock.sessionId);
    expect(ctx?.current_dashboard_id).toBe("dash-9");
    expect(ctx?.current_tab_id).toBe("tab-3");
  });

  test("ping is no-op", async () => {
    mock.sendRaw({ type: "ping" });
    await new Promise((r) => setTimeout(r, 30));
    // No assertion fires — just confirms ping does not crash the manager.
    expect(manager.health().connected).toBeGreaterThanOrEqual(1);
  });
});

describe("Phase A: snapshot validation + session_context injection + invalid-payload semantics", () => {
  test("session_context injected on ok command result with object data", async () => {
    // Set context first so injection has values.
    mock.sendRaw({
      type: "session_context_changed",
      session: { current_dashboard_id: "dash-A", current_tab_id: "tab-A" },
    });
    await new Promise((r) => setTimeout(r, 30));

    mock.on("delete_widget", () => ({
      ok: true,
      message: "deleted",
      data: { widget_uuid: "w-1" },
    }));
    const { result } = await executeBridgeCommand(
      manager,
      {
        command: "delete_widget",
        widget_uuid: "w-1",
        widget_id: null,
        dashboard_id: null,
      },
      { sessionId: manager.getFirstConnectedSessionId()! },
    );
    expect(result?.ok).toBe(true);
    const data = result?.data as { session_context?: Record<string, unknown> };
    expect(data.session_context).toBeDefined();
    expect(data.session_context?.current_dashboard_uuid).toBe("dash-A");
    expect(data.session_context?.current_tab_id).toBe("tab-A");
  });

  test("session_context NOT overwritten when already present in result data", async () => {
    mock.on("read_widget", () => ({
      ok: true,
      data: {
        widget_uuid: "w-1",
        session_context: { current_dashboard_uuid: "browser-set", current_tab_id: "browser-set" },
      },
    }));
    const { result } = await executeBridgeCommand(
      manager,
      {
        command: "read_widget",
        widget_uuid: "w-1",
        widget_id: null,
        dashboard_id: null,
      },
      { sessionId: manager.getFirstConnectedSessionId()! },
    );
    const data = result?.data as { session_context: { current_dashboard_uuid: string } };
    expect(data.session_context.current_dashboard_uuid).toBe("browser-set");
  });

  test("session_context NOT injected on ok=false results", async () => {
    mock.on("read_widget", () => ({
      ok: false,
      message: "not found",
      data: { hint: "no such widget" },
      error: { code: "command_failed", message: "not found", retryable: false },
    }));
    const { result } = await executeBridgeCommand(
      manager,
      {
        command: "read_widget",
        widget_uuid: "missing",
        widget_id: null,
        dashboard_id: null,
      },
      { sessionId: manager.getFirstConnectedSessionId()! },
    );
    const data = result?.data as { session_context?: unknown };
    expect(data.session_context).toBeUndefined();
  });

  test("session_context NOT injected when data is array", async () => {
    mock.on("list_available_widgets", () => ({
      ok: true,
      data: [{ widget_id: "w1" }, { widget_id: "w2" }],
    }));
    const { result } = await executeBridgeCommand(
      manager,
      { command: "list_available_widgets", origin: null, backend_id: null },
      { sessionId: manager.getFirstConnectedSessionId()! },
    );
    expect(Array.isArray(result?.data)).toBe(true);
  });

  test("get_workspace_snapshot with valid envelope passes through", async () => {
    mock.on("get_workspace_snapshot", () => ({
      ok: true,
      data: {
        generated_at: 1_700_000_000,
        dashboards: [{ id: "d1", name: "D1" }],
        skills: [],
      },
    }));
    const { result } = await executeBridgeCommand(
      manager,
      { command: "get_workspace_snapshot" },
      { sessionId: manager.getFirstConnectedSessionId()! },
    );
    expect(result?.ok).toBe(true);
    const data = result?.data as { generated_at: number; session_context: unknown };
    expect(data.generated_at).toBe(1_700_000_000);
    // Snapshot path also gets session_context injection.
    expect(data.session_context).toBeDefined();
  });

  test("get_workspace_snapshot with invalid envelope returns invalid_request", async () => {
    mock.on("get_workspace_snapshot", () => ({
      ok: true,
      data: { generated_at: "not-a-number" }, // bad type, schema fails
    }));
    const { result } = await executeBridgeCommand(
      manager,
      { command: "get_workspace_snapshot" },
      { sessionId: manager.getFirstConnectedSessionId()! },
    );
    expect(result?.ok).toBe(false);
    expect(result?.error?.code).toBe("invalid_request");
    expect(result?.error?.details).toBeDefined();
  });

  test("invalid browser payload fails ALL pending commands without disconnect", async () => {
    // Use isolated manager + fake silent socket so we can fire multiple commands.
    const m2 = makeBridgeSessionManager({
      baseUrl: "http://127.0.0.1:0",
      websocketPath: "/bridge/ws",
      commandTimeoutMs: 5_000,
    });
    const start = m2.startSession({ client_name: "silent" });
    const sent: string[] = [];
    m2.connectBrowser({
      sessionId: start.session.session_id,
      token: start.session.token,
      socket: { send: (data) => sent.push(data), close: () => {} },
    });

    // Fire two commands (don't await — they will resolve via fail-pending).
    const p1 = m2.executeCommand(start.session.session_id, {
      command: "delete_widget",
      widget_uuid: "w-1",
      widget_id: null,
      dashboard_id: null,
    });
    const p2 = m2.executeCommand(start.session.session_id, {
      command: "read_widget",
      widget_uuid: "w-2",
      widget_id: null,
      dashboard_id: null,
    });

    // Tick so the executeCommand body schedules the timeouts/sends.
    await new Promise((r) => setTimeout(r, 10));

    // Inject malformed payload (missing required fields).
    m2.handleBrowserMessage(start.session.session_id, { type: "totally-bogus" });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.ok).toBe(false);
    expect(r1.error?.code).toBe("invalid_request");
    expect(r2.ok).toBe(false);
    expect(r2.error?.code).toBe("invalid_request");
    // Socket NOT closed: subsequent valid messages would still be processed.
    expect(m2.health().connected).toBe(1);
  });
});
