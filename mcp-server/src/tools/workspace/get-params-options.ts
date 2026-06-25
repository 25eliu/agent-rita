/**
 * get_params_options — fetch parameter options for one widget input.
 *
 * Mirrors workspace_mcp/server.py:601-628. Only call after get_widget_schema
 * shows the exact param has requires_options_lookup=true.
 */

import { z } from "zod";
import type { ContentItem } from "../../lib/typed";
import { bridgeManager } from "../../bridge/singleton";
import { executeBridgeCommand } from "../../bridge/execute";
import { parseJsonObject, JsonArgumentError } from "../../bridge/json-args";
import { paramOptionsPayloads } from "../../bridge/translate";
import { describeTool, PARAM_OPTIONS_SHAPE } from "../../bridge/instructions";

export const getParamsOptionsSchema = {
  origin: z.string().describe(
    "Friendly catalog label from list_available_widgets.",
  ),
  widget_id: z.string().describe("Widget id from list_available_widgets."),
  param_name: z.string().describe(
    "Exact paramName from get_widget_schema. Use only when " +
      "requires_options_lookup=true on that param.",
  ),
  data_args_json: z.string().optional().describe(
    "JSON object string with values required by options_lookup_params.",
  ),
} as const;

export const getParamsOptionsDescription = describeTool(
  "Fetch parameter options for one or more widget input queries.",
  PARAM_OPTIONS_SHAPE,
  "Use this when get_widget_schema marks a param with requires_options_lookup=true.",
);

export async function getParamsOptionsHandler(args: {
  origin: string;
  widget_id: string;
  param_name: string;
  data_args_json?: string;
}): Promise<{ content: ContentItem[] }> {
  let dataArgs: Record<string, unknown>;
  try {
    dataArgs = parseJsonObject(
      "get_params_options",
      "data_args_json",
      args.data_args_json,
    );
  } catch (err) {
    if (err instanceof JsonArgumentError) {
      return { content: [err.toContentItem()] };
    }
    throw err;
  }

  const queries = paramOptionsPayloads([
    {
      origin: args.origin,
      widget_id: args.widget_id,
      param_name: args.param_name,
      data_args: dataArgs,
    },
  ]);

  const { content } = await executeBridgeCommand(bridgeManager, {
    command: "get_params_options",
    param_options_queries: queries,
  });
  return { content };
}
