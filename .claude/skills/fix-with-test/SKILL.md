---
name: fix-with-test
description: Reproduce-and-fix loop for bugs in this repo (Hono + Bun + Vercel AI SDK + MCP). Write a FAILING test/eval that reproduces the bug FIRST, confirm it fails for the RIGHT reason, apply the minimal fix, confirm it passes — the test/eval stays as a regression guard. Use when fixing a reported bug, "X is broken / doesn't work", wrong tool routing, wrong/missing answer, or hardening a defect-prone path. For adding coverage to already-working code, just write the test in the right tier per TESTING.md.
allowed-tools: Read, Glob, Grep, Write, Edit, Bash
---

# Fix With Test

Kill a bug by first proving it exists with a failing test or eval, then making it pass with the
smallest change. The fix is the deliverable; the test/eval is the proof and the regression guard.

This skill owns the **loop discipline, the layer-selection map, and the failure-mode guards**. It does
NOT re-document the test stack — for tiers, fixtures, graders, and conventions read `TESTING.md`.

## When to use vs not

- **Use this** for a defect: reported bug, "X is broken", wrong value/state, wrong tool routing, a
  regression. You are reproducing, then fixing.
- **Skip to plain test-writing** (right tier per `TESTING.md`) when the code works and you are adding
  coverage or doing greenfield TDD.

## The loop

```text
0. Locate root cause        -> verify: point at the file:line that is wrong
1. Choose the layer (below) -> verify: failing there implicates ONLY the real bug (Guard 4)
2. Write the failing test    -> asserts CORRECT behavior, mirrors the tier's existing structure
3. Run it -> RED            -> verify: fails for the RIGHT reason (Guards 1-3, +6 for evals)
4. Apply the minimal fix    -> smallest change at the root cause (Guard 5)
5. Run it -> GREEN
6. bun run typecheck        -> changed files clean
7. Leave the test/eval in place; commit test + fix together
```

Inner loop runs ONLY the target file/case. Full `bun test tests/` and full `bun run evals` are PR/CI gates.

## Pick the layer — the bug class decides the tier

| Bug lives in… | Tier | Where | How RED/GREEN |
|---|---|---|---|
| pure logic / parser / schema / Zod | 1 unit | `tests/unit/...` | `bun test tests/unit/path.test.ts` |
| MCP tool handler (extract/chunk/embed/format) | 1 unit | `tests/unit/mcp-server/...` | call the `*Handler` directly |
| agent loop / round-trip / dispatch / decoration | 2 integration (mock LLM) | `tests/integration/agent-loop/...` | `MockLanguageModelV2` script + drain SSE |
| **system prompt / tool description / model tool-routing** | **3 eval (real LLM)** | `evals/cases/...` | `bun run evals -- --filter=<id>` |

The non-obvious one: a **prompt or tool-description bug has nothing to assert at the unit layer** — every
code path is correct, the model just chose wrong. Reproduce it as a Tier-3 eval with a **deterministic
grader** (`toolCalled` / `toolNeverCalled` / `argContains` from `evals/graders/`), NOT a unit test, and
NOT `llmJudge` when a tool-call signal will do.

## The 6 guards (the part that matters)

**Guard 1 — Confirm RED before you fix.** Run the new test/eval against unpatched code. It MUST fail. If
it passes, STOP — not a reproduction. Re-investigate; do not "fix".

**Guard 2 — Red for the RIGHT reason.** Read the failure output, not the exit code. The failing
assertion must describe the real defect (wrong value/routing/state). Reject fake reds: import/module
resolution errors, a type/syntax error in the test, a wrong grader name, an MCP handler that throws on
setup instead of returning the wrong result.

**Guard 3 — Beware mock-induced signals (Tier 2).** A `MockLanguageModelV2` script that hard-codes the
tool call under test proves nothing. The mock must leave the decision to the code path you're testing —
otherwise move down to Tier 1 or up to Tier 3.

