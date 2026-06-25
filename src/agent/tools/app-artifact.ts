/**
 * `create_app` — assemble connected widgets into an OpenBB dashboard app
 * (apps.json template shape). The workspace renders the resulting `app`
 * artifact with Open-as-dashboard and Save-to-apps actions.
 *
 * State-bound — closes over the live widget catalog (`allWidgets`) to validate
 * and resolve every `(origin, widget_id)` reference, and over `artifactQueue`
 * to push the artifact. Validation runs in-process: an unknown reference is
 * returned as the tool result so the model self-corrects without a round-trip.
 *
 * Mirrors `create_html_artifact` (./html-artifact.ts): local `execute`, returns
 * text, pushes one artifact. No round-trip, no stopWhen entry.
 */

import { tool } from "ai";
import { z } from "zod";
import { messageArtifact } from "../../protocol/events";
import type {
  AppArtifact,
  AppArtifactWidgetRef,
  AppsJsonDef,
  AppsJsonGroup,
  AppsJsonTab,
  SSEEvent,
  Widget,
} from "../../protocol/types";
import { getLogger } from "../../lib/logger";
import { DISPLAY_SUMMARY_TOOL_TEXT, displaySummarySchema } from "./progress";

const logger = getLogger(["app", "tools", "create_app"]);

const layoutItemSchema = z.object({
  origin: z
    .string()
    .min(1)
    .describe("Widget origin from search_widgets. Mixing origins within one app is fine."),
  widget_id: z
    .string()
    .min(1)
    .describe("Widget id from search_widgets. Validated against the workspace catalog."),
  x: z.number().int().min(0).max(39).describe("Grid column, 0-based on a 40-column grid."),
  y: z.number().int().min(0).describe("Grid row, 0-based. Rows are 25px tall."),
  w: z
    .number()
    .int()
    .min(10)
    .max(40)
    .describe("Width out of 40: 40=full, 20=half, 13=third, 10=quarter."),
  h: z
    .number()
    .int()
    .min(4)
    .describe("Height in 25px rows. Min 4; 8-12 for charts/tables; 20+ for content-heavy."),
  state: z
    .object({
      params: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Pre-set parameter values for this widget instance, e.g. { symbol: 'AAPL' }."),
      chartView: z
        .object({
          enabled: z.boolean(),
          chartType: z.enum(["line", "bar", "pie", "scatter", "donut"]).optional(),
        })
        .optional()
        .describe("Flip a table widget into chart mode."),
    })
    .optional()
    .describe("Optional per-widget display pre-configuration."),
});

const tabSchema = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9-]+$/, "Tab id must be lowercase kebab-case")
    .describe("Unique lowercase kebab-case tab id, e.g. 'overview'."),
  name: z.string().min(1).describe("Human-readable tab name shown in the UI."),
  layout: z
    .array(layoutItemSchema)
    .min(1)
    .describe("Widgets placed on this tab. Walk y downward; do not overlap items."),
});

export const createAppSchema = z.object({
  display_summary: displaySummarySchema,
  name: z.string().min(1).max(80).describe("App display name."),
  description: z.string().min(1).max(500).describe("Short description of what the app shows."),
  tabs: z
    .array(tabSchema)
    .min(1)
    .max(6)
    .describe("Tabs grouped by theme. 1 for small apps, 2-4 typical, max 6."),
  prompts: z
    .array(z.string().min(1).max(200))
    .max(6)
    .optional()
    .describe("Optional 3-5 natural-language seed prompts users can click to query the app."),
});

export type CreateAppArgs = z.infer<typeof createAppSchema>;

export const createAppDescription =
  "Assemble the user's connected widgets into a multi-tab dashboard app that the user can " +
  "open as a live dashboard or save to their apps page. " +
  "Call search_widgets first to get valid (origin, widget_id) pairs — every widget is " +
  "validated against the workspace and unknown pairs are rejected. " +
  "Lay widgets out on a 40-column grid: w out of 40 (40=full, 20=half, 13=third, 10=quarter, " +
  "min 10); h in 25px rows (min 4; 8-12 for charts/tables; 20+ for content-heavy). " +
  "Walk y downward and avoid overlaps. " +
  "Tabs: 1 for small apps, 2-4 typical, max 6; tab ids are lowercase kebab-case and unique. " +
  "Ticker/symbol parameter sync across widgets is detected automatically — do not specify groups. " +
  DISPLAY_SUMMARY_TOOL_TEXT;

export interface CreateAppToolContext {
  allWidgets: Widget[];
  artifactQueue: SSEEvent[];
}

const widgetKey = (origin: string, widgetId: string): string => `${origin}::${widgetId}`;

/**
 * One ticker group spanning every widget that exposes a ticker/symbol param —
 * the workspace's universal ticker registry is a single group. Other shared
 * params are left to the workspace's implicit param auto-sync.
 */
