import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";

interface FakeSandbox {
  id: string;
  process: {
    executeCommand: (...args: unknown[]) => Promise<{ exitCode: number; result: string }>;
    codeRun: (...args: unknown[]) => Promise<{ exitCode: number; result: string }>;
  };
  fs: { uploadFile: (buf: Buffer, path: string) => Promise<void> };
}

let createCallCount = 0;
let nextSandboxFactory: () => FakeSandbox | Promise<FakeSandbox> = () => ({
  id: `sbx-${++createCallCount}`,
  process: {
    executeCommand: async () => ({ exitCode: 0, result: "" }),
    codeRun: async () => ({ exitCode: 0, result: "rita-init:ok" }),
  },
  fs: { uploadFile: async () => {} },
});

mock.module("@daytonaio/sdk", () => ({
  Daytona: class {
    constructor(_opts: unknown) {}
    async create(_opts: unknown): Promise<FakeSandbox> {
      return nextSandboxFactory();
    }
  },
}));

const { getSandbox, dropSandbox, _resetSandboxState } = await import(
  "../../../../../../mcp-server/src/tools/backend/compute/sandbox"
);

const realKey = process.env.DAYTONA_API_KEY;

beforeEach(() => {
  _resetSandboxState();
  createCallCount = 0;
  nextSandboxFactory = () => ({
    id: `sbx-${++createCallCount}`,
    process: {
      executeCommand: async () => ({ exitCode: 0, result: "" }),
      codeRun: async () => ({ exitCode: 0, result: "rita-init:ok" }),
    },
    fs: { uploadFile: async () => {} },
  });
  process.env.DAYTONA_API_KEY = "test-key";
});

afterEach(() => {
  if (realKey === undefined) delete process.env.DAYTONA_API_KEY;
  else process.env.DAYTONA_API_KEY = realKey;
});

describe("getSandbox — env guard", () => {
  it("throws when DAYTONA_API_KEY is unset on first creation", async () => {
    delete process.env.DAYTONA_API_KEY;
    await expect(getSandbox("conv-1")).rejects.toThrow(/DAYTONA_API_KEY/);
  });
});

describe("getSandbox — caching", () => {
  it("creates one sandbox per conversation and reuses it", async () => {
    const a = await getSandbox("conv-1");
    const b = await getSandbox("conv-1");
    expect(a).toBe(b);
    expect(createCallCount).toBe(1);
  });

  it("creates separate sandboxes for distinct conversations", async () => {
    const a = await getSandbox("conv-a");
    const b = await getSandbox("conv-b");
    expect(a).not.toBe(b);
    expect(createCallCount).toBe(2);
  });

  it("dropSandbox forces a fresh creation on next call", async () => {
    const first = await getSandbox("conv-1");
    dropSandbox("conv-1");
    const second = await getSandbox("conv-1");
    expect(second).not.toBe(first);
    expect(createCallCount).toBe(2);
  });
});

describe("getSandbox — concurrency", () => {
  it("dedupes parallel calls for the same conversation (inFlight wait)", async () => {
    let resolveCreate!: (v: FakeSandbox) => void;
    const sharedSandbox: FakeSandbox = {
      id: "shared",
      process: {
        executeCommand: async () => ({ exitCode: 0, result: "" }),
        codeRun: async () => ({ exitCode: 0, result: "rita-init:ok" }),
      },
      fs: { uploadFile: async () => {} },
    };
    nextSandboxFactory = () =>
      new Promise<FakeSandbox>((resolve) => {
        resolveCreate = resolve;
      });

    const p1 = getSandbox("conv-race");
    const p2 = getSandbox("conv-race");
    // Allow microtasks to flush so both calls are queued before we resolve.
    await Promise.resolve();
    resolveCreate(sharedSandbox);

    const [a, b] = await Promise.all([p1, p2]);
    expect(a).toBe(b);
    expect(a.id).toBe("shared");
  });
});

describe("getSandbox — init failure cleanup", () => {
  it("does not cache the sandbox when rita init code fails", async () => {
    nextSandboxFactory = () => ({
      id: `sbx-${++createCallCount}`,
      process: {
        executeCommand: async () => ({ exitCode: 0, result: "" }),
        codeRun: async () => ({ exitCode: 1, result: "rita-init:err:boom" }),
      },
      fs: { uploadFile: async () => {} },
    });
    await expect(getSandbox("conv-x")).rejects.toThrow(/rita init failed/);

    nextSandboxFactory = () => ({
      id: `sbx-${++createCallCount}`,
      process: {
        executeCommand: async () => ({ exitCode: 0, result: "" }),
        codeRun: async () => ({ exitCode: 0, result: "rita-init:ok" }),
      },
      fs: { uploadFile: async () => {} },
    });
    const sb = await getSandbox("conv-x");
    expect(sb.id).toMatch(/^sbx-\d+$/);
  });
});
