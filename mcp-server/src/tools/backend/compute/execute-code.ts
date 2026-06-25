/**
 * execute_code — runs arbitrary Python in the conversation's compute sandbox.
 *
 * Two artifact channels:
 *
 *  1. `rita.show(fig|df, ...)` — emits null-byte-framed JSON sentinels on
 *     stdout. We scan the run output, splitting plain text from sentinels
 *     and emitting them in original order so the model's narrative stays
 *     interleaved with its charts/tables. Supports:
 *       - plotly.graph_objects.Figure  -> interactive HTML (CDN plotly.js)
 *       - matplotlib.figure.Figure     -> base64 PNG <img>
 *       - pandas.DataFrame             -> TableArtifact
 *
 *  2. Daytona's built-in `result.artifacts.charts` — auto-extracts charts
 *     produced by `plt.show()`. Each comes back with `png` (base64) plus
 *     metadata. We emit each as an html artifact appended after stdout.
 *     This catches the common `plt.plot(...); plt.show()` pattern even
 *     when the user didn't call `rita.show`.
 *
 * The DuckDB connection at `/tmp/rita.db` is implicit. User code can:
 *   import duckdb
 *   con = duckdb.connect("/tmp/rita.db")
 *   df = con.execute("SELECT ... FROM bonds").fetchdf()
 *   rita.show(df, name="Bond yields")
 */

import { z } from "zod";
import { artifactItem, sandboxMetaItem, textItem, type ContentItem } from "../../../lib/typed";
import { prepareCompute } from "./data-bridge";
import { dropSandbox } from "./sandbox";
import { getLogger } from "../../../lib/logger";

/**
 * Daytona auto-stops sandboxes after AUTO_STOP_MINUTES idle. Once stopped,
 * the cached `Sandbox` reference is dead — uploadFile / executeCommand /
 * codeRun all fail with this signature. Detect, drop the cache entry,
 * recreate from scratch on retry.
 */
function isStoppedSandboxError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes("failed to resolve container IP") ||
    msg.includes("Is the Sandbox started") ||
    msg.includes("sandbox is not running")
  );
}

const logger = getLogger(["mcp", "compute", "execute_code"]);

const CODE_TIMEOUT_SEC = 120;
const MAX_TEXT_CHARS = 8000;

const SENTINEL_HEAD = "\x00__x_agentrita_artifact__\x00";
const SENTINEL_TAIL = "\x00";

// Daytona's codeRun does NOT preserve sys.path across calls. The init step
// adds /tmp (where rita.py is uploaded) but that's lost on each user codeRun.
// Prepend a small shim so `import rita` always resolves.
const USER_CODE_PREAMBLE =
  'import sys as __agentrita_sys\n' +
  'if "/tmp" not in __agentrita_sys.path:\n' +
  '    __agentrita_sys.path.insert(0, "/tmp")\n' +
  'del __agentrita_sys\n';

export const executeCodeSchema = {
  code: z.string().describe(
    "Python code to execute in the sandbox. State (variables, imports, files) persists across calls in the same conversation. " +
      "DuckDB is preconnected at /tmp/rita.db with all loaded tables. Pre-installed: duckdb, pandas, numpy, plotly, matplotlib, scipy. " +
      "Use `import rita; rita.show(fig_or_df, name='...')` to render charts/tables in the conversation.",
  ),
  "x-agentrita-conversation-id": z
    .string()
    .optional()
    .describe("INTERNAL — populated by agent decoration. Do not set."),
  "x-agentrita-tables": z
    .record(z.string(), z.array(z.unknown()))
    .optional()
    .describe("INTERNAL — populated by agent decoration. Do not set."),
};

export const executeCodeDescription =
  "Execute Python code in a persistent compute sandbox. " +
  "Loaded tables from this conversation are queryable via DuckDB at /tmp/rita.db. " +
  "DuckDB matches column names case-insensitively in SQL, but the DataFrame returned by .df() preserves the stored column case and pandas indexing IS case-sensitive — read names from df.columns instead of assuming lowercase. " +
  "Render charts and tables inline by calling `rita.show(fig_or_df, name='...')`. " +
  "Use this for statistics, custom transformations, plotly charts, scipy/numpy work, or anything beyond plain SQL.";

// LogTape parses `{...}` in message strings as property placeholders — raw
// braces in logged Python code / stdout (f-strings, dicts, tracebacks) render
// as `undefined` and make the logs lie about what executed. Double them.
function logSafe(text: string): string {
  return text.replaceAll("{", "{{").replaceAll("}", "}}");
}

interface RitaArtifactPayload {
  kind: "html" | "table";
  name?: string;
  caption?: string;
  content?: string;
  rows?: Record<string, unknown>[];
}

interface ParsedSegment {
  kind: "text" | "artifact";
  text?: string;
  artifact?: RitaArtifactPayload;
}

