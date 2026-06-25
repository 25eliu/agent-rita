import { describe, it, expect, mock } from "bun:test";

// Mock data-bridge + sandbox so execute-code never touches Daytona.
// `prepareCompute` returns a stub sandbox whose codeRun is controlled by tests.
let nextRunResult: {
  result?: string;
  exitCode?: number;
  artifacts?: { stdout?: string; charts?: Array<Record<string, unknown>> };
} = { result: "", exitCode: 0 };

let nextPrepareThrows: Error | null = null;
let nextLoaded: Array<{ tableName: string; rowCount: number }> = [];

function mockReadDecoration(args: Record<string, unknown>) {
  const conversationId = args["x-agentrita-conversation-id"];
  if (typeof conversationId !== "string" || conversationId.length === 0) {
    throw new Error("missing x-agentrita-conversation-id (agent decoration)");
  }
  const tablesRaw = args["x-agentrita-tables"];
  let tables: Record<string, unknown[]> | undefined;
  if (tablesRaw && typeof tablesRaw === "object" && !Array.isArray(tablesRaw)) {
    tables = {};
    for (const [name, rows] of Object.entries(tablesRaw)) {
      if (Array.isArray(rows)) tables[name] = rows;
    }
    if (Object.keys(tables).length === 0) tables = undefined;
  }
  return { conversationId, tables };
}

mock.module(
  "../../../../../../mcp-server/src/tools/backend/compute/data-bridge",
  () => ({
    readDecoration: mockReadDecoration,
    prepareCompute: async () => {
      if (nextPrepareThrows) throw nextPrepareThrows;
      return {
        sandbox: {
          id: "test-sandbox-id",
          process: { codeRun: async () => nextRunResult },
        },
        conversationId: "test-conv",
        loaded: nextLoaded,
      };
    },
  }),
);

// Note: don't mock compute/sandbox here. The real dropSandbox is harmless
// (just clears a Map entry). Mocking it interferes with sandbox.test.ts in
// the same test process — Bun's module mocks are process-scoped.

const { executeCodeHandler } = await import(
  "../../../../../../mcp-server/src/tools/backend/compute/execute-code"
);

function resetMocks() {
  nextRunResult = { result: "", exitCode: 0 };
  nextPrepareThrows = null;
  nextLoaded = [];
}

/** Drop the silent `sandbox_meta` ride-along from a result's content array. */
function visible(content: ReadonlyArray<{ text: string }>): { text: string }[] {
  return content.filter((c) => !c.text.startsWith('{"$rita_kind":"sandbox_meta"'));
}

describe("executeCodeHandler — missing conversationId", () => {
  it("returns COMPUTE_PERMANENTLY_UNAVAILABLE with retry-suppression text", async () => {
    resetMocks();
    const res = await executeCodeHandler({ code: "print(1)" });
    expect(res.content).toHaveLength(1);
    expect(res.content[0].text).toContain("COMPUTE_PERMANENTLY_UNAVAILABLE");
    expect(res.content[0].text).toContain("Do NOT retry");
  });
});

