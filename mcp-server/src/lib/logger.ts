/**
 * LogTape setup for the rita-tools MCP server. Mirrors src/lib/logger.ts on
 * the agent side so logs across both processes share the same shape and can
 * be grep'd by conversationId for end-to-end traces.
 *
 * Category root is `mcp` (vs agent's `app`) so logs can be told apart.
 */

import {
  configure,
  getConsoleSink,
  getLogger,
  jsonLinesFormatter,
} from "@logtape/logtape";
import { honoLogger as createHonoLogger } from "@logtape/hono";

const isDev = process.env.NODE_ENV !== "production";

// Idempotent: in tests, both this file and src/lib/logger.ts may be imported
// in the same process. LogTape's `configure()` throws on second call; first
// one wins. In dev/prod the two loggers run in separate processes so this
// never matters at runtime.
try {
  await configure({
    sinks: {
      console: isDev
        ? getConsoleSink()
        : getConsoleSink({ formatter: jsonLinesFormatter }),
    },
    loggers: [
      { category: ["logtape", "meta"], lowestLevel: "warning" },
      { category: ["mcp"], sinks: ["console"], lowestLevel: "debug" },
      { category: ["hono"], sinks: ["console"], lowestLevel: "info" },
    ],
  });
} catch {
  // Already configured by another module load — fine.
}

export { getLogger };
export const honoLogger = createHonoLogger({ category: ["hono"] });
