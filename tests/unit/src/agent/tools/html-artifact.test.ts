import { describe, it, expect } from "bun:test";
import {
  htmlArtifactDescription,
  runHtmlArtifact,
} from "../../../../../src/agent/tools/html-artifact";
import type { CopilotArtifact, SSEEvent } from "../../../../../src/protocol/types";

describe("runHtmlArtifact", () => {
  it("steers Mermaid-style diagrams away from HTML artifacts", () => {
    expect(htmlArtifactDescription).toContain("flowcharts");
    expect(htmlArtifactDescription).toContain("Mermaid-style diagrams");
    expect(htmlArtifactDescription).toContain("mermaid_diagram");
  });

  it("emits a single html artifact onto the queue", () => {
    const artifactQueue: SSEEvent[] = [];
    const out = runHtmlArtifact(
      {
        html: "<h1>hi</h1>",
        name: "greeting",
        description: "a small greeting",
      },
      { artifactQueue },
    );
    expect(out).toContain("greeting");
    expect(artifactQueue).toHaveLength(1);
    expect(artifactQueue[0].event).toBe("copilotMessageArtifact");
    const artifact = artifactQueue[0].data as unknown as CopilotArtifact;
    expect(artifact.type).toBe("html");
    expect((artifact as { content: string }).content).toBe("<h1>hi</h1>");
  });

  it("rejects payloads exceeding the 50 KB cap with no artifact emitted", () => {
    const huge = "<p>" + "a".repeat(60 * 1024) + "</p>";
    const artifactQueue: SSEEvent[] = [];
    const out = runHtmlArtifact(
      { html: huge, name: "big", description: "x" },
      { artifactQueue },
    );
    expect(out).toMatch(/HTML too large/);
    expect(artifactQueue).toHaveLength(0);
  });

  it("assigns a fresh uuid per call", () => {
    const artifactQueue: SSEEvent[] = [];
    runHtmlArtifact(
      { html: "<p>1</p>", name: "a", description: "first" },
      { artifactQueue },
    );
    runHtmlArtifact(
      { html: "<p>2</p>", name: "b", description: "second" },
      { artifactQueue },
    );
    const a = artifactQueue[0].data as unknown as { uuid: string };
    const b = artifactQueue[1].data as unknown as { uuid: string };
    expect(a.uuid).not.toBe(b.uuid);
  });
});
