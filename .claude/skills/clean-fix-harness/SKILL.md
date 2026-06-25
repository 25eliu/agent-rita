---
name: clean-fix-harness
description: Use every time the user asks to fix, debug, repair, patch, harden, clean up, or investigate broken behavior in this repo. Applies especially to agent harness, model/tool routing, SQL family, widget data, MCP, streaming, workspace bridge, citations, artifacts, evals, and tests. Enforces the repo's lean-harness rule: reproduce defects faithfully, fix at the root, keep the model responsible for choosing paths, avoid deterministic retries, avoid content/word-based routing, avoid hidden normalization, and reject overfit special cases.
allowed-tools: Read, Glob, Grep, Edit, Write, Bash
---

# Clean Fix Harness

Use this skill for every fix request in this repo. It complements `fix-with-test`: this skill defines
what a good fix is allowed to look like, and `fix-with-test` defines the red/green discipline.

The core rule: **the harness prepares state and exposes tools; the model chooses the path.** Fixes
must remove root causes, not build deterministic crutches around the model.

## Required Workflow

1. **Read the real context first**
   - Inspect the current branch diff against `main` when the bug is PR-related.
   - Read the relevant source, tests, and logs before proposing a fix.
   - Use `rg` for suspicious strings and code paths; do not rely on memory.
   - Keep existing user changes. Never reset or revert unrelated work.

2. **Classify the defect**
   - Pure code defect: parser, schema, SQL loader, artifact builder, event formatter, MCP handler.
   - Harness behavior defect: loop dispatch, streaming, artifact queue, state restoration, bridge routing.
   - Model behavior defect: wrong tool chosen, wrong tool args, bad final formatting, wrong reasoning path.
   - Contract defect: prompt/tool description/schema says the wrong thing or leaves ambiguity.

3. **Reproduce before fixing**
   - For bugs, follow `fix-with-test`: write a failing unit/integration test or eval first.
   - Confirm the red is for the real behavior, not bad test setup.
   - If the issue is model/tool choice, use a real-LLM eval with deterministic graders where possible.
   - If the issue is deterministic code, use unit or integration tests at the lowest faithful layer.

4. **Fix at the root**
   - Broken implementation: patch the implementation.
   - Broken schema contract: patch the Zod schema or typed contract.
   - Broken tool description: patch the tool description.
   - Broken model instruction: patch the prompt or eval surface.
   - Broken display rendering: patch the renderer or protocol, not model-output cleanup, unless the
     protocol explicitly requires sanitization.

5. **Verify**
   - Run the focused failing test/eval until green.
   - Run nearby tests affected by the changed contract.
   - Run `bun run typecheck`.
   - Run `LIVE_DEBUG_TRACES=0 bun test tests/` before handing off a merge-ready fix.

## Harness Boundary Rules

The agent harness may:

- Dispatch structurally by tool source or protocol event type.
- Validate tool input against Zod schemas.
- Preserve request-scoped state such as `pendingTables`, `artifactQueue`, citations, loaded skills, and
  widget fetch queues.
- Expose state-bound tools that operate on request state, such as SQL-family tools.
- Emit structural SSE events for tool calls, tool results, artifacts, citations, and bridge commands.
- Enforce safety boundaries, such as SQL read-only checks and blocking SQLite internals.
- Strip narrow protocol placeholders that should never be user-visible.
- Cache or rehydrate state when the protocol explicitly requires it.

The agent harness must not:

- Decide the analytical path from user wording.
- Infer that a specific content shape means a specific action.
- Repair model mistakes by silently changing tool args.
- Retry a failed path deterministically because an error string matched a known pattern.
- Convert one identifier kind into another to make a model call "work".
- Hide an invalid model call by dropping conflicting fields or choosing a preferred source.
- Promote, suppress, or transform final answer content because it contains certain words.
- Parse tool-output prose to create a special UI state unless the output is a typed protocol payload.
- Add local branches that encode one observed failure trace instead of fixing the underlying contract.

## Patterns We Never Want

### Content-Based Routing

Never add logic like:

```ts
if (userText.includes("csv")) createArtifact();
if (output.startsWith("SQL error:")) showSqlFailurePath();
if (looksLikeMarkdownTable(finalText)) removeIt();
if (dataLooksStructured(value)) useSqlPath();
if (message.includes("error")) retry();
```

Why: this moves decisions from the model into brittle string matching. It creates overfit behavior that
works for one trace and fails in adjacent cases.

Correct alternatives:

- Make the tool/prompt contract clear enough that the model chooses the right tool.
- Return typed results for things the harness must understand.
- Add a deterministic eval for routing behavior.
- Fix the renderer if display is broken.

### Forced Retry or Deterministic Recovery

Never add logic like:

```ts
if (toolFailed) callSearchAgain();
if (sqlError.includes("no such column")) rewriteSql();
if (widgetFetchFailed) trySameNameWidget();
if (modelStopped) runAnother orchestration loop with a new instruction;
```

Allowed exception: a retry may exist only for a narrow external transient with a structural signal, such
as a stopped sandbox process or a network timeout. The retry must not inspect semantic content, must be
bounded, and must be documented in the owning tool layer.

Correct alternatives:

- Surface the failure to the model as tool output.
- Give the model enough state to choose the next call.
- Patch the prompt/tool description when the model repeatedly chooses the wrong recovery path.
- Patch the root service/tool when the failure is not model-controllable.

### Hidden Identifier Standardization

Never silently convert or reconcile identifiers:

```ts
widget.uuid ??= widget.widget_id;
find(w => w.uuid === id || w.widget_id === id);
dashboardId = lookupByDashboardTitle(userText);
widget_uuid = widget_id;
origin = origin.trim() || null;
```