describe("executeCodeHandler — happy path stdout", () => {
  it("returns plain stdout as a single text item", async () => {
    resetMocks();
    nextRunResult = { result: "hello\nworld\n", exitCode: 0 };
    const res = await executeCodeHandler({
      code: "print(1)",
      "x-agentrita-conversation-id": "c1",
    });
    const items = visible(res.content);
    expect(items).toHaveLength(1);
    expect(items[0].text).toContain("hello");
    expect(items[0].text).toContain("world");
  });

  it("prepends a [Loaded ...] summary when tables were loaded", async () => {
    resetMocks();
    nextRunResult = { result: "ok\n", exitCode: 0 };
    nextLoaded = [{ tableName: "prices", rowCount: 3 }];
    const res = await executeCodeHandler({
      code: "1",
      "x-agentrita-conversation-id": "c1",
      "x-agentrita-tables": { prices: [{ a: 1 }] },
    });
    expect(visible(res.content)[0].text).toContain('[Loaded "prices" (3) into compute sandbox]');
  });

  it("appends [Process exited with code N] when exit is non-zero with output", async () => {
    resetMocks();
    nextRunResult = { result: "stuff\n", exitCode: 7 };
    const res = await executeCodeHandler({
      code: "1/0",
      "x-agentrita-conversation-id": "c1",
    });
    const last = res.content.at(-1);
    expect(last?.text).toContain("[Process exited with code 7]");
  });

  it("returns a clean error item on non-zero exit with no output", async () => {
    resetMocks();
    nextRunResult = { result: "", exitCode: 5 };
    const res = await executeCodeHandler({
      code: "1",
      "x-agentrita-conversation-id": "c1",
    });
    expect(visible(res.content)[0].text).toContain("exited with code 5");
  });

  it("returns [No output] when exit zero and stdout empty", async () => {
    resetMocks();
    nextRunResult = { result: "", exitCode: 0 };
    const res = await executeCodeHandler({
      code: "pass",
      "x-agentrita-conversation-id": "c1",
    });
    expect(visible(res.content)[0].text).toBe("[No output]");
  });

  it("emits a sandbox_meta item containing the sandbox id as the first content item", async () => {
    resetMocks();
    nextRunResult = { result: "hi\n", exitCode: 0 };
    const res = await executeCodeHandler({
      code: "print('hi')",
      "x-agentrita-conversation-id": "c1",
    });
    expect(res.content[0].text).toContain('"$rita_kind":"sandbox_meta"');
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.sandbox_id).toBe("test-sandbox-id");
  });
});

describe("executeCodeHandler — sentinel artifacts", () => {
  it("decodes a rita.show table sentinel into a table artifact between text segments", async () => {
    resetMocks();
    const payload = {
      kind: "table",
      name: "Prices",
      caption: "test",
      rows: [{ a: 1 }, { a: 2 }],
    };
    const b64 = Buffer.from(JSON.stringify(payload), "utf-8").toString("base64");
    const stdout = `before\x00__x_agentrita_artifact__\x00${b64}\x00after`;
    nextRunResult = { result: stdout, exitCode: 0 };

    const res = await executeCodeHandler({
      code: "x",
      "x-agentrita-conversation-id": "c1",
    });

    const items = visible(res.content);
    expect(items).toHaveLength(3);
    expect(items[0].text).toContain("before");
    const artifact = JSON.parse(items[1].text);
    expect(artifact.$rita_kind).toBe("artifact");
    expect(artifact.artifact.type).toBe("table");
    expect(artifact.artifact.name).toBe("Prices");
    expect(items[2].text).toContain("after");
  });

  it("decodes html sentinels (e.g. plotly figures)", async () => {
    resetMocks();
    const payload = {
      kind: "html",
      name: "Chart",
      caption: "",
      content: "<div>plotly</div>",
    };
    const b64 = Buffer.from(JSON.stringify(payload), "utf-8").toString("base64");
    const stdout = `\x00__x_agentrita_artifact__\x00${b64}\x00`;
    nextRunResult = { result: stdout, exitCode: 0 };

    const res = await executeCodeHandler({
      code: "x",
      "x-agentrita-conversation-id": "c1",
    });
    const items = visible(res.content);
    const artifact = JSON.parse(items[0].text);
    expect(artifact.artifact.type).toBe("html");
    expect(artifact.artifact.content).toContain("plotly");
  });

  it("skips artifact when rita.show emits empty HTML content", async () => {
    resetMocks();
    const payload = { kind: "html", name: "Empty Chart", content: "" };
    const b64 = Buffer.from(JSON.stringify(payload), "utf-8").toString("base64");
    const stdout = `before\x00__x_agentrita_artifact__\x00${b64}\x00after`;
    nextRunResult = { result: stdout, exitCode: 0 };

    const res = await executeCodeHandler({
      code: "x",
      "x-agentrita-conversation-id": "c1",
    });

    // Should only have text items — no artifact
    for (const item of res.content) {
      expect(item.text).not.toContain('"$rita_kind":"artifact"');
    }
    expect(res.content.some((c: { text: string }) => c.text.includes("before"))).toBe(true);
    expect(res.content.some((c: { text: string }) => c.text.includes("after"))).toBe(true);
  });

  it("skips artifact when rita.show emits table with empty rows", async () => {
    resetMocks();
    const payload = { kind: "table", name: "Empty Table", rows: [] };
    const b64 = Buffer.from(JSON.stringify(payload), "utf-8").toString("base64");
    const stdout = `data\x00__x_agentrita_artifact__\x00${b64}\x00`;
    nextRunResult = { result: stdout, exitCode: 0 };

    const res = await executeCodeHandler({
      code: "x",
      "x-agentrita-conversation-id": "c1",
    });

    for (const item of res.content) {
      expect(item.text).not.toContain('"$rita_kind":"artifact"');
    }
  });

  it("skips artifact when rita.show payload has no content field at all", async () => {
    resetMocks();
    const payload = { kind: "html", name: "Missing Content" };
    const b64 = Buffer.from(JSON.stringify(payload), "utf-8").toString("base64");
    const stdout = `\x00__x_agentrita_artifact__\x00${b64}\x00`;
    nextRunResult = { result: stdout, exitCode: 0 };

    const res = await executeCodeHandler({
      code: "x",
      "x-agentrita-conversation-id": "c1",
    });

    for (const item of res.content) {
      expect(item.text).not.toContain('"$rita_kind":"artifact"');
    }
  });

  it("converts Daytona auto-extracted matplotlib charts into html img artifacts", async () => {
    resetMocks();
    nextRunResult = {
      result: "",
      exitCode: 0,
      artifacts: {
        charts: [
          {
            type: "image",
            title: "My Plot",
            png: "iVBOR",
            x_label: "x",
            y_label: "y",
          },
        ],
      },
    };
    const res = await executeCodeHandler({
      code: "plt.show()",
      "x-agentrita-conversation-id": "c1",
    });
    const artifactItem = res.content.find((c) => c.text.includes('"$rita_kind":"artifact"'));
    expect(artifactItem).toBeDefined();
    const a = JSON.parse(artifactItem!.text).artifact;
    expect(a.type).toBe("html");
    expect(a.content).toContain("data:image/png;base64,iVBOR");
    expect(a.name).toBe("My Plot");
  });
});

