import type { Citation, Widget } from "./types";
import type { McpCitation } from "../mcp/results";

export interface CitedWidget {
  widget: Widget;
  inputArgs: Record<string, unknown>;
  widgetUuid?: string;
}

export async function buildAllCitations(
  citedWidgets: Map<string, CitedWidget>,
  mcpCitations: McpCitation[],
  intermediateCitations: Citation[],
): Promise<Citation[]> {
  const widgetCits = citedWidgets.size > 0 ? await buildWidgetCitations(citedWidgets) : [];
  const mcpCits = buildMcpCitations(mcpCitations);
  return dedupeCitations([...intermediateCitations, ...widgetCits, ...mcpCits]);
}

export async function citationUuid(
  widgetUuid: string,
  inputArgs: Record<string, unknown>,
): Promise<string> {
  const sortedArgs = Object.keys(inputArgs)
    .sort()
    .reduce<Record<string, unknown>>((a, k) => {
      a[k] = inputArgs[k];
      return a;
    }, {});
  const canonical = JSON.stringify([widgetUuid, sortedArgs]);
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(canonical));
  const b = new Uint8Array(buf);
  b[6] = (b[6] & 0x0f) | 0x50;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export async function buildWidgetCitations(
  citedWidgets: Map<string, CitedWidget>,
): Promise<Citation[]> {
  const citations: Citation[] = [];
  for (const [mapKey, { widget, inputArgs, widgetUuid }] of citedWidgets) {
    const sourceWidgetUuid = widgetUuid ?? mapKey;
    const id = await citationUuid(sourceWidgetUuid, inputArgs);
    const filteredArgs: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(inputArgs)) {
      if (v != null && v !== "") filteredArgs[k] = v;
    }
    if (widget.widget_id.startsWith("file-")) {
      const ext = (widget.metadata?.extension as string | undefined);
      citations.push({
        id,
        source_info: {
          type: "file",
          name: widget.name,
          citable: true,
        },
        details: [{
          Filename: widget.name,
          ...(ext ? { Extension: ext } : {}),
        }],
        signature: "",
      });
      continue;
    }
    citations.push({
      id,
      source_info: {
        type: "widget",
        uuid: id,
        origin: widget.origin,
        widget_id: widget.widget_id,
        name: widget.name,
        description: widget.description,
        metadata: { input_args: filteredArgs, widget_uuid: sourceWidgetUuid },
        citable: true,
      },
      details: [{
        "Source type": "widget",
        Origin: widget.origin,
        "Data source": widget.name,
        ...filteredArgs,
      }],
      signature: "",
    });
  }
  return citations;
}

export function buildMcpCitations(mcpCitations: McpCitation[]): Citation[] {
  return mcpCitations.map((c) => {
    if (c.type === "web") {
      return {
        id: c.id,
        source_info: { type: "web" as const, name: c.title, citable: true as const },
        details: [{ link: c.url, title: c.title }],
        signature: "",
      };
    }
    return {
      id: c.id,
      source_info: { type: "web" as const, name: c.title, citable: true as const },
      details: [{ link: c.uri, title: c.title, ...(c.page != null ? { page: c.page } : {}) }],
      signature: "",
    };
  });
}

export function dedupeCitations(citations: Citation[]): Citation[] {
  const seen = new Map<string, Citation>();
  for (const c of citations) {
    let key: string;
    if (c.source_info.type === "widget") {
      key = `widget|${c.source_info.metadata.widget_uuid}|${JSON.stringify(c.source_info.metadata.input_args)}`;
    } else if (c.source_info.type === "file") {
      const filename = (c.details[0]?.Filename as string | undefined) ?? c.source_info.name;
      const page = c.details[0]?.Page;
      key = `file|${filename}|${page ?? ""}`;
    } else {
      key = `web|${(c.details[0]?.link as string | undefined) ?? c.id}`;
    }
    if (!seen.has(key)) seen.set(key, c);
  }
  return Array.from(seen.values());
}
