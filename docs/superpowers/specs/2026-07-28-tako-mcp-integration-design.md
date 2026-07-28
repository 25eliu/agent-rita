# Tako integration for the companion MCP server

**Date:** 2026-07-28
**Status:** Approved design, pending implementation plan

## Motivation

Rita is a financial copilot. Tako serves live, licensed financial, macroeconomic,
and web-traffic data as citation-backed charts, plus live web search. That is
core-domain data for OpenBB users, not a generic capability. Compared to the
existing Tavily `web_search`:

- Licensed data (company financials via S&P Global, FRED/OECD/BIS macro,
  SimilarWeb traffic) that the open web does not have.
- Benchmark results on real-time domain questions (finance, economics, sports)
  beat general web-search APIs while using fewer tool calls at lower cost, with
  parity on general-web benchmarks (SimpleQA, FRAMES).
- Works keyless: Tako's hosted MCP endpoint has an anonymous free tier, so a
  fresh clone of this repo gets search working with zero configuration, where
  Tavily requires `TAVILY_API_KEY`.
- Deep integration with Rita's typed result protocol: charts render as
  artifacts, sources land in the citation collection, and fetched rows become
  SQL-queryable tables. A generic Workspace-side MCP registration of
  `mcp.tako.com` gets none of that (plain text only).

The agent (`src/`) is untouched. Everything below lives in the companion MCP
server, per the thin-harness rule: stateless third-party capabilities belong in
`mcp-server/`.

## Architecture

### Transport

The companion server calls Tako's hosted MCP endpoint
(`https://mcp.tako.com/mcp`) as an MCP client, using the already-installed
`@modelcontextprotocol/sdk` (`Client` + `StreamableHTTPClientTransport`).

- No `TAKO_API_TOKEN`: connect anonymously. Free tier serves `tako_search`,
  `tako_answer`, `tako_available_data` at 10 requests/min per IP.
- `TAKO_API_TOKEN` set: send `Authorization: Bearer <token>`; full toolset and
  the account's own limits.

This does not violate "the agent never opens MCP connections": that rule is
about the agent process. The companion server already makes outbound HTTP calls
to Tavily, Daytona, and OpenAI; an outbound MCP client connection is the same
class of dependency. The Workspace remains the only MCP client the agent knows
about.

The client is a lazy singleton: created on first tool call, reused across
calls, reconnected once on transport/session error before failing the call.

### Files

```
mcp-server/src/tools/backend/tako/
├── client.ts          # lazy singleton MCP client, auth header, reconnect-once
├── search.ts          # takoSearchSchema / Description / Handler
├── answer.ts          # takoAnswerSchema / Description / Handler
├── available-data.ts  # takoAvailableDataSchema / Description / Handler
├── contents.ts        # takoContentsSchema / Description / Handler
└── map-results.ts     # Zod validation of Tako structuredContent → Rita typed items
```

Each tool file follows the repo convention: export `<name>Schema` (Zod raw
shape with `.describe()` on every field), `<name>Description`, `<name>Handler`.
Handlers call `client.ts` (`tools/call` on the upstream server) and map the
result via `map-results.ts`.

Tako's MCP server returns `structuredContent` (typed JSON) alongside its text
output. `map-results.ts` validates it with Zod `.parse()`/`.safeParse()` at the
boundary (never `as`), and degrades gracefully: if `structuredContent` is
missing or fails validation, pass the upstream `content` text through as a
plain `textItem` (the model still gets a usable answer; only artifacts,
citations, and tables are lost for that call).

### Registration (mcp-server/src/server.ts)

Follows the existing `mermaidEnabled` / `codeExecEnabled` gating pattern:

```
const takoEnabled = process.env.TAKO_ENABLED !== "false";
const takoAuthed = !!process.env.TAKO_API_TOKEN;

if (takoEnabled) {
  mcp.tool("tako_search", ...);
  mcp.tool("tako_answer", ...);
  mcp.tool("tako_available_data", ...);
  if (takoAuthed) mcp.tool("tako_contents", ...);   // auth-only upstream
} else {
  mcp.tool("web_search", ...);                       // Tavily fallback
  logger.warn("TAKO_ENABLED=false — using Tavily web_search fallback");
}
```

- `web_search` (Tavily) is registered **only when Tako is disabled**. The free
  tier means Tako is always "present", so the fallback is an explicit env
  opt-out, not a runtime probe. This is a config-level registration
  conditional, not content routing, and is therefore within the harness rules.
- `fetch_webpage` stays registered unconditionally (unchanged; Tako does not
  replace generic page fetch).
- The `GET /` descriptor's `tools.backend` array gains the conditional
  entries, mirroring the mermaid/compute pattern.