**Guard 4 — Reproduce at the lowest faithful layer.** Pick the tier where the test fails ONLY when the
real bug is present (table above). The fix may land in a *different* place than the repro (you can
reproduce via eval but fix a tool-description string) — that's fine. But if the repro can't go red at
all, the layer is wrong.

**Guard 5 — Minimal fix, no scope creep.** Smallest change at the root cause. Don't weaken the
test/grader to pass. Every changed line traces to this bug.

**Guard 6 — Eval reds are model- and trial-dependent (Tier 3 only).**
- **Pin the model** that exhibits the bug: `EVAL_MODEL=openai:gpt-4o bun run evals -- --filter=<id>`. A
  stronger/weaker model can mask or fake the signal.
- **Confirm RED across trials** (`EVAL_TRIALS=5`), not one lucky run. A 1-of-3 flake is not a repro.
- **Prefer deterministic graders** over `llmJudge` so red/green isn't judge-flaky. Per
  `evals/graders/index.ts`: grade end-state, not exact tool order.
- **Make the eval faithful**: surface the SAME tools/descriptions the workspace sends — import the real
  `*Description` strings rather than paraphrasing (see `evals/cases/file-widgets.ts`). A paraphrased
  description can be less tempting than production and hide the bug.
- Fake-red here also includes: wrong model, too few trials, a flaky `llmJudge`, or an under-tempting
  tool set (the model never had the chance to make the wrong call).

## Commands

```bash
# Tier 1/2 inner loop
bun test tests/unit/path/to/file.test.ts
bun test tests/integration/agent-loop/file.test.ts -t "the specific case"

# Tier 3 inner loop — pin model, bump trials to de-flake the signal
EVAL_MODEL=openai:gpt-4o EVAL_TRIALS=5 bun run evals -- --filter=<case-id>

# After green
bun run typecheck   # changed files clean (archive/ errors are pre-existing noise — ignore)
bun test tests/     # full suite, PR gate
```

## Done criteria
- Target was RED on unpatched code, for a genuine assertion reason (Guards 1-3, +6 for evals).
- Target is GREEN after a minimal root-cause fix (Guard 5).
- `bun run typecheck` clean for changed files; `bun test tests/` green.
- The reproduction stays as a permanent regression guard.

## STOP conditions
- New test/eval is green before any fix → not a reproduction (Guard 1).
- The only way to get red is an infra/mock/grader/model error → fake red (Guards 2-3, 6).
- The fix needs to touch many unrelated files → re-scope; the repro layer is probably wrong (Guard 4).

## Worked example — dashboard PDF RAG routing (2026-05-21)
Bug: user asks "does any document say X" about dashboard PDFs → agent calls `query_documents` on an
empty store → "no documents loaded".
- **Layer**: Tier 3 eval. Nothing wrong in code; the model routed wrong, so a unit test had nothing to
  assert.
- **Repro**: `evals/cases/file-widgets.ts` → `cold-pdf-loads-before-rag-query`. A `file-*` PDF widget,
  no preloaded data, `query_documents` available with the **real** imported description. Graders:
  `toolCalled("get_widget_data")` + `toolNeverCalled("query_documents")`.
- **RED** (`EVAL_MODEL=openai:gpt-4o`, 5 trials): 0/5 — model called `query_documents` cold. Right reason
  (logs: `Doc decoration tool=query_documents pending=0`).
- **Re-plan (Guards 4-5)**: the first fix touched only the system prompt → still 0/5. The dominant signal
  was the `query_documents` tool DESCRIPTION (`"do NOT read through any other tool"`). Moved the fix there.
- **GREEN**: 5/5 (gpt-4o), 3/3 (gemini-flash-lite). Fix = `queryDocumentsDescription` precondition wording
  + system-prompt reinforcement.
- **Lesson**: for tool-routing bugs, the **tool description** is usually a stronger lever than the system
  prompt — it sits at the decision point.
