// tests/unit/mcp-server/tools/backend/tako/map-results.test.ts
import { describe, it, expect } from "bun:test";
import {
  mapSearchResult,
  mapAnswerResult,
  mapContentsResult,
  deriveTableName,
} from "../../../../../../mcp-server/src/tools/backend/tako/map-results";

const SEARCH_STRUCTURED = {
  cards: [
    {
      card_id: "c1",
      title: "US GDP Growth",
      webpage_url: "https://tako.com/card/c1",
      image_url: "https://img.tako.com/c1.png",
      embed_url: "https://embed.tako.com/c1",
      exportable: true,
    },
    {
      card_id: "c2",
      title: "US GDP per Capita",
      webpage_url: "https://tako.com/card/c2",
    },
  ],
  web_results: [
    { title: "BEA GDP release", url: "https://bea.gov/gdp", snippet: "..." },
  ],
  request_id: "req-1",
};

describe("mapSearchResult", () => {
  it("emits text + citations for cards and web results + top-card artifact", () => {
    const items = mapSearchResult("summary text", SEARCH_STRUCTURED);
    const citations = items.filter((i) => i.text.includes('"citation"'));
    const artifacts = items.filter((i) => i.text.includes('"artifact"'));
    expect(citations).toHaveLength(3); // 2 cards + 1 web result
    expect(artifacts).toHaveLength(1);
    const textEntry = items.find((i) => i.text.startsWith("summary text"));
    expect(textEntry?.text).toContain("displayed in the workspace");
  });

  it("top-card artifact embeds iframe AND image fallback AND source link", () => {
    const items = mapSearchResult("t", SEARCH_STRUCTURED);
    const artifactEntry = items.find((i) => i.text.includes('"artifact"'));
    const parsed = JSON.parse(artifactEntry!.text) as {
      artifact: { type: string; content: string; name: string };
    };
    expect(parsed.artifact.type).toBe("html");
    expect(parsed.artifact.name).toBe("US GDP Growth");
    expect(parsed.artifact.content).toContain('src="https://embed.tako.com/c1"');
    expect(parsed.artifact.content).toContain('src="https://img.tako.com/c1.png"');
    expect(parsed.artifact.content).toContain('href="https://tako.com/card/c1"');
  });

  it("no artifact and no ack when the top card has neither embed nor image url", () => {
    const structured = {
      cards: [{ title: "Bare", webpage_url: "https://tako.com/card/x" }],
      web_results: [],
    };
    const items = mapSearchResult("plain", structured);
    expect(items.some((i) => i.text.includes('"artifact"'))).toBe(false);
    expect(items[0]?.text).toBe("plain");
  });

  it("dedupes citations by url", () => {
    const structured = {
      cards: [
        { title: "A", webpage_url: "https://same.url" },
        { title: "B", webpage_url: "https://same.url" },
      ],
      web_results: [],
    };
    const items = mapSearchResult("t", structured);
    const citations = items.filter((i) => i.text.includes('"citation"'));
    expect(citations).toHaveLength(1);
  });

  it("falls back to plain text passthrough on invalid structuredContent", () => {
    const items = mapSearchResult("the raw text", { cards: "not-an-array" });
    expect(items).toHaveLength(1);
    expect(items[0]?.text).toBe("the raw text");
  });

  it("falls back to plain text when structured is undefined", () => {
    const items = mapSearchResult("raw", undefined);
    expect(items).toHaveLength(1);
    expect(items[0]?.text).toBe("raw");
  });

  it("drops a javascript: embed_url but keeps a valid image_url in the artifact", () => {
    const structured = {
      cards: [
        {
          title: "Bad Embed",
          embed_url: "javascript:alert(1)",
          image_url: "https://img.tako.com/ok.png",
        },
      ],
      web_results: [],
    };
    const items = mapSearchResult("t", structured);
    const artifactEntry = items.find((i) => i.text.includes('"artifact"'));
    expect(artifactEntry).toBeDefined();
    const parsed = JSON.parse(artifactEntry!.text) as { artifact: { content: string } };
    expect(parsed.artifact.content).toContain('src="https://img.tako.com/ok.png"');
    expect(parsed.artifact.content).not.toContain("javascript:");
  });

  it("emits no artifact, no ack, and no citation when the card's only urls are javascript:", () => {
    const structured = {
      cards: [
        {
          title: "All Bad",
          embed_url: "javascript:alert(1)",
          webpage_url: "javascript:alert(1)",
        },
      ],
      web_results: [],
    };
    const items = mapSearchResult("plain text", structured);
    expect(items.some((i) => i.text.includes('"artifact"'))).toBe(false);
    expect(items.some((i) => i.text.includes('"citation"'))).toBe(false);
    const textEntry = items.find((i) => i.text.startsWith("plain text"));
    expect(textEntry?.text).toBe("plain text");
  });

  it("salvages valid cards and web results when one web_results entry is malformed", () => {
    const structured = {
      cards: [
        {
          title: "Good Card",
          webpage_url: "https://tako.com/card/good",
          image_url: "https://img.tako.com/good.png",
        },
      ],
      web_results: [
        { title: "Good Web Result", url: "https://good.example.com" },
        { snippet: "no url" },
      ],
    };
    const items = mapSearchResult("t", structured);
    expect(items.some((i) => i.text.includes('"artifact"'))).toBe(true);
    const citations = items.filter((i) => i.text.includes('"citation"'));
    expect(citations).toHaveLength(2);
  });
});

