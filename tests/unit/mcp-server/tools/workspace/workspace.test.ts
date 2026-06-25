import { describe, it, expect, mock, beforeEach } from "bun:test";

let lastCommand: Record<string, unknown> | null = null;
let nextResponse: { ok: boolean; payload?: Record<string, unknown> } = { ok: true };

mock.module("../../../../../mcp-server/src/bridge/singleton", () => ({
  bridgeManager: {},
}));

mock.module("../../../../../mcp-server/src/bridge/execute", () => ({
  executeBridgeCommand: async (_mgr: unknown, cmd: Record<string, unknown>) => {
    lastCommand = cmd;
    if (!nextResponse.ok) {
      return {
        content: [{ type: "text", text: "ERR" }],
        result: { ok: false, message: "fake" },
      };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(nextResponse.payload ?? { ok: true }) }],
      result: { ok: true, payload: nextResponse.payload },
    };
  },
}));

const TOOLS = "../../../../../mcp-server/src/tools/workspace";
const {
  getWorkspaceSnapshotHandler,
  getSkillContentHandler,
  getSkillContentSchema,
  listAvailableWidgetsHandler,
  listAvailableWidgetsSchema,
  getWidgetSchemaHandler,
  getWidgetSchemaSchema,
  getWidgetDataHandler,
  getWidgetDataSchema,
  getParamsOptionsHandler,
  getParamsOptionsSchema,
  readWidgetHandler,
  deleteWidgetHandler,
  updateWidgetHandler,
  updateWidgetLayoutHandler,
  updateWidgetLayoutSchema,
  createWidgetHandler,
  createWidgetSchema,
  manageDashboardHandler,
  manageDashboardSchema,
  manageNavigationBarHandler,
  manageNavigationBarSchema,
  manageBackendsHandler,
  manageBackendsSchema,
  manageAppsHandler,
  manageAppsSchema,
  navigateWorkspaceHandler,
  navigateWorkspaceSchema,
  addGenerativeWidgetHandler,
  addGenerativeWidgetSchema,
  assignTasksToAgentsHandler,
  assignTasksToAgentsSchema,
} = await (async () => {
  const [
    snapshot,
    skill,
    list,
    schema,
    data,
    paramsOpts,
    read,
    del,
    upd,
    layout,
    create,
    dash,
    nav,
    backends,
    apps,
    navigate,
    addGen,
    assign,
  ] = await Promise.all([
    import(`${TOOLS}/get-workspace-snapshot`),
    import(`${TOOLS}/get-skill-content`),
    import(`${TOOLS}/list-available-widgets`),
    import(`${TOOLS}/get-widget-schema`),
    import(`${TOOLS}/get-widget-data`),
    import(`${TOOLS}/get-params-options`),
    import(`${TOOLS}/read-widget`),
    import(`${TOOLS}/delete-widget`),
    import(`${TOOLS}/update-widget`),
    import(`${TOOLS}/update-widget-layout`),
    import(`${TOOLS}/create-widget`),
    import(`${TOOLS}/manage-dashboard`),
    import(`${TOOLS}/manage-navigation-bar`),
    import(`${TOOLS}/manage-backends`),
    import(`${TOOLS}/manage-apps`),
    import(`${TOOLS}/navigate-workspace`),
    import(`${TOOLS}/add-generative-widget`),
    import(`${TOOLS}/assign-tasks-to-agents`),
  ]);
  return {
    getWorkspaceSnapshotHandler: snapshot.getWorkspaceSnapshotHandler,
    getSkillContentHandler: skill.getSkillContentHandler,
    getSkillContentSchema: skill.getSkillContentSchema,
    listAvailableWidgetsHandler: list.listAvailableWidgetsHandler,
    listAvailableWidgetsSchema: list.listAvailableWidgetsSchema,
    getWidgetSchemaHandler: schema.getWidgetSchemaHandler,
    getWidgetSchemaSchema: schema.getWidgetSchemaSchema,
    getWidgetDataHandler: data.getWidgetDataHandler,
    getWidgetDataSchema: data.getWidgetDataSchema,
    getParamsOptionsHandler: paramsOpts.getParamsOptionsHandler,
    getParamsOptionsSchema: paramsOpts.getParamsOptionsSchema,
    readWidgetHandler: read.readWidgetHandler,
    deleteWidgetHandler: del.deleteWidgetHandler,
    updateWidgetHandler: upd.updateWidgetHandler,
    updateWidgetLayoutHandler: layout.updateWidgetLayoutHandler,
    updateWidgetLayoutSchema: layout.updateWidgetLayoutSchema,
    createWidgetHandler: create.createWidgetHandler,
    createWidgetSchema: create.createWidgetSchema,
    manageDashboardHandler: dash.manageDashboardHandler,
    manageDashboardSchema: dash.manageDashboardSchema,
    manageNavigationBarHandler: nav.manageNavigationBarHandler,
    manageNavigationBarSchema: nav.manageNavigationBarSchema,
    manageBackendsHandler: backends.manageBackendsHandler,
    manageBackendsSchema: backends.manageBackendsSchema,
    manageAppsHandler: apps.manageAppsHandler,
    manageAppsSchema: apps.manageAppsSchema,
    navigateWorkspaceHandler: navigate.navigateWorkspaceHandler,
    navigateWorkspaceSchema: navigate.navigateWorkspaceSchema,
    addGenerativeWidgetHandler: addGen.addGenerativeWidgetHandler,
    addGenerativeWidgetSchema: addGen.addGenerativeWidgetSchema,
    assignTasksToAgentsHandler: assign.assignTasksToAgentsHandler,
    assignTasksToAgentsSchema: assign.assignTasksToAgentsSchema,
  };
})();