function parseStdout(stdout: string): ParsedSegment[] {
  const segments: ParsedSegment[] = [];
  let pos = 0;
  while (pos < stdout.length) {
    const start = stdout.indexOf(SENTINEL_HEAD, pos);
    if (start === -1) {
      const tail = stdout.slice(pos);
      if (tail) segments.push({ kind: "text", text: tail });
      break;
    }
    if (start > pos) segments.push({ kind: "text", text: stdout.slice(pos, start) });

    const payloadStart = start + SENTINEL_HEAD.length;
    const tailIdx = stdout.indexOf(SENTINEL_TAIL, payloadStart);
    if (tailIdx === -1) {
      // unterminated — treat the rest as text and bail
      segments.push({ kind: "text", text: stdout.slice(start) });
      break;
    }
    const b64 = stdout.slice(payloadStart, tailIdx);
    try {
      const decoded = Buffer.from(b64, "base64").toString("utf-8");
      const parsed = JSON.parse(decoded) as RitaArtifactPayload;
      segments.push({ kind: "artifact", artifact: parsed });
    } catch {
      segments.push({ kind: "text", text: stdout.slice(start, tailIdx + 1) });
    }
    pos = tailIdx + 1;
  }
  return segments;
}

function buildArtifactFromPayload(payload: RitaArtifactPayload): Record<string, unknown> | null {
  const uuid = crypto.randomUUID();
  const name = payload.name?.trim() || (payload.kind === "table" ? "Table" : "Chart");
  const description = payload.caption?.trim() || name;

  if (payload.kind === "html") {
    if (!payload.content) return null;
    return {
      type: "html",
      uuid,
      name,
      description,
      content: payload.content,
    };
  }
  if (!payload.rows || payload.rows.length === 0) return null;
  return {
    type: "table",
    uuid,
    name,
    description,
    content: payload.rows,
  };
}

interface DaytonaChart {
  type?: string;
  title?: string;
  png?: string;
  x_label?: string;
  y_label?: string;
}

function chartToArtifact(chart: DaytonaChart, idx: number): Record<string, unknown> | null {
  if (!chart.png) return null;
  const uuid = crypto.randomUUID();
  const name = chart.title?.trim() || `Chart ${idx + 1}`;
  const description = [chart.x_label, chart.y_label].filter(Boolean).join(" vs ") || name;
  return {
    type: "html",
    uuid,
    name,
    description,
    content: `<img src="data:image/png;base64,${chart.png}" alt="${description.replace(/"/g, "&quot;")}" style="max-width:100%;height:auto">`,
  };
}

function trimText(s: string): string {
  if (s.length <= MAX_TEXT_CHARS) return s;
  return s.slice(0, MAX_TEXT_CHARS) + `\n\n[... truncated, ${s.length - MAX_TEXT_CHARS} more chars ...]`;
}

