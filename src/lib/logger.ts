import {
  configure,
  getConsoleSink,
  getLogger,
  jsonLinesFormatter,
} from "@logtape/logtape";
import { honoLogger as createHonoLogger } from "@logtape/hono";

const isDev = process.env.NODE_ENV !== "production";

// Idempotent: in tests, both this file and mcp-server/src/lib/logger.ts may
// be imported in the same process. LogTape's `configure()` throws on second
// call; first one wins. In dev/prod the two loggers run in separate processes
// so this never matters at runtime.
try {
  await configure({
    sinks: {
      console: isDev
        ? getConsoleSink()
        : getConsoleSink({ formatter: jsonLinesFormatter }),
    },
    loggers: [
      { category: ["logtape", "meta"], lowestLevel: "warning" },
      { category: ["app"], sinks: ["console"], lowestLevel: "debug" },
      { category: ["hono"], sinks: ["console"], lowestLevel: "info" },
    ],
  });
} catch {
  // Already configured by another module load — fine.
}

export { getLogger };
export const honoLogger = createHonoLogger({ category: ["hono"] });