import { z } from "zod";

beforeEach(() => {
  lastCommand = null;
  nextResponse = { ok: true };
});

function lastCmd<T = Record<string, unknown>>(): T & { command: string } {
  expect(lastCommand).not.toBeNull();
  return lastCommand as unknown as T & { command: string };
}

describe("get_workspace_snapshot", () => {
  it("dispatches a get_workspace_snapshot command with no args", async () => {
    await getWorkspaceSnapshotHandler();
    expect(lastCmd().command).toBe("get_workspace_snapshot");
  });
});

describe("get_skill_content", () => {
  it("requires slug", () => {
    expect(() => z.object(getSkillContentSchema).parse({})).toThrow();
  });

  it("threads slug + reason (defaulting to null)", async () => {
    await getSkillContentHandler({ slug: "alpha" });
    expect(lastCmd()).toMatchObject({ command: "get_skill_content", slug: "alpha", reason: null });

    await getSkillContentHandler({ slug: "alpha", reason: "user asked" });
    expect(lastCmd().reason).toBe("user asked");
  });
});

describe("list_available_widgets", () => {
  it("optional filters default to null", async () => {
    await listAvailableWidgetsHandler({});
    expect(lastCmd()).toMatchObject({
      command: "list_available_widgets",
      origin: null,
      backend_id: null,
    });
  });

  it("forwards origin + backend_id", async () => {
    await listAvailableWidgetsHandler({ origin: "OB", backend_id: "be-1" });
    expect(lastCmd()).toMatchObject({ origin: "OB", backend_id: "be-1" });
  });

  it("passes blank optional filters through to the bridge", async () => {
    await listAvailableWidgetsHandler({ origin: "  ", backend_id: "" });
    expect(lastCmd()).toMatchObject({
      command: "list_available_widgets",
      origin: "  ",
      backend_id: "",
    });
  });

  it("schema accepts empty object", () => {
    expect(z.object(listAvailableWidgetsSchema).parse({})).toEqual({});
  });

  it("schema preserves optional filters", () => {
    const parsed = z.object(listAvailableWidgetsSchema).parse({
      origin: " Open Data Platform ",
      backend_id: " ",
    });

    expect(parsed.origin).toBe(" Open Data Platform ");
    expect(parsed.backend_id).toBe(" ");
  });

  it("schema allows placeholder-like backend ids to pass through validation", () => {
    const parsed = z.object(listAvailableWidgetsSchema).parse({
      origin: "Open Data Platform",
      backend_id: "<backend_id>",
    });

    expect(parsed.backend_id).toBe("<backend_id>");
  });
});

describe("get_widget_schema", () => {
  it("requires origin and widget_id", () => {
    const s = z.object(getWidgetSchemaSchema);
    expect(() => s.parse({})).toThrow();
    expect(() => s.parse({ origin: "" })).toThrow();
  });

  it("forwards origin + widget_id", async () => {
    await getWidgetSchemaHandler({ origin: "OB", widget_id: "w1" });
    expect(lastCmd()).toMatchObject({
      command: "get_widget_schema",
      origin: "OB",
      widget_id: "w1",
    });
  });
});

