// Resolves a schema into two forms:
//   - raw: the as-authored file, $refs intact (default editor view)
//   - resolved: base fields merged in (locked, must not collide) and every
//     components/*.schema.json $ref recursively dereferenced/inlined
//
// $ref convention: within a family, refs always look like
// "components/<name>.schema.json" regardless of whether they appear inside a
// schema or inside another component (component nesting). No cross-family
// refs, no external URLs — anything else is a hard error.

import { readBase, readComponent } from "./registryFs.js";
import { RegistryError } from "../types.js";
import { compileRules, validateRules, type Rule } from "./rules.js";
import { isOpenExtensionPoint } from "./example.js";

const COMPONENT_REF_PATTERN = /^components\/([^/]+)\.schema\.json$/;

type JsonValue = unknown;

export async function resolveSchema(family: string, schemaTitle: string, raw: unknown): Promise<unknown> {
  const base = await readBase(family);
  const resolvedRaw = await dereference(family, raw, []);

  const baseProps = getProperties(base);
  const schemaProps = getProperties(resolvedRaw);

  // Base fields are locked — a schema can't redeclare one — *unless* the
  // base field is an "open extension point" (e.g. "details": a generic,
  // schema-varying object with no declared shape of its own). In that case
  // the schema's derived sub-shape is merged into base's generic definition
  // for THIS schema's resolved output only; base itself and every other
  // schema are untouched.
  const mergedProperties: Record<string, unknown> = { ...baseProps };
  for (const [key, schemaProp] of Object.entries(schemaProps)) {
    if (key in baseProps) {
      const baseProp = baseProps[key] as Record<string, unknown>;
      if (!isOpenExtensionPoint(baseProp)) {
        throw new RegistryError(
          `Schema "${schemaTitle}" redeclares locked base field "${key}". Base fields cannot be overridden.`,
          409,
        );
      }
      const schemaPropObj = schemaProp as Record<string, unknown>;
      mergedProperties[key] = {
        ...baseProp,
        properties: schemaPropObj.properties ?? {},
        required: schemaPropObj.required ?? [],
      };
    } else {
      mergedProperties[key] = schemaProp;
    }
  }

  const merged = { ...(resolvedRaw as Record<string, unknown>) };
  merged.properties = mergedProperties;
  const baseRequired = Array.isArray((base as Record<string, unknown>)?.required)
    ? ((base as Record<string, unknown>).required as string[])
    : [];
  const schemaRequired = Array.isArray((resolvedRaw as Record<string, unknown>)?.required)
    ? ((resolvedRaw as Record<string, unknown>).required as string[])
    : [];
  merged.required = [...new Set([...baseRequired, ...schemaRequired])];

  // Explicit "required fields" list (x-required-fields, dot-paths) — a
  // second, independent way to mark a field required, edited via the
  // Constraints tab's picker rather than the example's `required` comment
  // directive. Applied here (resolve time, not baked into properties at
  // write time) so toggling it never needs a re-derivation, same reasoning
  // as x-rules being compiled fresh on every resolve rather than stored
  // pre-compiled. Authoring-only — stripped from what validators/consumers
  // see, same as x-rules/x-example-source below.
  const explicitRequiredFields = Array.isArray((merged as Record<string, unknown>)["x-required-fields"])
    ? ((merged as Record<string, unknown>)["x-required-fields"] as string[])
    : [];
  delete merged["x-required-fields"];

  if (explicitRequiredFields.length > 0) {
    const availableFields = flattenFieldPaths(merged.properties as Record<string, unknown>);
    for (const field of explicitRequiredFields) {
      if (!availableFields.has(field)) {
        throw new RegistryError(
          `Required-fields list references unknown field "${field}". Fields must already be declared on the schema.`,
          400,
        );
      }
    }
    applyRequiredPaths(merged, explicitRequiredFields);
  }

  // Conditional rules: validate against the fully merged field set, compile
  // to standard allOf/if/then for the resolved output, and strip the
  // structured x-rules (an authoring-only, round-trippable representation)
  // from what validators/consumers see.
  const rules = Array.isArray((merged as Record<string, unknown>)["x-rules"])
    ? ((merged as Record<string, unknown>)["x-rules"] as Rule[])
    : [];
  delete merged["x-rules"];
  // x-example-source (the annotated example text) is authoring-only too —
  // strip it from what validators/consumers see, same as x-rules above.
  delete merged["x-example-source"];

  if (rules.length > 0) {
    const availableFields = flattenFieldPaths(merged.properties as Record<string, unknown>);
    validateRules(rules, availableFields);
    const compiled = compileRules(rules);
    const existingAllOf = Array.isArray(merged.allOf) ? (merged.allOf as unknown[]) : [];
    merged.allOf = [...existingAllOf, ...compiled];
  }

  return merged;
}

export async function resolveComponent(family: string, raw: unknown): Promise<unknown> {
  return dereference(family, raw, []);
}

function getProperties(schema: unknown): Record<string, unknown> {
  const props = (schema as Record<string, unknown> | undefined)?.properties;
  return props && typeof props === "object" ? (props as Record<string, unknown>) : {};
}

