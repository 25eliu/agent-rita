/**
 * SSE emit adapter — bridge tool input → openbb-ai wire input_arguments.
 *
 * Verifies:
 *   - OPENBB_AI_SSE_BRIDGE_COMMANDS are all real bridge commands (rename guard)
 *   - normalizeBridgeArgs reshapes each command to the openbb-ai wire shape
 *     that terminalpro's copilotFunctionCall schema expects
 */

import { describe, it, expect } from "bun:test";
import { WORKSPACE_BRIDGE_COMMAND_NAMES } from "../../../../src/protocol/bridge-commands";
import {
  OPENBB_AI_SSE_BRIDGE_COMMANDS,
  normalizeBridgeArgs,
} from "../../../../src/protocol/bridge-emit";

describe("OPENBB_AI_SSE_BRIDGE_COMMANDS", () => {
  it("are all registered bridge commands (rename guard)", () => {
    for (const name of OPENBB_AI_SSE_BRIDGE_COMMANDS) {
      expect(WORKSPACE_BRIDGE_COMMAND_NAMES.has(name)).toBe(true);
    }
  });

  it("are exactly the openbb-ai SSE-equivalent surface", () => {
    expect([...OPENBB_AI_SSE_BRIDGE_COMMANDS].sort()).toEqual([
      "add_generative_widget",
      "add_widget_to_dashboard",
      "assign_tasks_to_agents",
      "get_params_options",
      "manage_navigation_bar",
      "update_widget_in_dashboard",
    ]);
  });
});

describe("normalizeBridgeArgs", () => {
  it("update_widget_in_dashboard: config → data_sources with input_args", () => {
    expect(
      normalizeBridgeArgs("update_widget_in_dashboard", {
        widget_uuid: "w-1",
        config: { data_args: { limit: 100 }, ui_args: null },
      }),
    ).toEqual({
      data_sources: [{ widget_uuid: "w-1", input_args: { limit: 100 } }],
    });
  });

  it("update_widget_in_dashboard: includes id only when widget_id is present", () => {
    expect(
      normalizeBridgeArgs("update_widget_in_dashboard", {
        widget_uuid: "w-1",
        widget_id: "home_cards",
        config: { data_args: { limit: 100 } },
      }),
    ).toEqual({
      data_sources: [{ widget_uuid: "w-1", id: "home_cards", input_args: { limit: 100 } }],
    });
  });

  it("update_widget_in_dashboard: defaults input_args to {} when config absent", () => {
    expect(normalizeBridgeArgs("update_widget_in_dashboard", { widget_uuid: "w-1" })).toEqual({
      data_sources: [{ widget_uuid: "w-1", input_args: {} }],
    });
  });

  it("add_widget_to_dashboard: config → data_sources with origin and id", () => {
    expect(
      normalizeBridgeArgs("add_widget_to_dashboard", {
        origin: "openbb",
        widget_id: "options_chain",
        dashboard_id: "d-1",
        config: { data_args: { symbol: "AAPL" } },
      }),
    ).toEqual({
      data_sources: [{ origin: "openbb", id: "options_chain", input_args: { symbol: "AAPL" } }],
    });
  });

  it("get_params_options: renames widget_id→id, param_name→param, data_args→options_endpoint_input_args", () => {
    expect(
      normalizeBridgeArgs("get_params_options", {
        param_options_queries: [
          {
            origin: "openbb",
            widget_id: "stock_price",
            param_name: "exchange",
            data_args: { symbol: "AAPL" },
          },
        ],
      }),
    ).toEqual({
      param_options_queries: [
        {
          origin: "openbb",
          id: "stock_price",
          param: "exchange",
          options_endpoint_input_args: { symbol: "AAPL" },
        },
      ],
    });
  });

  it("add_generative_widget: strips dashboard_id, keeps content, defaults name", () => {
    expect(
      normalizeBridgeArgs("add_generative_widget", {
        widget_type: "note",
        dashboard_id: "d-1",
        data: "hello",
      }),
    ).toEqual({
      widget_type: "note",
      data: "hello",
      name: "",
    });
  });

  it("manage_navigation_bar: passes through unchanged", () => {
    const input = { operation: "create", tabs: [{ name: "Overview" }] };
    expect(normalizeBridgeArgs("manage_navigation_bar", input)).toEqual(input);
  });

  it("assign_tasks_to_agents: passes through unchanged", () => {
    const input = {
      task_requests: [
        {
          id: "t-1",
          description: "Analyze AAPL",
          assigned_holder_url: "https://agents.example.com",
          assigned_agent_id: "agent-1",
        },
      ],
    };
    expect(normalizeBridgeArgs("assign_tasks_to_agents", input)).toEqual(input);
  });

  it("unknown command: passes through unchanged", () => {
    const input = { foo: "bar" };
    expect(normalizeBridgeArgs("not_a_command", input)).toEqual(input);
  });
});