describe("get_widget_data", () => {
  it("emits a get_widget_data command with translated data_sources", async () => {
    await getWidgetDataHandler({
      origin: "OB",
      widget_id: "w1",
      data_args_json: '{"ticker":"AAPL"}',
    });
    const cmd = lastCmd<{ data_sources: Array<Record<string, unknown>> }>();
    expect(cmd.command).toBe("get_widget_data");
    expect(cmd.data_sources).toHaveLength(1);
  });

  it("returns a JsonArgument error when data_args_json is invalid JSON", async () => {
    const res = await getWidgetDataHandler({
      origin: "OB",
      widget_id: "w1",
      data_args_json: "not json",
    });
    expect(lastCommand).toBeNull();
    expect(res.content[0].text).toContain("data_args_json");
  });

  it("schema requires origin + widget_id", () => {
    expect(() => z.object(getWidgetDataSchema).parse({})).toThrow();
  });
});

describe("get_params_options", () => {
  it("requires origin, widget_id, param_name", () => {
    expect(() => z.object(getParamsOptionsSchema).parse({})).toThrow();
  });

  it("forwards a single query in param_options_queries", async () => {
    await getParamsOptionsHandler({
      origin: "OB",
      widget_id: "w1",
      param_name: "ticker",
      data_args_json: '{"limit":10}',
    });
    const cmd = lastCmd<{ param_options_queries: Array<Record<string, unknown>> }>();
    expect(cmd.command).toBe("get_params_options");
    expect(cmd.param_options_queries).toHaveLength(1);
  });
});

describe("read_widget", () => {
  it("forwards uuid + id + dashboard_id, defaulting omitted to null", async () => {
    await readWidgetHandler({ widget_uuid: "u-1" });
    expect(lastCmd()).toMatchObject({
      command: "read_widget",
      widget_uuid: "u-1",
      widget_id: null,
      dashboard_id: null,
    });
  });
});

describe("delete_widget", () => {
  it("forwards uuid + id + dashboard_id", async () => {
    await deleteWidgetHandler({ widget_id: "w1", dashboard_id: "d1" });
    expect(lastCmd()).toMatchObject({
      command: "delete_widget",
      widget_uuid: null,
      widget_id: "w1",
      dashboard_id: "d1",
    });
  });
});

describe("update_widget", () => {
  it("rejects layout-shaped ui_args (route them to update_widget_layout)", async () => {
    const res = await updateWidgetHandler({
      ui_args_json: '{"x":1,"y":2}',
    });
    expect(lastCommand).toBeNull();
    expect(res.content[0].text).toContain("does not accept layout fields");
  });

  it("emits an update_widget command with config envelope", async () => {
    await updateWidgetHandler({
      widget_uuid: "u-1",
      data_args_json: '{"ticker":"AAPL"}',
    });
    const cmd = lastCmd<{ config: { data_args: Record<string, unknown> | null; ui_args: Record<string, unknown> | null } }>();
    expect(cmd.command).toBe("update_widget");
    expect(cmd.config.data_args).toEqual({ ticker: "AAPL" });
    expect(cmd.config.ui_args).toBeNull();
  });
});

describe("update_widget_layout", () => {
  it("requires x/y/w/h", () => {
    expect(() => z.object(updateWidgetLayoutSchema).parse({})).toThrow();
  });

  it("emits update_dashboard_layout (wire name) command", async () => {
    await updateWidgetLayoutHandler({
      x: 0,
      y: 0,
      w: 20,
      h: 8,
      widget_uuid: "u-1",
    });
    const cmd = lastCmd<{ command: string; x: number; y: number; w: number; h: number }>();
    expect(cmd.command).toBe("update_dashboard_layout");
    expect(cmd).toMatchObject({ x: 0, y: 0, w: 20, h: 8 });
  });
});

