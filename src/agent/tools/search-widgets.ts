import { tool } from "ai";
import { z } from "zod";
import type { Widget } from "../../protocol/types";
import { searchWidgets, type TieredWidget, type WidgetTier } from "../../widgets/tiers";
import { getLogger } from "../../lib/logger";
import { DISPLAY_SUMMARY_TOOL_TEXT, displaySummarySchema } from "./progress";

const logger = getLogger(["app", "tools", "search_widgets"]);

const SEARCH_RESULT_CAP = 100;

export const searchWidgetsSchema = z.object({
  display_summary: displaySummarySchema,
  query: z
    .string()
    .describe(
      "Search query — matches against widget name, description, category, and origin. " +
        "Use keywords from the user's question. " +
        "Pass an empty string \"\" to list connected widgets — those added to context first, then those on the current dashboard, then the rest.",
    ),
});

const DISPLAY_ONLY_PREFIXES = ["rich_note", "copilot_table", "iframe", "youtube"];

export type WidgetLocation = "added_to_context" | "on_dashboard" | "connected";

const TIER_TO_LOCATION: Record<WidgetTier, WidgetLocation> = {
  primary: "added_to_context",
  secondary: "on_dashboard",
  extra: "connected",
};

function widgetKind(w: Widget): "data" | "note" | "display" {
  if (w.widget_id.startsWith("rich_note")) return "note";
  if (DISPLAY_ONLY_PREFIXES.some((p) => w.widget_id.startsWith(p))) return "display";
  return "data";
}

export function makeSearchWidgetsTool(
  tiered: TieredWidget[],
) {
  return tool({
    description:
      `Search for widgets in the user's workspace. Returns up to ${SEARCH_RESULT_CAP} matches plus the total count, ` +
      "with identifiers, descriptions, `kind`, and `location`. " +
      DISPLAY_SUMMARY_TOOL_TEXT + " " +
      "The `uuid` field is the canonical identifier — pass it verbatim to get_widget_data. " +
      "The `widget_id` field is the catalog widget type — pass it with `origin` to create_widget when adding a connected widget to the dashboard. " +
      "Identifiers are often slugs (e.g. 'home_cards', 'market_indices'), not UUID-format. " +
      "Kinds: 'data' (fetchable endpoint — use get_widget_data), 'note' (user text), 'display' (embedded). " +
      "Locations: 'added_to_context' (the user pinned it to this conversation), 'on_dashboard' (visible on the current dashboard), 'connected' (in the user's account but not on the current dashboard). " +
      "Results rank by relevance, then by location (added_to_context > on_dashboard > connected). " +
      "When describing widgets to the user, use these plain phrases — never the words 'primary', 'secondary', 'extra', or 'tier'. " +
      "Prefer 'data' for actual numbers. If both data and note widgets match, ask which the user wants. " +
      "Empty query lists all connected widgets, with widgets added to context first.",
    inputSchema: searchWidgetsSchema,
    execute: async ({ query }) => {
      const matches = searchWidgets(tiered, query);
      const results = matches.slice(0, SEARCH_RESULT_CAP).map(({ widget: w, tier }) => ({
        uuid: w.uuid,
        widget_id: w.widget_id,
        name: w.name,
        description: w.description,
        category: w.category ?? "",
        origin: w.origin,
        kind: widgetKind(w),
        location: TIER_TO_LOCATION[tier],
        params: w.params.length
          ? w.params.map(
              (p) =>
                `${p.name}:${p.type}=${p.current_value ?? p.default_value ?? "REQUIRED"}`,
            )
          : undefined,
      }));
      logger.info("Widget search", { query, results: results.length, total: matches.length });
      return { matches: results, total: matches.length };
    },
  });
}
