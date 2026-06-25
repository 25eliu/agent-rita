import type { ImagePart, FilePart } from "ai";
import * as XLSX from "xlsx";
import type { Widget, ToolMessage } from "../protocol/types";
import { getLogger } from "../lib/logger";

const logger = getLogger(["app", "widgets"]);

export type FileKind = "image" | "pdf" | "csv" | "xlsx" | "text";

/**
 * Test-only export. Internal classification is the contract worth pinning:
 * data_type wins; CSV/XLSX inferred from URL suffix when no data_format;
 * docx / html / unknown types fall through to the text path (RAG handles
 * heavy formats via the MCP query_documents path).
 */
export function _classifyItem(
  dataFormat?: Record<string, string>,
  url?: string,
): FileKind {
  const dt = dataFormat?.data_type?.toLowerCase();
  if (dt === "jpg" || dt === "jpeg" || dt === "png") return "image";
  if (dt === "pdf") return "pdf";
  if (dt === "csv" || url?.endsWith(".csv")) return "csv";
  if (
    dt === "xlsx" ||
    dt === "xls" ||
    url?.endsWith(".xlsx") ||
    url?.endsWith(".xls")
  )
    return "xlsx";
  return "text";
}

/** Test-only export. */
export function _xlsxToJson(buf: ArrayBuffer | Buffer): string {
  return xlsxToJson(buf);
}

function xlsxToJson(buf: ArrayBuffer | Buffer): string {
  const wb = XLSX.read(buf, { type: "buffer" });
  const firstSheetName = wb.SheetNames[0];
  if (!firstSheetName) return "[]";
  const sheet = wb.Sheets[firstSheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: null });
  return JSON.stringify(rows);
}

/** Test-only export — see `_classifyItem`. */
export function _imageMediaType(dt: string): "image/jpeg" | "image/png" {
  if (dt === "png") return "image/png";
  return "image/jpeg";
}

const MAX_PDF_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_B64_CHARS = 5 * 1024 * 1024;

export type MediaPart = ImagePart | FilePart;

export interface WidgetItem {
  name: string;
  uuid: string;
  content: string;
  parts?: MediaPart[];
  widget?: Widget;
  inputArgs?: Record<string, unknown>;
}

const classifyItem = _classifyItem;
const imageMediaType = _imageMediaType;

/**
 * Test-only export. Inline minimal CSV → JSON converter. Note: does NOT
 * handle escaped double-quotes (`""` inside a quoted field) — the bare
 * `"` flips inQuotes state. Documented gap; covered by a regression
 * test pinning current behavior.
 */
export function _csvToJson(csv: string): string {
  return csvToJson(csv);
}

function csvToJson(csv: string): string {
  const lines = csv.trim().split("\n");
  if (lines.length < 2) return "[]";

  const parseRow = (line: string): string[] => {
    const result: string[] = [];
    let current = "";
    let inQuotes = false;
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      if (ch === '"') {
        inQuotes = !inQuotes;
      } else if (ch === "," && !inQuotes) {
        result.push(current.trim());
        current = "";
      } else {
        current += ch;
      }
    }
    result.push(current.trim());
    return result;
  };

  const headers = parseRow(lines[0].replace(/^﻿/, ""));
  const rows: Record<string, unknown>[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const values = parseRow(lines[i]);
    const row: Record<string, unknown> = {};
    for (let j = 0; j < headers.length; j++) {
      const val = values[j] ?? "";
      const num = Number(val);
      row[headers[j]] = val !== "" && !isNaN(num) ? num : val;
    }
    rows.push(row);
  }
  return JSON.stringify(rows);
}