function detectTickerGroups(
  widgetRefs: AppArtifactWidgetRef[],
  resolved: Map<string, Widget>,
): AppsJsonGroup[] {
  const widgetIds: string[] = [];
  const seen = new Set<string>();
  let defaultValue: string | undefined;

  for (const ref of widgetRefs) {
    const widget = resolved.get(widgetKey(ref.origin, ref.widget_id));
    if (!widget) continue;
    const tickerParam = widget.params.find((p) => {
      const name = p.name.toLowerCase();
      return name === "symbol" || name === "ticker" || p.type === "ticker";
    });
    if (!tickerParam) continue;
    if (!seen.has(ref.widget_id)) {
      seen.add(ref.widget_id);
      widgetIds.push(ref.widget_id);
    }
    if (defaultValue === undefined) {
      const value = tickerParam.current_value ?? tickerParam.default_value;
      if (typeof value === "string" && value.length > 0) defaultValue = value;
    }
  }

  if (widgetIds.length < 2) return [];
  return [{ name: "Group 1", type: "ticker", widgetIds, defaultValue: defaultValue ?? "AAPL" }];
}

export function runCreateApp(args: CreateAppArgs, ctx: CreateAppToolContext): string {
  const tabIds = new Set<string>();
  for (const t of args.tabs) {
    if (tabIds.has(t.id)) {
      return `Error: duplicate tab id "${t.id}". Tab ids must be unique.`;
    }
    tabIds.add(t.id);
  }

  // Resolve every (origin, widget_id) against the live catalog; flag misses and
  // within-tab duplicates (a tab's layout keys must be unique).
  const resolved = new Map<string, Widget>();
  const errors: string[] = [];
  for (const t of args.tabs) {
    const seenInTab = new Set<string>();
    for (const item of t.layout) {
      const key = widgetKey(item.origin, item.widget_id);
      if (seenInTab.has(key)) {
        errors.push(
          `tab "${t.id}" references (origin="${item.origin}", widget_id="${item.widget_id}") more than once`,
        );
        continue;
      }
      seenInTab.add(key);
      if (resolved.has(key)) continue;
      const widget = ctx.allWidgets.find(
        (w) => w.origin === item.origin && w.widget_id === item.widget_id,
      );
      if (widget) {
        resolved.set(key, widget);
      } else {
        errors.push(`unknown widget (origin="${item.origin}", widget_id="${item.widget_id}")`);
      }
    }
  }
  if (errors.length > 0) {
    return (
      `Error: cannot create app.\n- ${errors.join("\n- ")}\n` +
      "Call search_widgets to find valid (origin, widget_id) pairs, then retry."
    );
  }

  const tabs: Record<string, AppsJsonTab> = {};
  for (const t of args.tabs) {
    tabs[t.id] = {
      id: t.id,
      name: t.name,
      layout: t.layout.map((item) => ({
        i: item.widget_id,
        x: item.x,
        y: item.y,
        w: item.w,
        h: item.h,
        ...(item.state ? { state: item.state } : {}),
      })),
    };
  }

  const widgetRefs: AppArtifactWidgetRef[] = [];
  const refSeen = new Set<string>();
  for (const t of args.tabs) {
    for (const item of t.layout) {
      const key = widgetKey(item.origin, item.widget_id);
      if (refSeen.has(key)) continue;
      refSeen.add(key);
      const widget = resolved.get(key)!;
      widgetRefs.push({
        i: widget.widget_id,
        origin: widget.origin,
        widget_id: widget.widget_id,
        ...(widget.uuid ? { uuid: widget.uuid } : {}),
        name: widget.name,
      });
    }
  }

  const groups = detectTickerGroups(widgetRefs, resolved);

  const app: AppsJsonDef = {
    name: args.name,
    description: args.description,
    allowCustomization: true,
    tabs,
    groups,
    ...(args.prompts && args.prompts.length > 0 ? { prompts: args.prompts } : {}),
  };
  const artifact: AppArtifact = {
    type: "app",
    uuid: crypto.randomUUID(),
    name: args.name,
    description: args.description,
    app,
    widget_refs: widgetRefs,
  };
  ctx.artifactQueue.push(messageArtifact(artifact));

  logger.info("create_app emitted", {
    name: args.name,
    tabs: args.tabs.length,
    widgets: widgetRefs.length,
    groups: groups.length,
  });

  const widgetCount = widgetRefs.length;
  const tabCount = args.tabs.length;
  return (
    `Created app "${args.name}" with ${widgetCount} widget${widgetCount === 1 ? "" : "s"} across ` +
    `${tabCount} tab${tabCount === 1 ? "" : "s"}` +
    (groups.length > 0 ? " and an auto-synced ticker group" : "") +
    ". The app is rendered in the workspace with Open-as-dashboard and Save-to-apps actions. " +
    "Summarize what the app contains; do NOT repeat the layout JSON in your reply."
  );
}

export function makeCreateAppTool(ctx: CreateAppToolContext) {
  return tool({
    description: createAppDescription,
    inputSchema: createAppSchema,
    execute: async (args) => runCreateApp(args as CreateAppArgs, ctx),
  });
}
