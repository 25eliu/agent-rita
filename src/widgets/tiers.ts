import type { QueryRequest, Widget, SnowflakeSchema } from "../protocol/types";

export type WidgetTier = "primary" | "secondary" | "extra";

export interface TieredWidget {
  widget: Widget;
  tier: WidgetTier;
}

const TIER_RANK: Record<WidgetTier, number> = {
  primary: 0,
  secondary: 1,
  extra: 2,
};

export function applyParamOverrides(
  widget: Widget,
  overrides: Record<string, unknown>,
): Widget {
  return {
    ...widget,
    params: widget.params.map((p) =>
      Object.prototype.hasOwnProperty.call(overrides, p.name)
        ? { ...p, current_value: overrides[p.name] }
        : p,
    ),
  };
}

export function getSqlSchema(widget: Widget): SnowflakeSchema | null {
  const raw = widget.metadata?.schema;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const s = raw as Record<string, unknown>;
  if (
    typeof s.tableName !== "string" ||
    typeof s.database !== "string" ||
    typeof s.schema !== "string" ||
    !Array.isArray(s.columns) ||
    !s.columns.every(
      (c: unknown) =>
        typeof c === "object" && c !== null &&
        typeof (c as Record<string, unknown>).name === "string" &&
        typeof (c as Record<string, unknown>).type === "string",
    )
  ) return null;
  return raw as unknown as SnowflakeSchema;
}

export function getSqlWidgets(
  widgets: Widget[],
): Array<{ widget: Widget; schema: SnowflakeSchema }> {
  return widgets.flatMap((w) => {
    const schema = getSqlSchema(w);
    return schema ? [{ widget: w, schema }] : [];
  });
}

export function getTieredWidgets(request: QueryRequest): TieredWidget[] {
  const out: TieredWidget[] = [];
  const tiers: WidgetTier[] = ["primary", "secondary", "extra"];
  for (const tier of tiers) {
    const list = request.widgets?.[tier] ?? [];
    for (const w of list) {
      // Catalog widgets that are not placed on a dashboard arrive with only a
      // widget_id slug and no instance uuid. Everything downstream (search
      // result identifiers, get_widget_data matching/emission, reboot
      // match-back, citations) keys on uuid, so fall back to widget_id as the
      // canonical id. Dashboard instances already carry a real uuid — leave
      // those untouched.
      out.push({ widget: w.uuid ? w : { ...w, uuid: w.widget_id }, tier });
    }
  }
  return out;
}

export function getAllWidgets(request: QueryRequest): Widget[] {
  return getTieredWidgets(request).map((t) => t.widget);
}

function normalizeSearchText(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function searchWidgets(
  tiered: TieredWidget[],
  query: string,
): TieredWidget[] {
  const terms = normalizeSearchText(query).split(/\s+/).filter(Boolean);
  if (!terms.length) {
    return [...tiered].sort((a, b) => {
      const tierDiff = TIER_RANK[a.tier] - TIER_RANK[b.tier];
      return tierDiff !== 0 ? tierDiff : a.widget.name.localeCompare(b.widget.name);
    });
  }

  const scored = tiered
    .map(({ widget, tier }) => {
      const searchable = [
        widget.name,
        widget.description,
        widget.category,
        widget.sub_category,
        widget.origin,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      const normalizedSearchable = normalizeSearchText(searchable);
      const hits = terms.filter((t) => searchable.includes(t)).length;
      const normalizedHits = terms.filter((t) => normalizedSearchable.includes(t)).length;
      return { widget, tier, hits: Math.max(hits, normalizedHits) };
    })
    .filter((s) => s.hits > 0)
    .sort((a, b) => {
      if (b.hits !== a.hits) return b.hits - a.hits;
      return TIER_RANK[a.tier] - TIER_RANK[b.tier];
    });

  return scored.map(({ widget, tier }) => ({ widget, tier }));
}
