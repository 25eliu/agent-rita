import { tool } from "ai";
import { z } from "zod";

export const getSkillContentSchema = z.object({
  slug: z.string().describe("The slug of the skill to load"),
  reason: z
    .string()
    .optional()
    .describe("Brief explanation of why this skill is relevant"),
});

export function makeGetSkillContentTool() {
  return tool({
    description:
      "Load the full content of a skill by its slug. Skills provide specialized instructions and workflows. " +
      "Use this when the user's request matches a skill's description in the available skills list.",
    inputSchema: getSkillContentSchema,
  });
}
