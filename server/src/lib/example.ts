// Annotated-example parsing + schema derivation. The left-hand "Input" editor
// lets someone author a plain JSON example with lightweight `--` comments
// instead of hand-writing JSON Schema. This module turns that text into
// `properties`/`required`, which the schema PUT route
// (server/src/routes/schemas.ts) merges into the saved schema.
//
// Fields are OPTIONAL by default — presence in the example only defines the
// field's shape, not its required-ness. A field becomes required via the
// `required` directive in its comment, or via the separate x-required-fields
// list applied at resolve time (see resolver.ts's applyRequiredPaths).
//
// Comment placement supported:
//   "key": value,   -- trailing comment describing `key`
//   -- comment on its own line, describing the *next* key's line
//
// Comment content is `directive[; directive]* description?`, e.g.:
//   "status": "active",  -- required
//   "amount": 129.99,    -- required; Order total before tax
//   "notes": "",         -- Freeform notes (no directive = optional, description only)
//   "contact": {...},    -- component: contact
//   "shippingAddress": {...}, -- component: address; required
// Recognized directives today are `required` and `component: <name>` (links
// the field to an already-existing component instead of inferring its shape
// from the example — see deriveProperties); anything else in the comment is
// treated as description text.
//
// A "--" inside a JSON string value is not mistaken for a comment start —
// the scanner tracks whether it's inside a string literal.

export interface DerivedSchema {
  properties: Record<string, unknown>;
  required: string[];
}

// Strips `--` comments from `source`, returning the now-plain JSON text, a
// map of dot-path -> description text, the set of dot-paths whose comment
// carried the `required` directive, and a map of dot-path -> component name
// for paths whose comment carried the `component: <name>` directive.
export function stripComments(
  source: string,
): { json: string; comments: Map<string, string>; requiredPaths: Set<string>; componentRefs: Map<string, string> } {
  const lines = source.split("\n");
  const comments = new Map<string, string>();
  const requiredPaths = new Set<string>();
  const componentRefs = new Map<string, string>();
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
      if (text) {
        const { required, component, description } = parseDirectives(text);
        if (required) requiredPaths.add(path);
        if (component) componentRefs.set(path, component);
        if (description) comments.set(path, description);
      }
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

  return { json: jsonLines.join("\n"), comments, requiredPaths, componentRefs };
}

