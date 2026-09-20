// Fixtures (registry/<family>/tests/<schema>/*.json) are static, hand-
// authored instance files — nothing re-derives or updates them when the
// schema they belong to changes (directly, or transitively via a component
// or base edit). This module answers "is this fixture still valid against
// the schema's *current* resolved output," so staleness is surfaced instead
// of silently ignored.

// ajv's CJS type declarations don't interop cleanly with NodeNext ESM here
// (TypeScript sees the namespace object, not the default export, even
// though the runtime value is correct) — same packages, same import shape
// already proven to work at runtime in this codebase's own verification
// scripts; the `as unknown as` casts just satisfy the type checker.
import Ajv2020Module from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { generateValue } from "./exampleGenerator.js";

const Ajv2020 = Ajv2020Module as unknown as new (opts?: Record<string, unknown>) => import("ajv").default;
const addFormats = addFormatsModule as unknown as (ajv: import("ajv").default) => void;

export interface FixtureValidationResult {
  valid: boolean;
  // A short, human-readable summary of the first failure — full ajv error
  // detail isn't useful in a list view, just enough to know what's wrong.
  errorSummary?: string;
}

export function validateFixture(resolvedSchema: unknown, instance: unknown): FixtureValidationResult {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);

  let validate;
  try {
    validate = ajv.compile(resolvedSchema as Record<string, unknown>);
  } catch (err) {
    // A schema that doesn't compile isn't the fixture's fault — surface it
    // as a validation failure so it's visible rather than crashing the route.
    return { valid: false, errorSummary: `Schema does not compile: ${err instanceof Error ? err.message : String(err)}` };
  }

  const valid = validate(instance);
  if (valid) return { valid: true };

  const firstError = validate.errors?.[0];
  const errorSummary = firstError
    ? `${firstError.instancePath || "(root)"} ${firstError.message ?? "is invalid"}`
    : "is invalid";
  return { valid: false, errorSummary };
}

export interface RepairResult {
  instance: unknown;
  valid: boolean;
  // Fields that were added/filled in to fix a "missing required property"
  // error — dot-paths, for a clear summary of what changed.
  repairedFields: string[];
  // Fields that exist in the schema (at any depth, required or not) but
  // were simply absent from the fixture — added for completeness, not
  // because anything was invalid. This is how a newly-added *optional*
  // field on a schema or component shows up in examples: adding a field
  // never produces a validation error, so the required-only repair pass
  // above would never touch it otherwise.
  addedOptionalFields: string[];
  // Set when the fixture is still invalid after repair — errors ajv reports
  // that AREN'T "missing required property" (wrong type, enum, pattern,
  // ...) aren't auto-fixed, since guessing a replacement risks destroying a
  // meaningful hand-authored value. Those are left for a human to fix.
  remainingErrors?: string[];
}

