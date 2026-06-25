/**
 * get_skill_content — load one skill body from the Workspace skill library.
 *
 * Mirrors workspace_mcp/server.py:1026-1037.
 */

import { z } from "zod";
import type { ContentItem } from "../../lib/typed";
import { bridgeManager } from "../../bridge/singleton";
import { executeBridgeCommand } from "../../bridge/execute";
import { describeTool } from "../../bridge/instructions";

export const getSkillContentSchema = {
  slug: z.string().describe(
    "Exact skill slug from the latest workspace snapshot.",
  ),
  reason: z.string().optional().describe(
    "Optional human-facing reason for loading this skill.",
  ),
} as const;

export const getSkillContentDescription = describeTool(
  "Load one skill body from the Workspace skill library.",
  "Pass the exact skill slug from the latest workspace snapshot.",
);

export async function getSkillContentHandler(args: {
  slug: string;
  reason?: string;
}): Promise<{ content: ContentItem[] }> {
  const { content } = await executeBridgeCommand(bridgeManager, {
    command: "get_skill_content",
    slug: args.slug,
    reason: args.reason ?? null,
  });
  return { content };
}