Why: identifiers are protocol contracts. If the model sends the wrong identifier kind, silently fixing it
teaches the system to depend on ambiguity and masks prompt/schema bugs.

Correct alternatives:

- Make the prompt/tool description say exactly which identifier is required.
- Make schemas reject wrong or missing fields.
- Pass through bridge arguments when the browser bridge owns interpretation.
- Add an eval or integration test proving the model uses the correct identifier.

### Error-String Interpretation

Never parse generic error text to pick a specialized path:

```ts
if (/no such column/.test(error)) suggestColumn();
if (/date_trunc/.test(error)) rewriteForSQLite();
if (/ORDER BY term/.test(error)) injectSortKey();
```

Correct alternatives:

- Return raw tool errors plus structural context such as available table/column inventories.
- Improve tool descriptions and prompts with general dialect constraints.
- Let the model decide how to adjust its next SQL/tool call.

### Tool Output Text Parsing

Never parse human-readable tool output to create artifacts/statuses:

```ts
const rows = parseRowsAfter(output, /^Rows:/);
if (output.match(/^Created chart artifact/)) status = "Chart";
if (output.match(/^Table "([^"]+)"/)) status = "Missing table";
```

Correct alternatives:

- Use typed `SSEEvent`, typed MCP content, Zod schemas, or explicit JSON structures.
- Keep human-readable text as preview only.
- If the UI needs structure, change the tool to return a typed structure rather than parsing prose.

### Silent Source Precedence

Never accept conflicting model inputs and silently choose one:

```ts
const source = sql ?? fromTableId ?? data;
if (sql && fromTableId) ignoreFromTableId();
```

Correct alternative:

- Reject conflicting inputs with a schema/tool error.
- Describe the contract clearly: exactly one source, exactly one mode, or explicit precedence if the
  protocol truly requires precedence.

### Final Answer Surgery

Do not "clean up" final text with broad transformations:

```ts
removeMarkdownTables(finalText);
if (userAskedForExport) suppressInlineCsv(finalText);
if (artifactExists) stripMatchingSections(finalText);
```

Correct alternatives:

- Prompt the model to keep final text concise and put tabular output in artifacts.
- Emit artifacts through the artifact queue.
- Strip only narrow protocol placeholder leaks that should never be visible, such as artifact tags.
- Fix renderer bugs where valid Markdown is displayed incorrectly.

### Special-Case Fixes From One Trace

Be suspicious of fixes that mention a single metric, widget, table, column, provider, or error string
unless the defect is truly in that named integration.

Bad smell examples:

- Branches for a particular widget name.
- Branches for one SQL table like `executive_esg_kpi_snapshot`.
- Regex for one model's phrasing.
- Tests that assert one exact model answer instead of the contract.
- Prompt changes that describe one incident instead of a reusable rule.

## What Good Fixes Look Like

Good fixes are usually one of these:

- **Contract fix**: sharpen a tool description, prompt rule, Zod schema, or protocol type.
- **Root implementation fix**: correct the function that owns the behavior.
- **Typed payload fix**: replace prose parsing with structured data.
- **Validation fix**: reject ambiguous/conflicting inputs early.
- **Safety fix**: block unsafe operations structurally.
- **Renderer/protocol fix**: fix how events or artifacts are rendered instead of rewriting model text.
- **Regression guard**: focused test/eval that proves the bad behavior does not return.

## Testing Guidance

Use the lowest faithful layer:

- Unit tests for pure logic, schemas, tool handlers, SQL safety, artifact creation.
- Integration tests for agent loop behavior, streaming, SSE ordering, state restoration, decoration.
- Real evals for model routing and tool-choice behavior.

Do not write tests that bake in model internals:

- Avoid exact final-answer prose unless the formatter is deterministic.
- Avoid exact tool order unless order is the harness contract.
- Do not hard-code a mocked model tool choice to prove a model-routing bug.
- Grade end-state and contracts: tool was available, tool was called/not called, args shape is correct,
  artifact exists, invalid input is rejected, no bridge call is emitted.

## Review Checklist Before Finishing a Fix

Ask these before finalizing:

- Did I reproduce the defect at the right layer?
- Did the test fail before the fix for the right reason?
- Did I remove, rather than add, deterministic pathing where possible?
- Did I avoid content/word-based routing?
- Did I avoid hidden identifier conversion or source precedence?
- Did I avoid broad final-answer surgery?
- Did I keep schema validation as validation, not normalization?
- Did I leave unrelated user changes alone?
- Did I update tests/evals to guard the actual contract?
- Did I run `bun run typecheck` and the relevant Bun tests?

## When To Stop And Re-Plan

Stop and re-plan if:

- The only fix you can think of is `includes(...)`, `match(...)`, or a regex on model/tool prose.
- The test can only be made red by mocking the model into a bad call.
- The fix needs to special-case a single observed answer.
- The code must silently guess what the model meant.
- The branch adds a second source of truth for identifiers, table names, or widget mappings.
- A prompt change grows into a long incident-specific explanation.
- You are about to remove user text from the final answer because it "looks duplicated".

In these cases, find the root contract. Usually it is one of:

- Wrong tool description.
- Ambiguous prompt rule.
- Missing schema validation.
- Missing typed payload.
- UI renderer issue.
- Test/eval at the wrong layer.

## Commit Discipline

- Do not commit unless the user asks.
- If committing, stage only files relevant to the fix.
- Never include unrelated dirty files or generated logs by accident.
- Mention untracked or intentionally excluded files in the final response.