export async function extractWidgetItems(
  toolMsg: ToolMessage,
  allWidgets: Widget[],
): Promise<WidgetItem[]> {
  const items: WidgetItem[] = [];
  const queries =
    (toolMsg.input_arguments?.data_sources as Array<{
      widget_uuid: string;
      input_args?: Record<string, unknown>;
    }>) ?? [];

  logger.debug("extractWidgetItems called", {
    dataLength: toolMsg.data?.length ?? 0,
    queriesLength: queries.length,
  });

  if (!toolMsg.data || toolMsg.data.length === 0) return items;

  for (let i = 0; i < toolMsg.data.length; i++) {
    const uuid = queries[i]?.widget_uuid ?? `unknown_${i}`;
    const widget = allWidgets.find((w) => w.uuid === uuid);
    if (!widget) {
      logger.warn(
        `Widget lookup miss idx=${i} uuid=${uuid} allWidgetsCount=${allWidgets.length} firstUuids=${allWidgets.slice(0, 5).map((w) => w.uuid ?? "(no uuid)").join(",")}`,
        {
          index: i,
          lookupUuid: uuid,
          queriesShape: queries[i] ? Object.keys(queries[i] as Record<string, unknown>) : null,
          allWidgetsCount: allWidgets.length,
          firstWidgetUuids: allWidgets.slice(0, 10).map((w) => w.uuid ?? "(no uuid)"),
        },
      );
    }
    const dataEntry = toolMsg.data[i];
    const rawItems = dataEntry.items ?? [];

    const contentParts: string[] = [];
    const mediaParts: MediaPart[] = [];

    for (const item of rawItems) {
      const raw = item as Record<string, unknown>;
      const dataFormat = raw.data_format as Record<string, string> | undefined;
      const url = typeof raw.url === "string" ? raw.url : undefined;
      const kind = classifyItem(dataFormat, url);

      if (typeof raw.content === "string" && raw.content) {
        if (kind === "image") {
          if (raw.content.length > MAX_IMAGE_B64_CHARS) {
            logger.warn("Image too large, skipping", { b64Chars: raw.content.length });
          } else {
            logger.debug("Inline image", { dataType: dataFormat?.data_type });
            mediaParts.push({
              type: "image",
              image: raw.content,
              mediaType: imageMediaType(dataFormat?.data_type ?? ""),
            });
          }
        } else if (kind === "pdf") {
          const approxBytes = (raw.content.length * 3) / 4;
          if (approxBytes > MAX_PDF_BYTES) {
            logger.warn("PDF too large, skipping", { approxMb: Math.round(approxBytes / 1024 / 1024) });
          } else {
            logger.debug("Inline PDF", { filename: dataFormat?.filename ?? "unknown" });
            mediaParts.push({
              type: "file",
              data: raw.content,
              mediaType: "application/pdf",
              filename: dataFormat?.filename,
            });
          }
        } else if (kind === "xlsx") {
          try {
            const buf = Buffer.from(raw.content, "base64");
            const json = xlsxToJson(buf);
            contentParts.push(json);
            logger.debug("Inline XLSX converted to JSON", { chars: json.length });
          } catch (e) {
            logger.error("Failed to parse inline XLSX", { error: e });
          }
        } else {
          contentParts.push(raw.content);
        }
      } else if (url) {
        if (kind === "image") {
          logger.debug("Image URL reference", { url: url.slice(0, 80) });
          mediaParts.push({
            type: "image",
            image: new URL(url),
          });
        } else if (kind === "pdf") {
          logger.debug("Fetching PDF URL", { url: url.slice(0, 80) });
          try {
            const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
            if (res.ok) {
              const buf = await res.arrayBuffer();
              if (buf.byteLength > MAX_PDF_BYTES) {
                logger.warn("Fetched PDF too large, skipping", { sizeMb: Math.round(buf.byteLength / 1024 / 1024) });
              } else {
                const b64 = Buffer.from(buf).toString("base64");
                mediaParts.push({
                  type: "file",
                  data: b64,
                  mediaType: "application/pdf",
                  filename: dataFormat?.filename ?? url.split("/").pop(),
                });
              }
            }
          } catch (e) {
            logger.error("Failed to fetch PDF", { url, error: e });
          }
        } else if (kind === "xlsx") {
          logger.debug("Fetching XLSX URL", { url: url.slice(0, 80) });
          try {
            const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
            if (res.ok) {
              const buf = await res.arrayBuffer();
              const json = xlsxToJson(Buffer.from(buf));
              contentParts.push(json);
              logger.debug("XLSX converted to JSON", { chars: json.length });
            }
          } catch (e) {
            logger.error("Failed to fetch XLSX", { url, error: e });
          }
        } else {
          const isCsv = kind === "csv";
          logger.debug("Fetching data URL", { url: url.slice(0, 80), isCsv });
          try {
            const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
            if (res.ok) {
              const text = await res.text();
              if (isCsv) {
                const json = csvToJson(text);
                contentParts.push(json);
                logger.debug("CSV converted to JSON", { chars: json.length });
              } else {
                contentParts.push(text);
                logger.debug("Fetched text content", { chars: text.length });
              }
            }
          } catch (e) {
            logger.error("Failed to fetch URL", { url, error: e });
          }
        }
      }
    }

    const content = contentParts.join("\n");
    const hasParts = mediaParts.length > 0;
    if (hasParts || content.trim()) {
      items.push({
        name: widget?.name ?? `widget_${i}`,
        uuid,
        content,
        parts: hasParts ? mediaParts : undefined,
        widget: widget ?? undefined,
        inputArgs: queries[i]?.input_args,
      });
    }
  }
  return items;
}
