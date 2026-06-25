import { existsSync } from "node:fs";
import { z } from "zod";
import { chromium } from "playwright";
import { createMermaidRenderer } from "mermaid-isomorphic";
import { artifactItem, errorItem, textItem, type ContentItem } from "../../lib/typed";

export const mermaidSchema = {
  name: z.string().describe("Display name for the diagram"),
  description: z.string().describe("What this diagram shows"),
  code: z
    .string()
    .describe(
      "Mermaid diagram syntax (e.g. graph TD, sequenceDiagram, stateDiagram-v2, classDiagram, erDiagram, gantt)",
    ),
};

const RENDER_TIMEOUT_MS = Number(process.env.MERMAID_RENDER_TIMEOUT_MS ?? 15_000);

/**
 * Forces SVG-native <text> labels. Mermaid v11 ignores `htmlLabels` when it
 * arrives via `mermaid.initialize` (mermaidOptions), but honors it as an init
 * directive in the diagram source. HTML labels render as <foreignObject>,
 * which the workspace's DOMPurify pass strips — every label would vanish.
 */
const INIT_DIRECTIVE =
  '%%{init: {"htmlLabels":false,"flowchart":{"htmlLabels":false},"class":{"htmlLabels":false},"state":{"htmlLabels":false}}}%%\n';

type RenderResult =
  | { ok: true; svg: string }
  | { ok: false; message: string; code: string };

async function renderMermaid(code: string): Promise<RenderResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Fresh renderer per render: reusing one instance across sequential calls
    // crashes under Bun when the lib's idle auto-close races the next render.
    const renderer = createMermaidRenderer();
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`render timed out after ${RENDER_TIMEOUT_MS}ms`)),
        RENDER_TIMEOUT_MS,
      );
    });
    const results = await Promise.race([renderer([INIT_DIRECTIVE + code]), timeout]);
    const settled = results[0];

    if (!settled) {
      return {
        ok: false,
        code: "MERMAID_RENDER_EMPTY",
        message: "Diagram rendering failed: empty render result.",
      };
    }
    if (settled.status === "rejected") {
      const reason =
        settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
      return {
        ok: false,
        code: "MERMAID_SYNTAX",
        message: `Mermaid syntax error: ${reason}. Fix the diagram syntax and call mermaid_diagram again.`,
      };
    }
    return { ok: true, svg: settled.value.svg };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      code: "MERMAID_RENDER_FAILED",
      message: `Diagram rendering failed: ${msg}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

function isFlowchartSource(code: string): boolean {
  return /^\s*(?:%%.*\n\s*)*(?:flowchart|graph)\s+/i.test(code);
}

function quoteLabel(label: string): string {
  const trimmed = label.trim();
  if (!trimmed || trimmed.startsWith('"') || trimmed.startsWith("'") || trimmed.startsWith("`")) {
    return label;
  }
  return `"${label.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function normalizeFlowchartLabels(code: string): string {
  if (!isFlowchartSource(code)) return code;
  return code.replace(
    /(\b[A-Za-z][\w-]*)\[([^\[\]\n"]+)\]/g,
    (_match, id: string, label: string) => `${id}[${quoteLabel(label)}]`,
  );
}

async function renderWithFlowchartLabelRecovery(code: string): Promise<RenderResult> {
  const first = await renderMermaid(code);
  if (first.ok) return first;

  const normalized = normalizeFlowchartLabels(code);
  if (normalized === code) return first;
  const recovered = await renderMermaid(normalized);
  return recovered.ok ? recovered : first;
}

/**
 * True when the Playwright Chromium binary is installed. The server only
 * registers `mermaid_diagram` when this passes; without the binary the tool
 * cannot render and should not be advertised to the model.
 */
export function mermaidRenderingAvailable(): boolean {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

/**
 * Explicit white background: the workspace renders html artifacts in a
 * transparent sandboxed iframe on a dark card, and the iframe height is
 * measured from the document's scrollHeight — the svg must size naturally.
 */
function wrapSvgInHtml(svg: string): string {
  return `<!DOCTYPE html>
<html>
<head>
<style>
  html,body{margin:0;padding:8px;background:#fff}
  svg{display:block;max-width:100%;height:auto;margin:0 auto}
</style>
</head>
<body>${svg}</body>
</html>`;
}

export async function mermaidHandler({
  name,
  description,
  code,
}: {
  name: string;
  description: string;
  code: string;
}): Promise<{ content: ContentItem[] }> {
  const rendered = await renderWithFlowchartLabelRecovery(code);
  if (!rendered.ok) {
    return {
      content: [
        errorItem({
          code: rendered.code,
          message: rendered.message,
          retryable: true,
        }),
      ],
    };
  }

  try {
    const svg = rendered.svg;
    if (svg.includes("<foreignObject")) {
      // Exotic diagram types can still emit HTML labels despite the init
      // directive; the workspace sanitizer would strip them, leaving blank
      // shapes. Fail loud so the model picks a supported diagram type.
      return {
        content: [
          errorItem({
            code: "MERMAID_UNSUPPORTED_DIAGRAM",
            message:
              "This diagram type produced HTML labels the workspace cannot display. Rewrite it as a flowchart, sequence, state, class, ER, gantt, pie, or mindmap diagram and call mermaid_diagram again.",
            retryable: true,
          }),
        ],
      };
    }

    const artifact = {
      type: "html",
      uuid: crypto.randomUUID(),
      name,
      description,
      content: wrapSvgInHtml(svg),
    };
    return {
      content: [
        artifactItem(artifact),
        textItem(
          `Rendered diagram "${name}" as an HTML artifact — displayed in the workspace. Do NOT repeat the Mermaid code in your text response; just explain what the diagram shows.`,
        ),
      ],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [
        errorItem({
          code: "MERMAID_RENDER_FAILED",
          message: `Diagram rendering failed: ${msg}`,
          retryable: true,
        }),
      ],
    };
  }
}

export const mermaidDescription =
  "Create a diagram using Mermaid syntax for flowcharts, sequence diagrams, state diagrams, class diagrams, ER diagrams, org charts, or any structural/conceptual visualization. " +
  "When the user asks to render a flowchart, product map, architecture/process map, or other structural/conceptual visualization, default to a Mermaid flowchart using `flowchart TD` with concise node labels and arrows. " +
  "For flowcharts, quote every display label as `node_id[\"Display Label\"]`, especially labels containing parentheses or punctuation, and prefer simple category nodes over linking edges directly to subgraph ids. " +
  "Output valid Mermaid syntax in the 'code' field — it is rendered to SVG server-side. Do NOT wrap Mermaid in HTML or call create_html_artifact for Mermaid diagrams. " +
  "Do NOT use for numeric data charts (line, bar, pie) — use create_artifact for those.";
