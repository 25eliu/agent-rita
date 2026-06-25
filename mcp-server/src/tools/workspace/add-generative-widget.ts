/**
 * add_generative_widget — render a generative widget (note/table/chart/html).
 *
 * Mirrors workspace_mcp/server.py:945-991. data_json shape varies by
 * widget_type; chart additionally requires chart_params_json with
 * {chartType, xKey, non-empty yKey}.
 */

import { z } from "zod";
import type { ContentItem } from "../../lib/typed";
import { bridgeManager } from "../../bridge/singleton";
import { executeBridgeCommand } from "../../bridge/execute";
import {
  invalidRequestItem,
  validateAddGenerativeWidgetRequest,
} from "../../bridge/validators";
import {
  parseGenerativeData,
  parseJsonObject,
  JsonArgumentError,
} from "../../bridge/json-args";
import {
  describeTool,
  GENERATIVE_WIDGET_GUIDANCE,
  DASHBOARD_TARGETING_GUIDANCE,
} from "../../bridge/instructions";

export const addGenerativeWidgetSchema = {
  widget_type: z
    .enum(["note", "table", "chart", "html"])
    .describe("Generative widget kind."),
  dashboard_id: z.string().optional().describe(
    "Target dashboard UUID. Omit to target the current Workspace route.",
  ),
  data_json: z.string().optional().describe(
    "Widget content. note/html: plain string OR JSON-quoted string. " +
      "table/chart: JSON array of objects.",
  ),
  name: z.string().optional().describe("Widget display name."),
  description: z.string().optional().describe("Widget short description."),
  chart_params_json: z.string().optional().describe(
    "Required for widget_type='chart'. JSON object with chartType, xKey, non-empty yKey.",
  ),
  inner_tab: z.string().optional().describe(
    "Existing inner tab id to place the widget on. Does NOT create a tab.",
  ),
} as const;

export const addGenerativeWidgetDescription = describeTool(
  "Create a generative widget (note, table, chart, or html) with inline data.",
  GENERATIVE_WIDGET_GUIDANCE,
  DASHBOARD_TARGETING_GUIDANCE,
);

export async function addGenerativeWidgetHandler(args: {
  widget_type: "note" | "table" | "chart" | "html";
  dashboard_id?: string;
  data_json?: string;
  name?: string;
  description?: string;
  chart_params_json?: string;
  inner_tab?: string;
}): Promise<{ content: ContentItem[] }> {
  let data: unknown;
  let chartParams: Record<string, unknown> | null;
  try {
    data = parseGenerativeData(args.widget_type, args.data_json);
    const parsedChart = parseJsonObject(
      "add_generative_widget",
      "chart_params_json",
      args.chart_params_json,
    );
    chartParams = Object.keys(parsedChart).length > 0 ? parsedChart : null;
  } catch (err) {
    if (err instanceof JsonArgumentError) {
      return { content: [err.toContentItem()] };
    }
    throw err;
  }

  const validationError = validateAddGenerativeWidgetRequest({
    widget_type: args.widget_type,
    data: data as Array<Record<string, unknown>> | string | null,
    chart_params: chartParams,
  });
  if (validationError) {
    return { content: [invalidRequestItem(validationError)] };
  }

  // Wire schema accepts data as list[dict] | string | null.
  const dataValue =
    data === null
      ? null
      : typeof data === "string"
        ? data
        : (data as Array<Record<string, unknown>>);

  const { content } = await executeBridgeCommand(bridgeManager, {
    command: "add_generative_widget",
    dashboard_id: args.dashboard_id ?? null,
    widget_type: args.widget_type,
    data: dataValue,
    name: args.name ?? null,
    description: args.description ?? null,
    chart_params: chartParams,
    inner_tab: args.inner_tab ?? null,
  });
  return { content };
}