describe("create_widget", () => {
  it("rejects rich_note (must use add_generative_widget)", async () => {
    const res = await createWidgetHandler({ origin: "OB", widget_id: "rich_note" });
    expect(lastCommand).toBeNull();
    expect(res.content[0].text).toContain("does not support 'rich_note'");
  });

  it("requires non-empty origin and widget_id at the schema layer", () => {
    const s = z.object(createWidgetSchema);
    expect(() => s.parse({ origin: "", widget_id: "w1" })).toThrow();
    expect(() => s.parse({ origin: "OB", widget_id: "" })).toThrow();
  });

  it("emits backend_name (renamed from origin) and a config envelope when args present", async () => {
    await createWidgetHandler({
      origin: "OB",
      widget_id: "price",
      data_args_json: '{"ticker":"AAPL"}',
    });
    const cmd = lastCmd<{ backend_name: string; widget_id: string; config: Record<string, unknown> }>();
    expect(cmd.command).toBe("create_widget");
    expect(cmd.backend_name).toBe("OB");
    expect(cmd.config).toEqual({ data_args: { ticker: "AAPL" }, ui_args: null });
  });

  it("ships config:null when both arg blobs are empty", async () => {
    await createWidgetHandler({ origin: "OB", widget_id: "price" });
    const cmd = lastCmd<{ config: unknown }>();
    expect(cmd.config).toBeNull();
  });
});

describe("manage_dashboard", () => {
  it("create requires name", async () => {
    const res = await manageDashboardHandler({ operation: "create" });
    expect(lastCommand).toBeNull();
    expect(res.content[0].text).toContain("requires name");
  });

  it("read defaults dashboard_id to null", async () => {
    await manageDashboardHandler({ operation: "read" });
    expect(lastCmd()).toMatchObject({
      command: "manage_dashboard",
      operation: "read",
      dashboard_id: null,
      name: null,
    });
  });

  it("update requires dashboard_id and name", async () => {
    const res = await manageDashboardHandler({ operation: "update" });
    expect(lastCommand).toBeNull();
    expect(res.content[0].text).toContain("requires dashboard_id and name");
  });

  it("schema rejects unknown operation", () => {
    expect(() =>
      z.object(manageDashboardSchema).parse({ operation: "bogus" as unknown }),
    ).toThrow();
  });
});

describe("manage_navigation_bar", () => {
  it("create rejects empty tabs_json", async () => {
    const res = await manageNavigationBarHandler({ operation: "create", tabs_json: "[]" });
    expect(lastCommand).toBeNull();
    expect(res.content[0].text).toContain("non-empty tabs_json");
  });

  it("rename_tabs requires non-empty rename_map_json", async () => {
    const res = await manageNavigationBarHandler({
      operation: "rename_tabs",
      rename_map_json: "{}",
    });
    expect(lastCommand).toBeNull();
    expect(res.content[0].text).toContain("rename_map_json with at least one entry");
  });

  it("create with valid tabs forwards command + payload", async () => {
    await manageNavigationBarHandler({
      operation: "create",
      tabs_json: '[{"name":"AAPL Analysis"}]',
    });
    const cmd = lastCmd<{ tabs: Array<Record<string, unknown>> }>();
    expect(cmd.command).toBe("manage_navigation_bar");
    expect(cmd.tabs[0].name).toBe("AAPL Analysis");
  });

  it("schema rejects unknown operation", () => {
    expect(() =>
      z.object(manageNavigationBarSchema).parse({ operation: "destroy_tabs" as unknown }),
    ).toThrow();
  });
});

describe("manage_backends", () => {
  it("add requires name and url", async () => {
    const res = await manageBackendsHandler({ operation: "add" });
    expect(lastCommand).toBeNull();
    expect(res.content[0].text).toContain("requires name and url");
  });

  it("update requires backend_id and at least one mutable field", async () => {
    const res = await manageBackendsHandler({ operation: "update" });
    expect(lastCommand).toBeNull();
    expect(res.content[0].text).toContain("requires backend_id");

    const empty = await manageBackendsHandler({ operation: "update", backend_id: "be-1" });
    expect(empty.content[0].text).toContain("at least one of");
  });

  it("happy add forwards endpoint headers when provided", async () => {
    await manageBackendsHandler({
      operation: "add",
      name: "Foo",
      url: "https://x",
      endpoint_headers_json: '[{"key":"k","value":"v"}]',
    });
    const cmd = lastCmd<{ endpoint_headers: Array<Record<string, unknown>> }>();
    expect(cmd.endpoint_headers?.[0]).toMatchObject({ key: "k", value: "v" });
  });

  it("schema rejects unknown operation", () => {
    expect(() =>
      z.object(manageBackendsSchema).parse({ operation: "purge" as unknown }),
    ).toThrow();
  });
});

