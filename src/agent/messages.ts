import type { ModelMessage } from "ai";
import type { QueryRequest, ToolMessage, WorkspaceState } from "../protocol/types";
import { buildSystemPrompt, type PromptOptions } from "./prompt";
import { stripPlaceholderTags } from "../protocol/events";
import { renderToolResultForHistory } from "../mcp/results";
import { WORKSPACE_BRIDGE_COMMAND_NAMES } from "../protocol/bridge-commands";

export interface BuildMessagesOptions extends PromptOptions {
  workspaceState?: WorkspaceState | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJsonEnvelope(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function isInternalProtocolEnvelope(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length > 0 && value.every(isInternalProtocolEnvelope);
  }
  if (!isRecord(value)) return false;

  if (
    typeof value.function === "string" &&
    isRecord(value.input_arguments)
  ) {
    return true;
  }

  if (
    typeof value.event === "string" &&
    value.event.startsWith("copilot") &&
    isRecord(value.data)
  ) {
    return true;
  }

  return false;
}

function sanitizeAssistantContent(content: string): string | null {
  const parsed = parseJsonEnvelope(content);
  if (isInternalProtocolEnvelope(parsed)) return null;

  const cleaned = stripPlaceholderTags(content).trim();
  return cleaned.length > 0 ? cleaned : null;
}

// A workspace bridge result re-POST carries `data: [{ status, message, ... }]`.
// Render just the outcome line so an EARLIER bridge call in the turn (e.g. one
// of many queued update_widget drains) stays in the model's memory — otherwise
// the final turn sees only the last result and under-reports / re-issues
// finished mutations. The LAST bridge result is injected separately, in full,
// by injectFromReboot.
function renderBridgeResultForHistory(toolMsg: ToolMessage): string | null {
  const first = toolMsg.data?.[0] as Record<string, unknown> | undefined;
  if (!first || typeof first !== "object") return null;
  const status = typeof first.status === "string" ? first.status : null;
  const message = typeof first.message === "string" ? first.message : null;
  if (!status && !message) return null;
  return [status, message].filter(Boolean).join(": ");
}

export function buildMessages(
  request: QueryRequest,
  options?: BuildMessagesOptions,
): ModelMessage[] {
  const messages: ModelMessage[] = [
    { role: "system", content: buildSystemPrompt(request, options) },
  ];

  const selectedSkills = request.selected_skills ?? [];
  if (selectedSkills.length > 0) {
    const skillBlocks = selectedSkills
      .map((s) => `<skill name="${s.slug}">\n${s.contentMarkdown}\n</skill>`)
      .join("\n\n");
    messages.push({
      role: "user",
      content: `The user has activated the following skills. Follow their instructions:\n\n${skillBlocks}`,
    });
  }

  const history = request.messages;
  for (let i = 0; i < history.length; i++) {
    const msg = history[i];
    if (msg.role === "human") {
      messages.push({ role: "user", content: msg.content as string });
    } else if (msg.role === "ai" && typeof msg.content === "string") {
      const content = sanitizeAssistantContent(msg.content);
      if (content) messages.push({ role: "assistant", content });
    } else if (
      msg.role === "tool" &&
      msg.function === "execute_agent_tool" &&
      i < history.length - 1
      // The LAST tool message is the live round-trip result — the loop injects
      // it with full fidelity (state effects included) via injectFromReboot.
      // Everything earlier is rendered here, text-only, so the model keeps
      // memory of what each prior call in the turn did (artifacts delivered,
      // errors hit) instead of re-running finished work.
    ) {
      const toolMsg = msg as ToolMessage;
      const rendered = renderToolResultForHistory(toolMsg);
      if (rendered) {
        const rawName = toolMsg.input_arguments?.tool_name;
        const toolName = typeof rawName === "string" ? rawName : "unknown";
        messages.push({
          role: "user",
          content: `Earlier tool result from ${toolName}:\n\n${rendered}`,
        });
      }
    } else if (
      msg.role === "tool" &&
      WORKSPACE_BRIDGE_COMMAND_NAMES.has(msg.function) &&
      i < history.length - 1
      // Same rule as execute_agent_tool above: earlier bridge results stay in
      // history so the model remembers each mutation it already made (the rest
      // of a queued update_widget drain), instead of re-issuing finished work.
      // The last bridge result is injected live by injectFromReboot.
    ) {
      const toolMsg = msg as ToolMessage;
      const rendered = renderBridgeResultForHistory(toolMsg);
      if (rendered) {
        const args = JSON.stringify(toolMsg.input_arguments ?? {});
        messages.push({
          role: "user",
          content: `Earlier workspace bridge result from ${toolMsg.function} (${args}): ${rendered}`,
        });
      }
    }
  }

  return messages;
}
