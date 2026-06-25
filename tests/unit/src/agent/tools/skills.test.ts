import { describe, it, expect } from "bun:test";
import {
  makeGetSkillContentTool,
  getSkillContentSchema,
} from "../../../../../src/agent/tools/skills";

describe("getSkillContentSchema", () => {
  it("requires slug; reason is optional", () => {
    expect(getSkillContentSchema.parse({ slug: "alpha" })).toEqual({ slug: "alpha" });
    expect(getSkillContentSchema.parse({ slug: "alpha", reason: "user asked" })).toEqual({
      slug: "alpha",
      reason: "user asked",
    });
    expect(() => getSkillContentSchema.parse({})).toThrow();
  });
});

describe("makeGetSkillContentTool", () => {
  it("returns a fresh tool each call", () => {
    expect(makeGetSkillContentTool()).not.toBe(makeGetSkillContentTool());
  });

  it("has no execute (round-trip tool)", () => {
    expect((makeGetSkillContentTool() as { execute?: unknown }).execute).toBeUndefined();
  });
});