describe("manage_apps", () => {
  it("requires backend_id", async () => {
    const res = await manageAppsHandler({
      operation: "list",
      backend_id: "" as unknown as string,
    });
    expect(lastCommand).toBeNull();
    expect(res.content[0].text).toContain("requires backend_id");
  });

  it("read/instantiate require app_name or template_id", async () => {
    const read = await manageAppsHandler({ operation: "read", backend_id: "be-1" });
    expect(read.content[0].text).toContain("requires app_name or template_id");

    const inst = await manageAppsHandler({ operation: "instantiate", backend_id: "be-1" });
    expect(inst.content[0].text).toContain("requires app_name or template_id");
  });

  it("schema rejects unknown operation", () => {
    expect(() =>
      z.object(manageAppsSchema).parse({ operation: "delete" as unknown, backend_id: "x" }),
    ).toThrow();
  });

  it("instantiate forwards app_name", async () => {
    await manageAppsHandler({
      operation: "instantiate",
      backend_id: "be-1",
      app_name: "Earnings",
    });
    expect(lastCmd()).toMatchObject({
      command: "manage_apps",
      operation: "instantiate",
      app_name: "Earnings",
    });
  });
});

describe("navigate_workspace", () => {
  it("dashboard requires dashboard_id", async () => {
    const res = await navigateWorkspaceHandler({ operation: "dashboard" });
    expect(lastCommand).toBeNull();
    expect(res.content[0].text).toContain("requires dashboard_id");
  });

  it("tab requires tab_id", async () => {
    const res = await navigateWorkspaceHandler({ operation: "tab" });
    expect(lastCommand).toBeNull();
    expect(res.content[0].text).toContain("requires tab_id");
  });

  it("schema rejects unknown operation", () => {
    expect(() =>
      z.object(navigateWorkspaceSchema).parse({ operation: "home" as unknown }),
    ).toThrow();
  });

  it("forwards tab_id when operation=tab", async () => {
    await navigateWorkspaceHandler({ operation: "tab", tab_id: "aapl-analysis" });
    expect(lastCmd()).toMatchObject({
      command: "navigate_workspace",
      operation: "tab",
      tab_id: "aapl-analysis",
      dashboard_id: null,
    });
  });
});

describe("add_generative_widget", () => {
  it("schema requires widget_type", () => {
    expect(() => z.object(addGenerativeWidgetSchema).parse({})).toThrow();
  });

  it("note widget happy path forwards command", async () => {
    await addGenerativeWidgetHandler({
      widget_type: "note",
      data_json: "this is a note",
    });
    const cmd = lastCmd<{ command: string; widget_type: string; data: unknown }>();
    expect(cmd.command).toBe("add_generative_widget");
    expect(cmd.widget_type).toBe("note");
    expect(cmd.data).toBe("this is a note");
  });

  it("chart without chart_params_json returns invalid request", async () => {
    const res = await addGenerativeWidgetHandler({
      widget_type: "chart",
      data_json: '[{"x":1,"y":2}]',
    });
    expect(lastCommand).toBeNull();
    expect(res.content[0].text).toContain("chart_params");
  });
});

describe("assign_tasks_to_agents", () => {
  it("schema requires task_requests_json", () => {
    expect(() => z.object(assignTasksToAgentsSchema).parse({})).toThrow();
  });

  it("forwards task_requests when JSON parses as a list", async () => {
    await assignTasksToAgentsHandler({
      task_requests_json: '[{"id":"t1","description":"d","assigned_holder_url":"u","assigned_agent_id":"a"}]',
    });
    const cmd = lastCmd<{ task_requests: Array<Record<string, unknown>> }>();
    expect(cmd.command).toBe("assign_tasks_to_agents");
    expect(cmd.task_requests[0].id).toBe("t1");
  });

  it("returns json error on malformed input", async () => {
    const res = await assignTasksToAgentsHandler({ task_requests_json: "not json" });
    expect(lastCommand).toBeNull();
    expect(res.content[0].text).toContain("task_requests_json");
  });
});
