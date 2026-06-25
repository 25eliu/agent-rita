import { z } from "zod";

export const displaySummarySchema = z
  .string()
  .optional()
  .describe(
    "Display-only progress summary shown to the user before the tool runs. " +
      "Use a short human-readable gerund phrase, e.g. 'Checking renewable energy trend'. " +
      "The UI shows this directly as the progress message. " +
      "Do not put required tool inputs here; this value is not used for computation.",
  );

export const DISPLAY_SUMMARY_TOOL_TEXT =
  "Optional `display_summary` is shown directly as the progress message while the tool runs. " +
  "It is display-only and does not replace required arguments.";
