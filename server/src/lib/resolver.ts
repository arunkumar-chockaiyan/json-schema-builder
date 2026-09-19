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

const COMPONENT_REF_PATTERN = /^components\/([^/]+)\.schema\.json$/;

type JsonValue = unknown;

export async function resolveSchema(family: string, schemaTitle: string, raw: unknown): Promise<unknown> {
  const base = await readBase(family);
  const resolvedRaw = await dereference(family, raw, []);

  const baseProps = getProperties(base);
  const schemaProps = getProperties(resolvedRaw);

  for (const key of Object.keys(schemaProps)) {
    if (key in baseProps) {
      throw new RegistryError(
        `Schema "${schemaTitle}" redeclares locked base field "${key}". Base fields cannot be overridden.`,
        409,
      );
    }
  }

  const merged = { ...(resolvedRaw as Record<string, unknown>) };
  merged.properties = { ...baseProps, ...schemaProps };
  const baseRequired = Array.isArray((base as Record<string, unknown>)?.required)
    ? ((base as Record<string, unknown>).required as string[])
    : [];
  const schemaRequired = Array.isArray((resolvedRaw as Record<string, unknown>)?.required)
    ? ((resolvedRaw as Record<string, unknown>).required as string[])
    : [];
  merged.required = [...new Set([...baseRequired, ...schemaRequired])];

  return merged;
}

export async function resolveComponent(family: string, raw: unknown): Promise<unknown> {
  return dereference(family, raw, []);
}

function getProperties(schema: unknown): Record<string, unknown> {
  const props = (schema as Record<string, unknown> | undefined)?.properties;
  return props && typeof props === "object" ? (props as Record<string, unknown>) : {};
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
