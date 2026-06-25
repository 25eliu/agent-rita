import { widgetSelectionCases } from "./widget-selection";
import { sqlAnalysisCases } from "./sql-analysis";
import { intentCases } from "./intent";
import { workspaceContextCases } from "./workspace-context";
import { toolRoutingCases } from "./tool-routing";
import { localeCases } from "./locale";
import { citationsCases } from "./citations";
import { fileWidgetCases } from "./file-widgets";
import { skillsCases } from "./skills";
import { nativeToolsCases } from "./native-tools";
import { appBuilderCases } from "./app-builder";
import { mcpRoutingCases } from "./mcp-routing";
import { urlContextCases } from "./url-context";
import { streamingCases } from "./streaming";
import type { EvalCase } from "../runner";

export const ALL_CASES: EvalCase[] = [
  ...widgetSelectionCases,
  ...intentCases,
  ...workspaceContextCases,
  ...toolRoutingCases,
  ...sqlAnalysisCases,
  ...localeCases,
  ...citationsCases,
  ...fileWidgetCases,
  ...skillsCases,
  ...nativeToolsCases,
  ...appBuilderCases,
  ...mcpRoutingCases,
  ...urlContextCases,
  ...streamingCases,
];

export const CASE_GROUPS = {
  "widget-selection": widgetSelectionCases,
  intent: intentCases,
  "workspace-context": workspaceContextCases,
  "tool-routing": toolRoutingCases,
  "sql-analysis": sqlAnalysisCases,
  locale: localeCases,
  citations: citationsCases,
  "file-widgets": fileWidgetCases,
  skills: skillsCases,
  "native-tools": nativeToolsCases,
  "app-builder": appBuilderCases,
  "mcp-routing": mcpRoutingCases,
  "url-context": urlContextCases,
  streaming: streamingCases,
} as const;