describe("mapAnswerResult", () => {
  it("extracts markdown links as citations, deduped, capped at 10", () => {
    const links = Array.from({ length: 12 }, (_, i) => `[Source ${i}](https://s.com/${i})`).join(" ");
    const text = `US GDP grew 2.8% [BEA](https://bea.gov/gdp) [BEA](https://bea.gov/gdp) ${links}`;
    const items = mapAnswerResult(text);
    expect(items[0]?.text).toBe(text);
    const citations = items.filter((i) => i.text.includes('"citation"'));
    expect(citations).toHaveLength(10);
    const first = JSON.parse(citations[0]!.text) as { citation: { url: string; title: string } };
    expect(first.citation.url).toBe("https://bea.gov/gdp");
    expect(first.citation.title).toBe("BEA");
  });

  it("returns just the text when no links are present", () => {
    const items = mapAnswerResult("no links here");
    expect(items).toHaveLength(1);
  });
});

describe("mapContentsResult", () => {
  it("maps json records to a sqlite_table item + ack text", () => {
    const structured = {
      records: [
        { year: 2023, gdp: 27.7 },
        { year: 2024, gdp: 29.0 },
      ],
      format: "json_records",
      total_rows: 50,
      truncated: true,
    };
    const items = mapContentsResult("ignored upstream text", structured, "us_gdp");
    const table = JSON.parse(items[0]!.text) as {
      $rita_kind: string;
      name: string;
      rows: unknown[];
    };
    expect(table.$rita_kind).toBe("sqlite_table");
    expect(table.name).toBe("us_gdp");
    expect(table.rows).toHaveLength(2);
    expect(items[1]?.text).toContain('SQL table "us_gdp"');
    expect(items[1]?.text).toContain("2 rows");
    expect(items[1]?.text).toContain("truncated");
  });

  it("passes web page text through when no records", () => {
    const structured = { data: "full page text", truncated: false };
    const items = mapContentsResult("full page text", structured, "unused");
    expect(items).toHaveLength(1);
    expect(items[0]?.text).toBe("full page text");
  });

  it("passes text through on invalid structured", () => {
    const items = mapContentsResult("raw", 42, "unused");
    expect(items).toHaveLength(1);
    expect(items[0]?.text).toBe("raw");
  });
});

describe("deriveTableName", () => {
  it("sanitizes an override into a sql-safe snake_case name", () => {
    expect(deriveTableName("https://x.com", "My Table! 2024")).toBe("my_table_2024");
  });

  it("prefixes names that start with a digit", () => {
    expect(deriveTableName("https://x.com", "2024 revenue")).toBe("t_2024_revenue");
  });

  it("derives from url host + last path segment when no override", () => {
    expect(deriveTableName("https://tako.com/card/us-gdp-growth")).toBe("tako_tako_us_gdp_growth");
  });

  it("falls back to tako_data on unparseable input", () => {
    expect(deriveTableName("not a url")).toBe("tako_data");
    expect(deriveTableName("https://x.com", "!!!")).toBe("tako_data");
  });
});
