// Annotated-example parsing + schema derivation. The left-hand "Input" editor
// lets someone author a plain JSON example with lightweight `--` comments
// (description-only this pass) instead of hand-writing JSON Schema. This
// module turns that text into `properties`/`required`, which the schema PUT
// route (server/src/routes/schemas.ts) merges into the saved schema.
//
// Comment placement supported:
//   "key": value,   -- trailing comment describing `key`
//   -- comment on its own line, describing the *next* key's line
//
// A "--" inside a JSON string value is not mistaken for a comment start —
// the scanner tracks whether it's inside a string literal.

export interface DerivedSchema {
  properties: Record<string, unknown>;
  required: string[];
}

// Strips `--` comments from `source`, returning the now-plain JSON text plus
// a map of dot-path -> comment text for every field a comment was attached
// to (trailing on the field's own line, or on the line directly above it).
export function stripComments(source: string): { json: string; comments: Map<string, string> } {
  const lines = source.split("\n");
  const comments = new Map<string, string>();
  const pathStack: string[] = [];
  const jsonLines: string[] = [];
  let pendingComment: string | null = null;

  const KEY_LINE = /^\s*"([^"]+)"\s*:\s*(.*?)\s*,?\s*$/;

  for (const line of lines) {
    const { code, comment } = splitTrailingComment(line);
    const trimmedCode = code.trim();

    if (trimmedCode.length === 0) {
      // Comment-only (or blank) line — remember it for whichever key line
      // follows.
      if (comment) pendingComment = comment;
      jsonLines.push(code);
      continue;
    }

    const match = KEY_LINE.exec(trimmedCode);
    if (match) {
      const key = match[1];
      const valueStart = match[2];
      const path = [...pathStack, key].join(".");
      const text = comment ?? pendingComment ?? undefined;
      if (text) comments.set(path, text);
      pendingComment = null;

      // Track nesting so later keys get the right dot-path.
      if (valueStart.startsWith("{") && !valueStart.includes("}")) {
        pathStack.push(key);
      }
    } else {
      pendingComment = null;
    }

    if (trimmedCode === "}" || trimmedCode === "},") {
      pathStack.pop();
    }

    jsonLines.push(code);
  }

  return { json: jsonLines.join("\n"), comments };
}

// Splits a line into its JSON code and trailing `-- comment`, ignoring any
// "--" that appears inside a string literal.
function splitTrailingComment(line: string): { code: string; comment: string | null } {
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && line[i - 1] !== "\\") {
      inString = !inString;
      continue;
    }
    if (!inString && ch === "-" && line[i + 1] === "-") {
      return { code: line.slice(0, i), comment: line.slice(i + 2).trim() };
    }
  }
  return { code: line, comment: null };
}

// Walks a parsed example value into properties/required. Every present key
// becomes required (an example is "what a complete valid instance
// contains" — there's no way to mark a field optional this pass). Any
// top-level field whose *existing* schema is a bare $ref is preserved
// untouched rather than replaced with an inferred inline shape, so
// component wiring (e.g. "contact": {"$ref": "components/contact.schema.json"})
// survives being re-derived from the example. Top-level keys that belong to
// the family's locked base (baseFieldNames) are skipped entirely — base
// exclusively owns those fields, so re-deriving them here would either
// duplicate or (worse) collide with the base's own definition.
export function deriveProperties(
  exampleValue: unknown,
  existingProperties: Record<string, unknown>,
  comments: Map<string, string>,
  pathPrefix = "",
  isTopLevel = true,
  baseFieldNames: Set<string> = new Set(),
): DerivedSchema {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  if (!exampleValue || typeof exampleValue !== "object" || Array.isArray(exampleValue)) {
    return { properties, required };
  }

  for (const [key, value] of Object.entries(exampleValue as Record<string, unknown>)) {
    if (isTopLevel && baseFieldNames.has(key)) continue;

    const path = pathPrefix ? `${pathPrefix}.${key}` : key;
    required.push(key);

    const existing = existingProperties[key] as Record<string, unknown> | undefined;
    if (isTopLevel && existing && isBareRef(existing)) {
      // Preserve component wiring — don't clobber a $ref with an inferred shape.
      properties[key] = existing;
      continue;
    }

    properties[key] = deriveNode(value, comments, path, existing);
  }

  return { properties, required };
}