export async function executeCodeHandler(args: {
  code: string;
  "x-agentrita-conversation-id"?: string;
  "x-agentrita-tables"?: Record<string, unknown[]>;
}): Promise<{ content: ContentItem[] }> {
  const startedAt = Date.now();
  const conversationId = args["x-agentrita-conversation-id"];
  const deltaTables = args["x-agentrita-tables"]
    ? Object.entries(args["x-agentrita-tables"]).map(([n, r]) => ({ name: n, rows: r.length }))
    : [];

  logger.info(
    `execute_code entry conversationId=${conversationId ?? "(missing)"} codeChars=${args.code.length} deltaTables=${deltaTables.length} deltaRows=${deltaTables.reduce((s, t) => s + t.rows, 0)}\n--- CODE ---\n${logSafe(args.code.slice(0, 1500))}${args.code.length > 1500 ? "\n... [truncated]" : ""}\n--- /CODE ---`,
    {
      conversationId: conversationId ?? "(missing)",
      codePreview: args.code.slice(0, 200),
      codeChars: args.code.length,
      deltaTables,
      deltaRows: deltaTables.reduce((s, t) => s + t.rows, 0),
    },
  );

  if (!conversationId) {
    logger.warn("execute_code missing conversation id", {});
    return {
      content: [
        textItem(
          "COMPUTE_PERMANENTLY_UNAVAILABLE: this session is missing the conversation identifier required to attach a sandbox. " +
            "Do NOT retry execute_sql or execute_code in this session — they will keep failing the same way. " +
            "Answer the user from the data preview already in your context (column types, first 5 rows). " +
            "If the preview isn't enough, tell the user that compute is unavailable and ask them to retry with a fresh chat.",
        ),
      ],
    };
  }

  let prep;
  try {
    prep = await prepareCompute(args as Record<string, unknown>);
  } catch (err) {
    if (isStoppedSandboxError(err)) {
      logger.warn(
        `execute_code prepare hit stopped sandbox — dropping and recreating conversationId=${conversationId}`,
        { conversationId },
      );
      dropSandbox(conversationId);
      try {
        prep = await prepareCompute(args as Record<string, unknown>);
      } catch (retryErr) {
        const msg = retryErr instanceof Error ? retryErr.message : String(retryErr);
        const stack =
          retryErr instanceof Error && retryErr.stack
            ? retryErr.stack.split("\n").slice(0, 5).join(" | ")
            : "";
        logger.error(
          `execute_code prepare retry failed: ${msg}${stack ? ` | stack: ${stack}` : ""}`,
          { conversationId },
        );
        return { content: [textItem(`Compute unavailable: ${msg}`)] };
      }
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      const stack =
        err instanceof Error && err.stack
          ? err.stack.split("\n").slice(0, 5).join(" | ")
          : "";
      logger.error(
        `execute_code prepare failed: ${msg}${stack ? ` | stack: ${stack}` : ""}`,
        { conversationId },
      );
      return { content: [textItem(`Compute unavailable: ${msg}`)] };
    }
  }

  const runStart = Date.now();
  let runResult;
  try {
    runResult = await prep.sandbox.process.codeRun(
      USER_CODE_PREAMBLE + args.code,
      {},
      CODE_TIMEOUT_SEC,
    );
  } catch (err) {
    dropSandbox(prep.conversationId);
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`execute_code codeRun failed: ${msg}`, { conversationId });
    return { content: [textItem(`Compute execution failed: ${msg}`)] };
  }
  const runMs = Date.now() - runStart;

  const stdout = runResult.result ?? runResult.artifacts?.stdout ?? "";
  const exitCode = runResult.exitCode ?? 0;
  const segments = parseStdout(stdout);

  // Sandbox identity ride-along, prepended to the user-visible items at every
  // return point below. The agent reads it on re-POST to detect Daytona
  // sandbox recreation between calls and reset its tablesShipped set. The
  // item is silent — `processMcpResult` dispatches it without adding
  // model-facing text.
  const sandboxMeta = sandboxMetaItem(prep.sandbox.id);
  const items: ContentItem[] = [];
  const loadedSummary = prep.loaded.length > 0
    ? `[Loaded ${prep.loaded.map((l) => `"${l.tableName}" (${l.rowCount})`).join(", ")} into compute sandbox]\n\n`
    : "";

  let textBuf = loadedSummary;
  for (const seg of segments) {
    if (seg.kind === "text" && seg.text) {
      textBuf += seg.text;
      continue;
    }
    if (seg.kind === "artifact" && seg.artifact) {
      const built = buildArtifactFromPayload(seg.artifact);
      if (built) {
        if (textBuf.trim()) items.push(textItem(trimText(textBuf)));
        textBuf = "";
        items.push(artifactItem(built));
      }
    }
  }

  // Daytona auto-extracted matplotlib charts (from plt.show() calls)
  const autoCharts = (runResult.artifacts?.charts ?? []) as DaytonaChart[];
  for (let i = 0; i < autoCharts.length; i++) {
    const artifact = chartToArtifact(autoCharts[i], i);
    if (artifact) {
      if (textBuf.trim()) items.push(textItem(trimText(textBuf)));
      textBuf = "";
      items.push(artifactItem(artifact));
    }
  }

  if (textBuf.trim()) items.push(textItem(trimText(textBuf)));

  if (exitCode !== 0 && items.length === 0) {
    logger.warn("execute_code exited with no output", {
      conversationId,
      exitCode,
      runMs,
      totalMs: Date.now() - startedAt,
    });
    return {
      content: [
        sandboxMeta,
        textItem(`Code execution exited with code ${exitCode} and no output.`),
      ],
    };
  }
  if (exitCode !== 0) {
    items.push(textItem(`[Process exited with code ${exitCode}]`));
  }
  if (items.length === 0) {
    items.push(textItem("[No output]"));
  }

  const ritaArtifactCount = segments.filter((s) => s.kind === "artifact").length;
  const autoChartCount = autoCharts.length;
  // Replace whole sentinels (head marker + payload + tail), not just the head
  // pair — otherwise the base64 payload floods the preview and buries the
  // text that matters. On failure, show the END of stdout: tracebacks live
  // at the tail.
  const stdoutClean = stdout.replace(
    /\x00__x_agentrita_artifact__\x00[^\x00]*\x00/g,
    "<artifact>",
  );
  const stdoutPreview = stdoutClean.length === 0
    ? "(empty)"
    : exitCode !== 0
      ? (stdoutClean.length > 800 ? "... [head truncated]\n" : "") + stdoutClean.slice(-800)
      : stdoutClean.slice(0, 800) + (stdoutClean.length > 800 ? "\n... [truncated]" : "");
  const content = [sandboxMeta, ...items];
  logger.info(
    `execute_code exit exitCode=${exitCode} runMs=${runMs} totalMs=${Date.now() - startedAt} stdoutChars=${stdout.length} ritaArtifacts=${ritaArtifactCount} matplotlibCharts=${autoChartCount} totalItems=${content.length} loadedTables=${prep.loaded.length}\n--- STDOUT ---\n${logSafe(stdoutPreview)}\n--- /STDOUT ---`,
    {
      conversationId,
      exitCode,
      runMs,
      totalMs: Date.now() - startedAt,
      stdoutChars: stdout.length,
      ritaArtifacts: ritaArtifactCount,
      matplotlibCharts: autoChartCount,
      totalItems: content.length,
      loadedTables: prep.loaded.length,
    },
  );
  return { content };
}