No agent-side changes: `tako_*` names do not collide with agent-owned tools,
so `src/mcp/factory.ts`'s filter list is untouched, and `buildSystemPrompt`
advertises the tools automatically from the post-filter entries.

## Tool surface and result mapping

| Tool | Availability | Returns (Rita typed items) |
|---|---|---|
| `tako_search` | always (free tier) | `textItem` (Tako's LLM-optimized text, passed through) + `webCitationItem` per card source and web result + one `artifactItem` html artifact for the **top card** |
| `tako_answer` | always (free tier) | `textItem` (grounded prose) + `webCitationItem` per source |
| `tako_available_data` | always (free tier) | `textItem` only (coverage discovery) |
| `tako_contents` | `TAKO_API_TOKEN` only | CSV rows → `sqliteTableItem(name, rows)` + `textItem` ack naming the table; non-tabular content → `textItem` |

Notes:

- **Top-card artifact.** Artifact shape matches mermaid's:
  `{type: "html", uuid: crypto.randomUUID(), name, description, content}`.
  The text item includes a delivery-ack line ("chart displayed in the
  workspace, do not re-describe it") mirroring the mermaid pattern, so the
  model does not repeat the chart in prose. Only the top card gets an
  artifact; remaining cards appear as citations + text.
- **Sanitizer spike (implementation gate).** The Workspace sanitizes HTML
  artifacts (it strips `foreignObject` from mermaid SVGs). Before committing to
  an iframe of the card's `embed_url`, verify an iframe survives the
  sanitizer. Decision rule: iframe `embed_url` if it renders; otherwise a
  static `<img src="{image_url}">` wrapped in a link to `webpage_url`.
- **`tako_contents` tables.** Table names are derived from the card/source
  title, slugified, and deduped against a simple counter suffix. Rows flow
  through the standard `sqlite_table` path into the agent's `pendingTables`,
  making Tako data queryable by the in-process SQL family with zero agent
  changes.
- **Descriptions.** Tool descriptions differentiate against the rest of the
  surface: `tako_search`/`tako_answer` emphasize live financial, macro, and
  traffic data with citation-backed charts plus general web search;
  `tako_available_data` is the cheap coverage probe to call before guessing;
  `tako_contents` fetches full underlying rows for a result already found.
  Input schemas mirror the upstream Tako MCP schemas (subset where sensible),
  with every field `.describe()`d.

## Configuration

New env vars (companion server only), added to `.env.example` and README:

```
TAKO_API_TOKEN   # Optional — bearer token for full toolset + account limits
                 # (free anonymous tier used when unset)
TAKO_ENABLED     # Optional — "false" disables Tako and restores Tavily web_search
TAKO_MCP_URL     # Optional — override upstream endpoint (default https://mcp.tako.com/mcp)
```

## Error handling

- 15s `AbortController` timeout per upstream call (matches `web_search`).
- Upstream 429 / free-tier rate limit: friendly `textItem` explaining the
  limit and suggesting `TAKO_API_TOKEN` for higher limits. Never a crash.
- Unexpected upstream shape: `safeParse`, log the failure with context, fall
  back to passing the raw text through (see Architecture). If there is no
  usable text either, return a clear retryable error message as `textItem`.
- Transport/session errors: reconnect the singleton client once, then surface
  the error as a `textItem` if it persists.

## Testing

Tier 1 unit tests in `tests/unit/mcp-server/tools/backend/tako/`, mirroring
source layout, with the upstream MCP client mocked (fixture
`structuredContent` payloads captured from real Tako responses):

- Registration gating: enabled by default; `TAKO_ENABLED=false` swaps in
  `web_search`; `tako_contents` only with token.
- `map-results`: cards → citations + top-card artifact; answer sources →
  citations; CSV rows → `sqliteTableItem` with slugified names; missing/invalid
  `structuredContent` → text passthrough.
- Error paths: 429 → friendly text; timeout → abort message; reconnect-once.

Tier 3: one eval case in `evals/cases/mcp-routing/` asserting the model picks
`tako_search` for a live financial-data question (grader: `toolCalled`).

## Documentation updates

- README: tool table (add four Tako rows, note the Tavily fallback condition),
  env var section, prerequisites note ("Tako works keyless on the free tier"),
  FAQ entry for "why did web_search disappear / how do I get Tavily back",
  and a note that users should not also register `mcp.tako.com` directly in
  the Workspace while the companion server is running (duplicate tool names).
- CLAUDE.md: no changes (no new agent-level gotchas).

## Out of scope (YAGNI)

- Tako graph tools, `tako_visualize`, `tako_agent_start`/`tako_agent_wait`.
- Any agent (`src/`) changes.
- Runtime reachability probing of the Tako endpoint at boot.
- Workspace-side registration docs for `mcp.tako.com` as an alternative path.
