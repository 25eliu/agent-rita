import { z } from "zod";
import type { AgentTool } from "../protocol/types";

export function sanitizeMcpToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
}

type JsonSchemaProp = Record<string, unknown> & {
  type?: string | string[];
  enum?: unknown[];
  anyOf?: JsonSchemaProp[];
  oneOf?: JsonSchemaProp[];
  allOf?: JsonSchemaProp[];
  const?: unknown;
  description?: string;
  nullable?: boolean;
  items?: JsonSchemaProp;
  properties?: Record<string, JsonSchemaProp>;
  required?: string[];
};

function jsonSchemaToZod(prop: JsonSchemaProp): z.ZodTypeAny {
  if (prop.const !== undefined) {
    const literal = z.literal(prop.const as string | number | boolean);
    return prop.description ? literal.describe(prop.description) : literal;
  }

  if (Array.isArray(prop.enum) && prop.enum.length > 0) {
    const stringValues = prop.enum.filter((v): v is string => typeof v === "string");
    if (stringValues.length === prop.enum.length && stringValues.length > 0) {
      const enumSchema = z.enum(stringValues as [string, ...string[]]);
      return prop.description ? enumSchema.describe(prop.description) : enumSchema;
    }
    const literals: z.ZodTypeAny[] = prop.enum.map((v) =>
      z.literal(v as string | number | boolean),
    );
    if (literals.length === 1) return literals[0];
    const union = z.union(literals as unknown as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
    return prop.description ? union.describe(prop.description) : union;
  }

  if (Array.isArray(prop.anyOf) && prop.anyOf.length > 0) {
    return buildUnion(prop.anyOf, prop.description);
  }
  if (Array.isArray(prop.oneOf) && prop.oneOf.length > 0) {
    return buildUnion(prop.oneOf, prop.description);
  }

  const types = Array.isArray(prop.type) ? prop.type : prop.type ? [prop.type] : [];
  const nullable = prop.nullable === true || types.includes("null");
  const nonNullTypes = types.filter((t) => t !== "null");

  const baseSchema = nonNullTypes.length > 1
    ? buildUnion(nonNullTypes.map((t) => ({ ...prop, type: t, nullable: false } as JsonSchemaProp)))
    : nonNullTypes.length === 1
      ? buildSingleTypeSchema(nonNullTypes[0], prop)
      : z.unknown();

  const withNullable = nullable ? baseSchema.nullable() : baseSchema;
  return prop.description && !withNullable.description
    ? withNullable.describe(prop.description)
    : withNullable;
}

function buildUnion(schemas: JsonSchemaProp[], description?: string): z.ZodTypeAny {
  const zodSchemas = schemas.map(jsonSchemaToZod);
  if (zodSchemas.length === 1) {
    return description ? zodSchemas[0].describe(description) : zodSchemas[0];
  }
  const union = z.union(zodSchemas as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
  return description ? union.describe(description) : union;
}

function buildSingleTypeSchema(type: string, prop: JsonSchemaProp): z.ZodTypeAny {
  switch (type) {
    case "string":
      return z.string();
    case "number":
    case "integer":
      return z.number();
    case "boolean":
      return z.boolean();
    case "null":
      return z.null();
    case "array":
      return prop.items ? z.array(jsonSchemaToZod(prop.items)) : z.array(z.unknown());
    case "object": {
      if (!prop.properties) return z.record(z.string(), z.unknown());
      const shape: Record<string, z.ZodTypeAny> = {};
      const required = new Set(prop.required ?? []);
      for (const [key, sub] of Object.entries(prop.properties)) {
        let s = jsonSchemaToZod(sub);
        if (!required.has(key)) s = s.optional();
        shape[key] = s;
      }
      return z.object(shape);
    }
    default:
      return z.unknown();
  }
}

/**
 * Keys with this prefix are agent-managed decoration (e.g.
 * x-agentrita-conversation-id, x-agentrita-tables). They MUST NOT be exposed
 * to the LLM — the agent injects them on the way out, the MCP server reads
 * them on the way in. Stripping them from the model-facing schema avoids the
 * model hallucinating values for them.
 */
const INTERNAL_PARAM_PREFIX = "x-agentrita-";
const DISPLAY_SUMMARY_DESCRIPTION =
  "Display-only progress summary shown to the user before the tool runs. " +
  "Use a short human-readable gerund phrase, e.g. 'Checking renewable energy trend'. " +
  "The UI shows this directly as the progress message. " +
  "This value is not forwarded to the MCP tool and does not replace required arguments.";

export function buildToolInputSchema(
  inputSchema?: AgentTool["input_schema"],
): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const shape: Record<string, z.ZodTypeAny> = {
    display_summary: z.string().optional().describe(DISPLAY_SUMMARY_DESCRIPTION),
  };
  if (!inputSchema?.properties) return z.object(shape);

  const required = new Set(inputSchema.required ?? []);

  for (const [key, prop] of Object.entries(inputSchema.properties)) {
    if (key === "display_summary") continue;
    if (key.startsWith(INTERNAL_PARAM_PREFIX)) continue;
    let zodProp = jsonSchemaToZod(prop as JsonSchemaProp);
    if (!required.has(key)) zodProp = zodProp.optional();
    shape[key] = zodProp;
  }

  return z.object(shape);
}