function deriveNode(
  value: unknown,
  comments: Map<string, string>,
  path: string,
  existing: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const description = comments.get(path);

  if (value === null) {
    return withDescription({ type: "null" }, description);
  }
  if (Array.isArray(value)) {
    const itemsExisting = existing?.items as Record<string, unknown> | undefined;
    const items = value.length > 0 ? deriveNode(value[0], comments, `${path}.items`, itemsExisting) : (itemsExisting ?? {});
    return withDescription({ type: "array", items }, description);
  }
  if (typeof value === "object") {
    const nested = deriveProperties(value, (existing?.properties as Record<string, unknown>) ?? {}, comments, path, false);
    return withDescription(
      { type: "object", properties: nested.properties, required: nested.required },
      description,
    );
  }
  if (typeof value === "number") return withDescription({ type: "number" }, description);
  if (typeof value === "boolean") return withDescription({ type: "boolean" }, description);

  const { enumValues } = splitEnumValue(value as string);
  const schema: Record<string, unknown> = { type: "string" };
  if (enumValues) schema.enum = enumValues;
  return withDescription(schema, description);
}

// A leaf string value containing commas is read as declaring an enum:
// "card,check" -> enum: ["card","check"], with the first item used as this
// particular example's actual value for the field. A single value with no
// comma is unaffected. This is a lightweight convention rather than a full
// directive — note that a legitimate comma inside a plain string (e.g. a
// value like "Springfield, IL") would also be read as a two-value enum, so
// avoid commas in ordinary string values.
function splitEnumValue(raw: string): { value: string; enumValues?: string[] } {
  if (!raw.includes(",")) return { value: raw };
  const options = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (options.length <= 1) return { value: raw };
  return { value: options[0], enumValues: options };
}

// Applies the same comma -> enum convention to a parsed example value, but
// keeps only the representative (first) value — used to render a *valid*
// instance (the Primary example view) rather than a schema. Recurses into
// objects/arrays; leaves non-string leaves untouched.
export function applyExampleConventions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(applyExampleConventions);
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      result[key] = applyExampleConventions(val);
    }
    return result;
  }
  if (typeof value === "string") return splitEnumValue(value).value;
  return value;
}

function withDescription(schema: Record<string, unknown>, description: string | undefined): Record<string, unknown> {
  return description ? { ...schema, description } : schema;
}

function isBareRef(schema: Record<string, unknown>): boolean {
  return typeof schema.$ref === "string";
}

export interface BaseSummary {
  properties: Record<string, unknown>;
  required: string[];
}

// Thrown when the example is missing one or more of the family's locked
// base-required fields — base is the minimum every instance must show, the
// example is free to add more on top of it.
export class MissingBaseFieldsError extends Error {
  constructor(public readonly missingFields: string[]) {
    super(`Example is missing required base field(s): ${missingFields.join(", ")}`);
    this.name = "MissingBaseFieldsError";
  }
}

export function parseAndDerive(source: string, existingProperties: Record<string, unknown>, base: BaseSummary): DerivedSchema {
  const { json, comments } = stripComments(source);
  const parsed = JSON.parse(json);

  const exampleKeys = new Set(
    parsed && typeof parsed === "object" && !Array.isArray(parsed) ? Object.keys(parsed) : [],
  );
  const missing = base.required.filter((field) => !exampleKeys.has(field));
  if (missing.length > 0) {
    throw new MissingBaseFieldsError(missing);
  }

  const baseFieldNames = new Set(Object.keys(base.properties));
  return deriveProperties(parsed, existingProperties, comments, "", true, baseFieldNames);
}
