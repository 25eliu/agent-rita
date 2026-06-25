/**
 * SSE emit adapter for the workspace bridge commands.
 *
 * The agent registers its workspace tools under the openbb-ai function names
 * (the registry entries in bridge-commands.ts are named for the SSE wire), so
 * `workspaceCommand(toolName, …)` already emits a contract-valid `function`.
 * What still differs is the argument SHAPE: the LLM-facing tool input is the
 * clean "bridge config" shape, while the frontend's copilotFunctionCall schema
 * (terminalpro src/lib/utils/ai.ts) expects the openbb-ai `data_sources` /
 * field-renamed shapes. `normalizeBridgeArgs` reshapes the payload at emit.
 */

/**
 * The bridge commands that have an openbb-ai SSE function-call equivalent, and
 * therefore the ONLY workspace tools the SSE agent registers. The remaining
 * entries in WORKSPACE_BRIDGE_COMMANDS (get_workspace_snapshot,
 * list_available_widgets, get_widget_schema, read_widget, delete_widget,
 * manage_dashboard, update_dashboard_layout, navigate_workspace,
 * manage_backends, manage_apps) have no openbb-ai SSE function and exist for the
 * WebSocket companion only — registering them would let the model emit a
 * copilotFunctionCall the frontend rejects with a ZodError.
 */
export const OPENBB_AI_SSE_BRIDGE_COMMANDS: ReadonlySet<string> = new Set([
  "update_widget_in_dashboard",
  "add_widget_to_dashboard",
  "get_params_options",
  "manage_navigation_bar",
  "add_generative_widget",
  "assign_tasks_to_agents",
]);

function asRecord(value: unknown): Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Reshape a bridge tool's LLM-facing input into the openbb-ai wire
 * `input_arguments`. The `function` name is already correct; this only
 * normalizes the payload so it passes the frontend's Zod schema.
 *
 * - update_widget_in_dashboard / add_widget_to_dashboard: bridge `config` →
 *   openbb-ai `data_sources[]`. (The frontend does not validate these, but it
 *   reads `data_sources[].widget_uuid` / `.origin` / `.id` / `.input_args`.)
 * - get_params_options: field renames (widget_id→id, param_name→param,
 *   data_args→options_endpoint_input_args) — strictly validated by the frontend.
 * - manage_navigation_bar / add_generative_widget / assign_tasks_to_agents: the
 *   LLM shape already validates (the frontend strips unknown keys such as
 *   dashboard_id); pass through, with a defensive `name` default for the
 *   generative widget (the frontend requires a string name).
 */
export function normalizeBridgeArgs(
  fn: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  switch (fn) {
    case "update_widget_in_dashboard": {
      const config = asRecord(input.config);
      return {
        data_sources: [
          {
            widget_uuid: input.widget_uuid,
            ...(input.widget_id ? { id: input.widget_id } : {}),
            input_args: asRecord(config.data_args),
          },
        ],
      };
    }
    case "add_widget_to_dashboard": {
      const config = asRecord(input.config);
      return {
        data_sources: [
          {
            origin: input.origin,
            id: input.widget_id,
            input_args: asRecord(config.data_args),
          },
        ],
      };
    }
    case "get_params_options": {
      const queries = Array.isArray(input.param_options_queries)
        ? input.param_options_queries
        : [];
      return {
        param_options_queries: queries.map((query) => {
          const q = asRecord(query);
          return {
            origin: q.origin,
            id: q.widget_id,
            param: q.param_name,
            options_endpoint_input_args: asRecord(q.data_args),
          };
        }),
      };
    }
    case "add_generative_widget": {
      const { dashboard_id: _dashboardId, ...rest } = input;
      return {
        ...rest,
        name: typeof input.name === "string" ? input.name : "",
      };
    }
    case "manage_navigation_bar":
    case "assign_tasks_to_agents":
      return input;
    default:
      return input;
  }
}
