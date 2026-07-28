/**
 * Shared SDK-level mock for ALL tako tests. bun's mock.module leaks across
 * test files in one process, so every tako test file uses this ONE seam
 * (mocking the MCP SDK client) instead of mocking each other's source
 * modules. Re-registering the identical factory is idempotent, so test-file
 * order never matters. Import this BEFORE importing any tako source module.
 */
import { mock } from "bun:test";

export interface UpstreamCall {
  name: string;
  args: Record<string, unknown>;
}

interface UpstreamResponse {
  content: { type: string; text: string }[];
  structuredContent: unknown;
  isError: boolean;
}

function defaultResponse(): UpstreamResponse {
  return {
    content: [{ type: "text", text: "upstream text" }],
    structuredContent: undefined,
    isError: false,
  };
}

export const upstream = {
  response: defaultResponse(),
  /** shift()ed per call — push N errors to make the next N calls throw. */
  errors: [] as Error[],
  calls: [] as UpstreamCall[],
  connects: 0,
  transportUrls: [] as string[],
  reset(): void {
    this.response = defaultResponse();
    this.errors = [];
    this.calls = [];
    this.connects = 0;
    this.transportUrls = [];
  },
};

mock.module("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    async connect(): Promise<void> {
      upstream.connects += 1;
    }
    async callTool(params: {
      name: string;
      arguments: Record<string, unknown>;
    }): Promise<UpstreamResponse> {
      upstream.calls.push({ name: params.name, args: params.arguments });
      const err = upstream.errors.shift();
      if (err) throw err;
      return upstream.response;
    }
  },
}));

mock.module("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class {
    constructor(url: URL) {
      upstream.transportUrls.push(url.toString());
    }
  },
}));