// Splits a comment's text into directives and freeform description,
// separated by `;`. Recognized directives are `required` (case-insensitive)
// and `component: <name>` (case-insensitive keyword); everything else joins
// back into the description.
function parseDirectives(text: string): { required: boolean; component?: string; description?: string } {
  const parts = text.split(";").map((s) => s.trim());
  let required = false;
  let component: string | undefined;
  const rest: string[] = [];
  const COMPONENT_DIRECTIVE = /^component:\s*(.+)$/i;
  for (const part of parts) {
    const componentMatch = COMPONENT_DIRECTIVE.exec(part);
    if (part.toLowerCase() === "required") {
      required = true;
    } else if (componentMatch) {
      component = componentMatch[1].trim();
    } else if (part.length > 0) {
      rest.push(part);
    }
  }
  return { required, component, description: rest.length > 0 ? rest.join("; ") : undefined };
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

// A base property counts as an "open extension point" when it's a plain
// object with no declared shape of its own (type: "object", no `properties`,
// additionalProperties: true) — e.g. base's "details" field. Everything else
// (id, createdAt, ...) is fully locked, unchanged. Schemas may layer their
// own typed sub-fields inside an open field (see deriveProperties below and
// resolveSchema's merge in resolver.ts); closed fields stay untouchable.
export function isOpenExtensionPoint(schema: unknown): boolean {
  const s = schema as Record<string, unknown> | undefined;
  return !!s && s.type === "object" && !s.properties && s.additionalProperties === true;
}

// Walks a parsed example value into properties/required. Fields are
// OPTIONAL by default — a key only becomes required if its path is in
// `requiredPaths` (populated by the `required` comment directive, see
// stripComments). A field whose path is in `componentRefs` (populated by the
// `component: <name>` comment directive) skips inference entirely and gets a
// fresh `{"$ref": "components/<name>.schema.json"}` — this works at any
// depth, not just top-level. Any top-level field whose *existing* schema is
// already a bare $ref is preserved untouched rather than replaced with an
// inferred inline shape, so component wiring from a prior Apply or Extract
// Component survives being re-derived from the example. Top-level keys that
// belong to the family's locked base (baseFields) are normally skipped
// entirely — base exclusively owns those fields — *except* when the base
// field is an open extension point, in which case its nested shape IS
// derived (ending up in this schema's own properties[key]), to be merged
// into base's generic definition by resolveSchema (see resolver.ts) for
// this schema only.
export function deriveProperties(
  exampleValue: unknown,
  existingProperties: Record<string, unknown>,
  comments: Map<string, string>,
  requiredPaths: Set<string>,
  pathPrefix = "",
  isTopLevel = true,
  baseFields: Map<string, Record<string, unknown>> = new Map(),
  componentRefs: Map<string, string> = new Map(),
): DerivedSchema {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  if (!exampleValue || typeof exampleValue !== "object" || Array.isArray(exampleValue)) {
    return { properties, required };
  }

  for (const [key, value] of Object.entries(exampleValue as Record<string, unknown>)) {
    if (isTopLevel && baseFields.has(key) && !isOpenExtensionPoint(baseFields.get(key))) {
      continue;
    }

    const path = pathPrefix ? `${pathPrefix}.${key}` : key;
    if (requiredPaths.has(path)) required.push(key);

    const componentName = componentRefs.get(path);
    if (componentName) {
      properties[key] = { $ref: `components/${componentName}.schema.json` };
      continue;
    }

    const existing = existingProperties[key] as Record<string, unknown> | undefined;
    if (isTopLevel && existing && isBareRef(existing)) {
      // Preserve component wiring — don't clobber a $ref with an inferred shape.
      properties[key] = existing;
      continue;
    }

    properties[key] = deriveNode(value, comments, requiredPaths, path, existing, componentRefs);
  }

  return { properties, required };
}

function deriveNode(
  value: unknown,
  comments: Map<string, string>,
  requiredPaths: Set<string>,
  path: string,
  existing: Record<string, unknown> | undefined,
  componentRefs: Map<string, string>,
): Record<string, unknown> {
  const description = comments.get(path);

  if (value === null) {
    return withDescription({ type: "null" }, description);
  }
  if (Array.isArray(value)) {
    const itemsExisting = existing?.items as Record<string, unknown> | undefined;
    const items =
      value.length > 0
        ? deriveNode(value[0], comments, requiredPaths, `${path}.items`, itemsExisting, componentRefs)
        : (itemsExisting ?? {});
    return withDescription({ type: "array", items }, description);
  }
  if (typeof value === "object") {
    const nested = deriveProperties(
      value,
      (existing?.properties as Record<string, unknown>) ?? {},
      comments,
      requiredPaths,
      path,
      false,
      undefined,
      componentRefs,
    );
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

export interface ParseAndDeriveResult extends DerivedSchema {
  // Dot-path -> component name, for every field that got a fresh $ref from
  // a `component: <name>` comment directive in this Apply. The route layer
  // validates these against the family's actual components before saving.
  componentRefs: Map<string, string>;
}

export function parseAndDerive(
  source: string,
  existingProperties: Record<string, unknown>,
  base: BaseSummary,
): ParseAndDeriveResult {
  const { json, comments, requiredPaths, componentRefs } = stripComments(source);
  const parsed = JSON.parse(json);

  const exampleKeys = new Set(
    parsed && typeof parsed === "object" && !Array.isArray(parsed) ? Object.keys(parsed) : [],
  );
  const missing = base.required.filter((field) => !exampleKeys.has(field));
  if (missing.length > 0) {
    throw new MissingBaseFieldsError(missing);
  }

  const baseFields = new Map(Object.entries(base.properties)) as Map<string, Record<string, unknown>>;
  const derived = deriveProperties(parsed, existingProperties, comments, requiredPaths, "", true, baseFields, componentRefs);
  return { ...derived, componentRefs };
}