// Recursively walks a resolved property tree, collecting every valid
// dot-path — both leaves and intermediate objects — for rule-field
// validation. Only descends into declared `properties` of `type: "object"`
// nodes (arrays/items are out of scope for nested rule targeting for now),
// so a bogus path like "amount.sub" is naturally excluded (amount isn't an
// object, so nothing under it is ever added).
function flattenFieldPaths(properties: Record<string, unknown>, prefix = ""): Set<string> {
  const paths = new Set<string>();
  for (const [key, value] of Object.entries(properties)) {
    const path = prefix ? `${prefix}.${key}` : key;
    paths.add(path);
    const schema = value as Record<string, unknown>;
    if (schema?.type === "object" && schema.properties && typeof schema.properties === "object") {
      for (const nested of flattenFieldPaths(schema.properties as Record<string, unknown>, path)) {
        paths.add(nested);
      }
    }
  }
  return paths;
}

// For each dot-path in `paths`, walks the already-merged/resolved tree
// (base merge, $ref dereference, and open-extension-point merge all already
// applied by the time this runs) and pushes the final segment into its
// *containing* level's `required` array, creating the array if missing and
// deduping. Mutates `merged` and its nested property nodes in place.
function applyRequiredPaths(merged: Record<string, unknown>, paths: string[]): void {
  for (const path of paths) {
    const segments = path.split(".");
    let cursor: Record<string, unknown> = merged;
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const isLast = i === segments.length - 1;
      if (isLast) {
        const existing = Array.isArray(cursor.required) ? (cursor.required as string[]) : [];
        if (!existing.includes(segment)) {
          cursor.required = [...existing, segment];
        }
      } else {
        const props = (cursor.properties as Record<string, unknown>) ?? {};
        cursor = props[segment] as Record<string, unknown>;
      }
    }
  }
}

// Recursively walks a JSON value, replacing any { "$ref": "components/x.schema.json" }
// node with the fully-dereferenced content of that component. `stack` tracks
// component names currently being resolved, to detect reference cycles.
async function dereference(family: string, value: JsonValue, stack: string[]): Promise<JsonValue> {
  if (Array.isArray(value)) {
    return Promise.all(value.map((item) => dereference(family, item, stack)));
  }

  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;

    if (typeof obj.$ref === "string") {
      const match = COMPONENT_REF_PATTERN.exec(obj.$ref);
      if (!match) {
        throw new RegistryError(
          `Unsupported $ref "${obj.$ref}". Only "components/<name>.schema.json" refs are allowed within a family.`,
          400,
        );
      }
      const componentName = match[1];

      if (stack.includes(componentName)) {
        throw new RegistryError(
          `Cycle detected in component references: ${[...stack, componentName].join(" -> ")}`,
          409,
        );
      }

      const componentRaw = await readComponent(family, componentName);
      const componentResolved = await dereference(family, componentRaw, [...stack, componentName]);

      // Any sibling keys alongside $ref (unusual, but allowed by JSON Schema
      // in some drafts) are merged on top of the dereferenced component.
      const { $ref: _drop, ...siblings } = obj;
      return { ...(componentResolved as Record<string, unknown>), ...siblings };
    }

    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      result[key] = await dereference(family, val, stack);
    }
    return result;
  }

  return value;
}

// --- Reverse-dependency (impact) trace -------------------------------------

// Scans every schema and component in the family for $ref usages and returns
// the transitive set of things (components and schemas) that depend on the
// given component, directly or through nested components.
export async function findUsages(
  family: string,
  componentName: string,
  allComponents: { name: string; raw: unknown }[],
  allSchemas: { name: string; raw: unknown }[],
): Promise<string[]> {
  const directRefsOf = (raw: unknown): Set<string> => {
    const refs = new Set<string>();
    collectRefs(raw, refs);
    return refs;
  };

  const componentRefs = new Map(allComponents.map((c) => [c.name, directRefsOf(c.raw)]));
  const schemaRefs = new Map(allSchemas.map((s) => [s.name, directRefsOf(s.raw)]));

  // A component/schema "uses" target if target is reachable via refs.
  const dependsOn = (startRefs: Set<string>, target: string, seen = new Set<string>()): boolean => {
    for (const ref of startRefs) {
      if (ref === target) return true;
      if (seen.has(ref)) continue;
      seen.add(ref);
      const nested = componentRefs.get(ref);
      if (nested && dependsOn(nested, target, seen)) return true;
    }
    return false;
  };

  const usedBy: string[] = [];
  for (const [name, refs] of componentRefs) {
    if (name !== componentName && dependsOn(refs, componentName)) usedBy.push(`component:${name}`);
  }
  for (const [name, refs] of schemaRefs) {
    if (dependsOn(refs, componentName)) usedBy.push(`schema:${name}`);
  }
  return usedBy;
}

function collectRefs(value: JsonValue, into: Set<string>): void {
  if (Array.isArray(value)) {
    value.forEach((v) => collectRefs(v, into));
    return;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.$ref === "string") {
      const match = COMPONENT_REF_PATTERN.exec(obj.$ref);
      if (match) into.add(match[1]);
    }
    for (const val of Object.values(obj)) collectRefs(val, into);
  }
}
