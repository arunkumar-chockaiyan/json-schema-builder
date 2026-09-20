// This module parses an annotated JSON example and derives a schema from
// it. The left-hand "Input" editor lets someone type a plain JSON example
// with lightweight `--` comments, instead of hand-writing JSON Schema. This
// module turns that text into `properties` and `required`. The schema PUT
// route (server/src/routes/schemas.ts) merges the result into the saved
// schema.
//
// Fields are OPTIONAL by default. A field's presence in the example only
// defines its shape, not whether it is required. Two things can make a
// field required: the `required` directive in its comment, or the separate
// x-required-fields list, applied at resolve time (see resolver.ts's
// applyRequiredPaths).
//
// A comment can appear in two places:
//   "key": value,   -- trailing comment describing `key`
//   -- comment on its own line, describing the *next* key's line
//
// Comment content has this shape: `directive[; directive]* description?`.
// Examples:
//   "status": "active",  -- required
//   "amount": 129.99,    -- required; Order total before tax
//   "notes": "",         -- Freeform notes (no directive = optional, description only)
//   "contact": {...},    -- component: contact
//   "shippingAddress": {...}, -- component: address; required
// There are two recognized directives: `required`, and `component: <name>`.
// The `component: <name>` directive links the field to an existing
// component, instead of inferring its shape from the example (see
// deriveProperties). Anything else in the comment is description text.
//
// A "--" inside a JSON string value is not read as a comment start. The
// scanner tracks whether it is inside a string literal.

export interface DerivedSchema {
  properties: Record<string, unknown>;
  required: string[];
}

// Strips `--` comments from `source`. Returns:
//   - the plain JSON text
//   - a map of dot-path to description text
//   - the set of dot-paths whose comment carried the `required` directive
//   - a map of dot-path to component name, for paths whose comment carried
//     the `component: <name>` directive
export function stripComments(source: string): { json: string; comments: Map<string, string>; requiredPaths: Set<string>; componentRefs: Map<string, string> } {
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
      // A comment-only or blank line. Remember its comment for the next key
      // line.
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

// Splits a comment's text into directives and a freeform description. Parts
// are separated by `;`. There are two recognized directives: `required`
// (case-insensitive) and `component: <name>` (the `component:` keyword is
// case-insensitive). Everything else joins back into the description.
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

// Splits a line into its JSON code and its trailing `-- comment`. Ignores
// any "--" that appears inside a string literal.
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

// A base property is an "open extension point" when it is a plain object
// with no declared shape of its own: type "object", no `properties`, and
// additionalProperties true. Base's "details" field is one example. Every
// other base field (id, createdAt, ...) is fully locked and never changes.
// A schema can add its own typed sub-fields inside an open extension point
// (see deriveProperties below, and resolveSchema's merge in resolver.ts). A
// closed field cannot be changed by any schema.
export function isOpenExtensionPoint(schema: unknown): boolean {
  const s = schema as Record<string, unknown> | undefined;
  return !!s && s.type === "object" && !s.properties && s.additionalProperties === true;
}

// Walks a parsed example value into properties and required.
//
// Fields are OPTIONAL by default. A key becomes required only when its path
// is in `requiredPaths`. (This set comes from the `required` comment
// directive. See stripComments.)
//
// A field whose path is in `componentRefs` (from the `component: <name>`
// comment directive) skips normal inference. It gets a fresh
// `{"$ref": "components/<name>.schema.json"}` instead. This works at any
// depth, not just at the top level.
//
// A top-level field whose *existing* schema is already a bare $ref is left
// untouched, instead of being replaced with an inferred inline shape. This
// way, a component link from a prior Apply or Extract Component survives
// when the example is re-derived.
//
// A top-level key that belongs to the family's locked base (baseFields) is
// normally skipped. Base owns those fields, not the schema. The one
// exception is an open extension point: its nested shape IS derived, into
// this schema's own properties[key]. resolveSchema (see resolver.ts) then
// merges that nested shape into base's generic definition, for this schema
// only.
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
      // Preserve the component link. Do not replace a $ref with an inferred
      // shape.
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

// A leaf string value that contains commas declares an enum. For example,
// "card,check" becomes enum: ["card","check"]. The tool uses the first item
// as this example's actual value for the field. A value with no comma is
// unaffected.
//
// This is a lightweight convention, not a full directive. A plain string
// that happens to contain a comma (for example, "Springfield, IL") is also
// read as a two-value enum. Avoid commas in ordinary string values.
function splitEnumValue(raw: string): { value: string; enumValues?: string[] } {
  if (!raw.includes(",")) return { value: raw };
  const options = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (options.length <= 1) return { value: raw };
  return { value: options[0], enumValues: options };
}

// Applies the same comma-to-enum convention to a parsed example value, but
// keeps only the representative (first) value. Used to render a *valid*
// instance (the Primary example view), not a schema. Recurses into objects
// and arrays. Leaves non-string leaves unchanged.
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

// Thrown when the example is missing one or more of the family's locked,
// required base fields. Base fields are the minimum every instance must
// show. The example is free to add more fields on top of them.
export class MissingBaseFieldsError extends Error {
  constructor(public readonly missingFields: string[]) {
    super(`Example is missing required base field(s): ${missingFields.join(", ")}`);
    this.name = "MissingBaseFieldsError";
  }
}

export interface ParseAndDeriveResult extends DerivedSchema {
  // Dot-path to component name, for every field that got a fresh $ref from
  // a `component: <name>` comment directive in this Apply. The route layer
  // checks each of these against the family's real components before
  // saving.
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
