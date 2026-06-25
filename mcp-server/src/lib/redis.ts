/**
 * Lazy ioredis client factory. Returns a singleton when `REDIS_URL` is set,
 * otherwise null — the doc store and any future cache use the null branch to
 * fall back to in-memory. Errors on the client are logged, never thrown, so a
 * Redis outage does not take the MCP server down.
 *
 * Test hook `_setRedisClientForTest` lets unit tests inject a mock or null.
 */

import Redis from "ioredis";
import { getLogger } from "./logger";

const logger = getLogger(["mcp", "redis"]);

let client: Redis | null | undefined = undefined;

export function getRedisClient(): Redis | null {
  if (client !== undefined) return client;
  const url = process.env.REDIS_URL;
  if (!url) {
    client = null;
    return null;
  }
  try {
    const c = new Redis(url, {
      lazyConnect: false,
      maxRetriesPerRequest: 3,
      enableOfflineQueue: false,
    });
    c.on("error", (err) => {
      logger.warn(`Redis error: ${err instanceof Error ? err.message : String(err)}`);
    });
    c.on("connect", () => logger.info("Redis connected"));
    client = c;
    return c;
  } catch (err) {
    logger.warn(`Failed to create Redis client: ${err instanceof Error ? err.message : String(err)}`);
    client = null;
    return null;
  }
}

/** Test-only hook. Pass `undefined` to reset to lazy-init. */
export function _setRedisClientForTest(c: Redis | null | undefined): void {
  client = c;
}
