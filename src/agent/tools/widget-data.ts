import { tool } from "ai";
import { z } from "zod";
import { DISPLAY_SUMMARY_TOOL_TEXT, displaySummarySchema } from "./progress";

const widgetRequestSchema = z.object({
  widget_uuid: z.string().describe(
    "Widget identifier. Use the `uuid` value returned by search_widgets or shown in the prompt.",
  ),
  input_args: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Parameter overrides for this widget. For Snowflake/SSRM widgets, pass { query: '<SELECT SQL>' } to execute SQL.",
    ),
});

export const widgetDataSchema = z.object({
  display_summary: displaySummarySchema,
  widgets: z
    .array(widgetRequestSchema)
    .describe("Widgets to fetch data from, with optional parameter overrides"),
});

export type WidgetRequest = z.infer<typeof widgetRequestSchema>;

export function makeWidgetDataTool() {
  return tool({
    description:
      "Retrieve actual data from one or more widgets. Call this when you need real data to answer the user's question. " +
      "Multi-widget requests are resolved sequentially by the agent so each widget load has its own status. " +
      DISPLAY_SUMMARY_TOOL_TEXT + " " +
      "For each widget object, use widget_uuid with the exact `uuid` returned by search_widgets or shown in the prompt. " +
      "Put widget parameter overrides in input_args. " +
      "For Snowflake/SSRM widgets, pass input_args.query with your SELECT SQL.",
    inputSchema: widgetDataSchema,
  });
}
