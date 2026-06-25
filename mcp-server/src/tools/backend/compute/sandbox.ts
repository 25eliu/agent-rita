/**
 * Per-conversation Daytona sandbox manager for the compute MCP server.
 *
 * Lifecycle model (POC v0 — no warm pool):
 *   - First compute tool call for a conversation_id creates a sandbox lazily,
 *     installs duckdb/pandas/plotly/matplotlib/kaleido, uploads `rita.py`,
 *     and adds /opt to sys.path. Subsequent calls reuse the same sandbox.
 *   - Daytona's `autoStopInterval: 10` (minutes) tears it down after idle.
 *     A stopped sandbox surfaces as a runtime error on next use; we drop
 *     the cached entry and recreate.
 *   - In-process Map: lives for the MCP server process lifetime. State is
 *     not persisted across MCP server restarts — first call after a restart
 *     creates a fresh sandbox even if the conversation existed before.
 *
 * Concurrency: an `initPromise` per conversation_id prevents two parallel
 * tool calls from racing to create separate sandboxes for the same chat.
 */

import { Daytona, type Sandbox } from "@daytonaio/sdk";
import { RITA_PY_SOURCE } from "./rita-helper";
import { getLogger } from "../../../lib/logger";

const logger = getLogger(["mcp", "compute", "sandbox"]);

const PIP_PACKAGES = [
  "duckdb",
  "pandas",
  "numpy",
  "plotly",
  "matplotlib",
  "kaleido",
  "scipy",
];

const PIP_INSTALL_TIMEOUT_SEC = 180;
const INIT_CODE_TIMEOUT_SEC = 30;
const AUTO_STOP_MINUTES = 10;

interface SandboxEntry {
  sandbox: Sandbox;
  conversationId: string;
  createdAt: number;
}

const sandboxes = new Map<string, SandboxEntry>();
const inFlight = new Map<string, Promise<SandboxEntry>>();

let _client: Daytona | null = null;

function getClient(): Daytona {
  if (_client) return _client;
  const apiKey = process.env.DAYTONA_API_KEY;
  if (!apiKey) {
    throw new Error("DAYTONA_API_KEY is not set — compute tools are disabled");
  }
  const apiUrl = process.env.DAYTONA_API_URL;
  const target = process.env.DAYTONA_TARGET;
  _client = new Daytona({
    apiKey,
    ...(apiUrl ? { apiUrl } : {}),
    ...(target ? { target } : {}),
  });
  return _client;
}

async function initSandbox(conversationId: string): Promise<SandboxEntry> {
  const daytona = getClient();
  const startedAt = Date.now();
  logger.info("Creating sandbox", { conversationId });

  const sandbox = await daytona.create({
    language: "python",
    autoStopInterval: AUTO_STOP_MINUTES,
  });
  const createdMs = Date.now() - startedAt;
  logger.info("Sandbox created — installing packages", {
    conversationId,
    sandboxId: sandbox.id,
    createMs: createdMs,
  });

  const installStart = Date.now();
  const installCmd = `pip install --quiet ${PIP_PACKAGES.join(" ")}`;
  const installResult = await sandbox.process.executeCommand(
    installCmd,
    undefined,
    undefined,
    PIP_INSTALL_TIMEOUT_SEC,
  );
  const installMs = Date.now() - installStart;
  if (installResult.exitCode !== 0) {
    logger.warn("pip install non-zero exit", {
      conversationId,
      sandboxId: sandbox.id,
      exitCode: installResult.exitCode,
      installMs,
      output: (installResult.result ?? "").slice(0, 500),
    });
  } else {
    logger.info("pip install ok", { conversationId, sandboxId: sandbox.id, installMs });
  }

  const uploadStart = Date.now();
  // /tmp is universally writable on Daytona python images; /opt often isn't
  // for the sandbox user, which silently 403s the upload.
  const RITA_PATH = "/tmp/rita.py";
  try {
    await sandbox.fs.uploadFile(Buffer.from(RITA_PY_SOURCE, "utf-8"), RITA_PATH);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`rita.py upload to ${RITA_PATH} failed: ${msg}`);
  }
  const uploadMs = Date.now() - uploadStart;

  const initCode = `
import sys, traceback
try:
    if "/tmp" not in sys.path:
        sys.path.insert(0, "/tmp")
    import duckdb
    _rita_con = duckdb.connect("/tmp/rita.db")
    import rita  # smoke-test the helper module
    print("rita-init:ok")
except Exception as e:
    print("rita-init:err:" + repr(e))
    print(traceback.format_exc())
`;
  const initStart = Date.now();
  const initRes = await sandbox.process.codeRun(initCode, {}, INIT_CODE_TIMEOUT_SEC);
  const initMs = Date.now() - initStart;
  if (initRes.exitCode !== 0 || !(initRes.result ?? "").includes("rita-init:ok")) {
    throw new Error(
      `rita init failed (exit ${initRes.exitCode}): ${(initRes.result ?? "").slice(0, 800)}`,
    );
  }

  const entry: SandboxEntry = {
    sandbox,
    conversationId,
    createdAt: Date.now(),
  };
  sandboxes.set(conversationId, entry);
  logger.info("Sandbox ready", {
    conversationId,
    sandboxId: sandbox.id,
    totalMs: Date.now() - startedAt,
    createMs: createdMs,
    installMs,
    uploadMs,
    initMs,
  });
  return entry;
}

export async function getSandbox(conversationId: string): Promise<Sandbox> {
  const cached = sandboxes.get(conversationId);
  if (cached) return cached.sandbox;

  const pending = inFlight.get(conversationId);
  if (pending) {
    const entry = await pending;
    return entry.sandbox;
  }

  const promise = initSandbox(conversationId);
  inFlight.set(conversationId, promise);
  try {
    const entry = await promise;
    return entry.sandbox;
  } catch (err) {
    sandboxes.delete(conversationId);
    throw err;
  } finally {
    inFlight.delete(conversationId);
  }
}

/**
 * Drop a cached sandbox entry. Use when a tool call surfaces a "sandbox
 * stopped" error so the next call recreates rather than retrying a dead one.
 */
export function dropSandbox(conversationId: string): void {
  sandboxes.delete(conversationId);
}

/**
 * Test-only: clear all module state. The sandboxes/inFlight Maps and the
 * cached Daytona client are normally process-lifetime; tests need a clean
 * slate between cases. Not exported as part of the public surface — names
 * are underscore-prefixed to discourage prod use.
 */
export function _resetSandboxState(): void {
  sandboxes.clear();
  inFlight.clear();
  _client = null;
}
