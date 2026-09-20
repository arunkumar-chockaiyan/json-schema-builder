// Resolves a schema into two forms:
//   - raw: the file as authored, with $refs intact (the default editor view)
//   - resolved: base fields merged in (locked, must not collide), and every
//     components/*.schema.json $ref recursively dereferenced and inlined
//
// $ref convention: within a family, a ref always looks like
// "components/<name>.schema.json". This is true whether the ref appears in
// a schema or inside another component (component nesting). Refs across
// families and external URLs are not allowed. Anything else is a hard
// error.

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

  // Base fields are locked. A schema cannot redeclare one, with one
  // exception: an "open extension point" (for example "details," a
  // generic, schema-varying object with no declared shape of its own). For
  // an open extension point, the schema's derived sub-shape merges into
  // base's generic definition. This merge only affects THIS schema's
  // resolved output. Base itself, and every other schema, stay unchanged.
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

  // x-required-fields is a list of dot-paths: a second, independent way to
  // mark a field required. You edit this list with the Constraints tab's
  // picker, not with the example's `required` comment directive.
  //
  // This list is applied here, at resolve time, not baked into properties
  // at write time. Toggling a field on or off this way never needs a
  // re-derivation of the example. x-rules works the same way: it is
  // compiled fresh on every resolve, not stored pre-compiled.
  //
  // x-required-fields is authoring-only. It is stripped from what
  // validators and consumers see, the same as x-rules and x-example-source
  // below.
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

  // Conditional rules (x-rules): validate each rule against the fully
  // merged field set, then compile the rules to standard allOf/if/then for
  // the resolved output. x-rules itself is an authoring-only,
  // round-trippable representation. Strip it from what validators and
  // consumers see.
  const rules = Array.isArray((merged as Record<string, unknown>)["x-rules"])
    ? ((merged as Record<string, unknown>)["x-rules"] as Rule[])
    : [];
  delete merged["x-rules"];
  // x-example-source (the annotated example text) is authoring-only too.
  // Strip it from what validators and consumers see, the same as x-rules
  // above.
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
// dot-path. This includes both leaves and intermediate objects, and is used
// for rule-field validation. It only descends into the declared
// `properties` of `type: "object"` nodes. Array items are out of scope for
// nested rule targeting today. This naturally excludes a bogus path like
// "amount.sub": amount is not an object, so nothing under it is ever added.
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

// For each dot-path in `paths`, walks the already-merged, resolved tree.
// (By the time this runs, the base merge, $ref dereference, and
// open-extension-point merge are already applied.) Pushes the path's final
// segment into its *containing* level's `required` array. Creates that
// array if it is missing, and removes duplicates. Mutates `merged` and its
// nested property nodes in place.
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

// Recursively walks a JSON value. Replaces any
// { "$ref": "components/x.schema.json" } node with the fully dereferenced
// content of that component. `stack` tracks the component names currently
// being resolved, to detect reference cycles.
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

      // Some JSON Schema drafts allow sibling keys alongside $ref, though
      // this is unusual. Merge any sibling keys on top of the dereferenced
      // component.
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

// Scans every schema and component in the family for $ref usages. Returns
// the transitive set of components and schemas that depend on the given
// component, either directly or through nested components.
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

  // A component or schema "uses" the target when the target is reachable
  // through its refs, directly or via nested components.
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