describe("executeCodeHandler — prepareCompute failures", () => {
  it("retries once when prepareCompute throws a stopped-sandbox error", async () => {
    resetMocks();
    let calls = 0;
    nextPrepareThrows = new Error("Is the Sandbox started?");
    nextRunResult = { result: "ok after retry", exitCode: 0 };

    // Override the mock to throw once then succeed.
    mock.module(
      "../../../../../../mcp-server/src/tools/backend/compute/data-bridge",
      () => ({
        readDecoration: mockReadDecoration,
        prepareCompute: async () => {
          calls++;
          if (calls === 1) throw new Error("Is the Sandbox started?");
          return {
            sandbox: { id: "test-sandbox-id", process: { codeRun: async () => nextRunResult } },
            conversationId: "c1",
            loaded: [],
          };
        },
      }),
    );
    const { executeCodeHandler: fresh } = await import(
      "../../../../../../mcp-server/src/tools/backend/compute/execute-code"
    );
    const res = await fresh({
      code: "x",
      "x-agentrita-conversation-id": "c1",
    });
    expect(calls).toBe(2);
    expect(visible(res.content)[0].text).toContain("ok after retry");
  });

  it("returns Compute unavailable on non-stopped errors", async () => {
    resetMocks();
    mock.module(
      "../../../../../../mcp-server/src/tools/backend/compute/data-bridge",
      () => ({
        readDecoration: mockReadDecoration,
        prepareCompute: async () => {
          throw new Error("kaboom");
        },
      }),
    );
    const { executeCodeHandler: fresh } = await import(
      "../../../../../../mcp-server/src/tools/backend/compute/execute-code"
    );
    const res = await fresh({
      code: "x",
      "x-agentrita-conversation-id": "c1",
    });
    // prepareCompute failed → no sandbox, no sandbox_meta. Visible == full content.
    expect(res.content[0].text).toContain("Compute unavailable");
    expect(res.content[0].text).toContain("kaboom");
  });
});