// Repairs a stale fixture in two passes:
//  1. Fixes "missing required property" validation errors — existing
//     values are never touched, only genuinely missing ones are added.
//     Iterates (bounded) since adding one missing object can itself need
//     its own required sub-fields filled in.
//  2. Fills in any other schema-declared field (optional, at any depth)
//     that's simply absent from the fixture — keeps the example
//     comprehensive, not just valid. Also never touches an existing value;
//     only adds what's missing, and only descends into nested objects that
//     already exist in the fixture (it won't invent a whole optional
//     sub-object the fixture never had, just fill gaps within ones it does).
export function repairFixture(resolvedSchema: unknown, instance: unknown): RepairResult {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(resolvedSchema as Record<string, unknown>);

  let current = deepClone(instance);
  const repairedFields: string[] = [];
  const MAX_PASSES = 10;
  let stillInvalid = false;
  let remainingErrors: string[] | undefined;

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const valid = validate(current);
    if (valid) break;

    const errors = validate.errors ?? [];
    const requiredErrors = errors.filter((e) => e.keyword === "required");
    const isLastPass = pass === MAX_PASSES - 1;

    if (requiredErrors.length === 0 || isLastPass) {
      // Either nothing left that auto-repair can fix, or a pathological/
      // cyclic schema exhausted the pass budget — report whatever's left.
      stillInvalid = true;
      remainingErrors = errors.map((e) => `${e.instancePath || "(root)"} ${e.message ?? "is invalid"}`);
      break;
    }

    for (const error of requiredErrors) {
      const missingProperty = (error.params as { missingProperty?: string }).missingProperty;
      if (!missingProperty) continue;
      const parentSegments = pointerToSegments(error.instancePath);
      const fullSegments = [...parentSegments, missingProperty];

      const fieldSchema = resolveSchemaAtPath(resolvedSchema, fullSegments);
      if (!fieldSchema) continue; // shouldn't happen — schema said it's required, so it must be declared

      setAtPath(current, fullSegments, generateValue(fieldSchema));
      repairedFields.push(fullSegments.join("."));
    }
  }

  const resolvedProperties = (resolvedSchema as Record<string, unknown> | undefined)?.properties as
    | Record<string, unknown>
    | undefined;
  const addedOptionalFields =
    resolvedProperties && current && typeof current === "object" && !Array.isArray(current)
      ? fillMissingFields(resolvedProperties, current as Record<string, unknown>)
      : [];

  return {
    instance: current,
    valid: !stillInvalid,
    repairedFields,
    addedOptionalFields,
    remainingErrors,
  };
}

// Walks `properties` alongside `instance`, adding any declared field that's
// simply missing (regardless of required-ness) with a generated value.
// Recurses into nested objects only when the fixture already has a value
// there to fill gaps within — it doesn't fabricate an entirely-missing
// optional sub-object's contents beyond the object itself.
function fillMissingFields(properties: Record<string, unknown>, instance: Record<string, unknown>, pathPrefix = ""): string[] {
  const added: string[] = [];
  for (const [key, rawSchema] of Object.entries(properties)) {
    const path = pathPrefix ? `${pathPrefix}.${key}` : key;
    const fieldSchema = rawSchema as Record<string, unknown>;

    if (!(key in instance)) {
      instance[key] = generateValue(fieldSchema);
      added.push(path);
      continue;
    }

    const nestedProperties = fieldSchema.type === "object" ? (fieldSchema.properties as Record<string, unknown> | undefined) : undefined;
    const nestedInstance = instance[key];
    if (nestedProperties && nestedInstance && typeof nestedInstance === "object" && !Array.isArray(nestedInstance)) {
      added.push(...fillMissingFields(nestedProperties, nestedInstance as Record<string, unknown>, path));
    }
  }
  return added;
}

function pointerToSegments(pointer: string): string[] {
  if (!pointer) return [];
  return pointer
    .split("/")
    .filter((s) => s.length > 0)
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
}

// Walks a resolved schema's `properties` tree following `segments`, e.g.
// ["contact", "address", "country"] -> the schema node for that leaf.
function resolveSchemaAtPath(resolvedSchema: unknown, segments: string[]): Record<string, unknown> | undefined {
  let cursor = resolvedSchema as Record<string, unknown> | undefined;
  for (const segment of segments) {
    const properties = cursor?.properties as Record<string, unknown> | undefined;
    cursor = properties?.[segment] as Record<string, unknown> | undefined;
    if (!cursor) return undefined;
  }
  return cursor;
}

// Sets `value` at `segments` within `obj`, creating intermediate objects as
// needed (shouldn't normally be necessary — a "required" error implies the
// parent already exists — but defensive in case of deeper staleness).
function setAtPath(obj: Record<string, unknown>, segments: string[], value: unknown): void {
  let cursor = obj;
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i];
    if (typeof cursor[segment] !== "object" || cursor[segment] === null) {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as Record<string, unknown>;
  }
  cursor[segments[segments.length - 1]] = value;
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}
