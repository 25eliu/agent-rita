import { describe, it, expect } from "bun:test";
import { RITA_PY_SOURCE } from "../../../../../../mcp-server/src/tools/backend/compute/rita-helper";

describe("RITA_PY_SOURCE", () => {
  it("defines the show() entry point", () => {
    expect(RITA_PY_SOURCE).toMatch(/def\s+show\s*\(/);
  });

  it("emits JSON sentinels framed with the expected null-byte head/tail", () => {
    expect(RITA_PY_SOURCE).toContain("\\x00__x_agentrita_artifact__\\x00");
    expect(RITA_PY_SOURCE).toContain("_SENTINEL_TAIL");
  });

  it("supports plotly, matplotlib, and pandas type-checks", () => {
    expect(RITA_PY_SOURCE).toContain("_is_plotly");
    expect(RITA_PY_SOURCE).toContain("_is_matplotlib");
    expect(RITA_PY_SOURCE).toContain("_is_dataframe");
  });

  it("base64-encodes the JSON payload", () => {
    expect(RITA_PY_SOURCE).toContain("base64.b64encode(json.dumps(payload)");
  });
});
