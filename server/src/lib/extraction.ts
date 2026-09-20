// Component extraction: pull an inline object field (from a schema or from
// base, at any depth) out into its own reusable components/<name>.schema.json
// file, replacing the field's inline definition with a $ref.
//
// This deliberately does NOT go through the schema PUT/derivation pipeline
// (server/src/routes/schemas.ts) — that pipeline fully replaces `properties`
// from x-example-source on every save, so a $ref written that way would be
// silently reverted the next time someone applies the (unchanged) example.
// Extraction instead reads/patches raw files directly.

import {
  assertSafeSegment,
  readBase,
  readComponent,
  readSchema,
  writeBase,
  writeComponent,
  writeSchema,
} from "./registryFs.js";
import { resolveComponent, resolveSchema } from "./resolver.js";
import { RegistryError } from "../types.js";

const COMPONENT_REF_PATTERN = /^components\/([^/]+)\.schema\.json$/;

export type ExtractionSource =
  | { type: "base" }
  | { type: "schema"; name: string }
  | { type: "component"; name: string };

interface OwnerLocation {
  owner: ExtractionSource;
  raw: Record<string, unknown>;
  // Path to the target field *within* `raw`'s properties tree (may cross
  // several nested inline objects, but never crosses a $ref — that's a new
  // owner). Always ends with the field's own key.
  localPath: string[];
}

async function readSource(family: string, source: ExtractionSource): Promise<Record<string, unknown>> {
  if (source.type === "base") return (await readBase(family)) as Record<string, unknown>;
  if (source.type === "schema") return (await readSchema(family, source.name)) as Record<string, unknown>;
  return (await readComponent(family, source.name)) as Record<string, unknown>;
}

async function writeSource(family: string, source: ExtractionSource, content: unknown): Promise<void> {
  if (source.type === "base") return writeBase(family, content);
  if (source.type === "schema") return writeSchema(family, source.name, content);
  return writeComponent(family, source.name, content);
}

// Walks `path` through `source`'s raw properties, transparently crossing
// $ref boundaries into whichever component actually owns the deeper field.
// The frontend never needs to know this happens — it just picks a path off
// the already-resolved (fully dereferenced) tree, same as the rule builder's
// field picker.
export async function locateFieldOwner(
  family: string,
  source: ExtractionSource,
  path: string[],
): Promise<OwnerLocation> {
  if (path.length === 0) {
    throw new RegistryError("Field path must not be empty.", 400);
  }

  let raw = await readSource(family, source);
  let owner = source;
  let cursor = ((raw.properties as Record<string, unknown>) ?? {}) as Record<string, unknown>;
  let localPath: string[] = [];

  for (let i = 0; i < path.length - 1; i++) {
    const segment = path[i];
    const node = cursor[segment] as Record<string, unknown> | undefined;
    if (!node) {
      throw new RegistryError(`Field "${path.slice(0, i + 1).join(".")}" not found.`, 404);
    }

    if (typeof node.$ref === "string") {
      const match = COMPONENT_REF_PATTERN.exec(node.$ref);
      if (!match) {
        throw new RegistryError(
          `Unsupported $ref "${node.$ref}" encountered while locating "${path.join(".")}".`,
          400,
        );
      }
      owner = { type: "component", name: match[1] };
      raw = await readSource(family, owner);
      cursor = ((raw.properties as Record<string, unknown>) ?? {}) as Record<string, unknown>;
      localPath = [];
    } else if (node.type === "object" && node.properties) {
      cursor = node.properties as Record<string, unknown>;
      localPath = [...localPath, segment];
    } else {
      throw new RegistryError(
        `"${segment}" is not an object; cannot descend further into "${path.join(".")}".`,
        400,
      );
    }
  }

  const lastSegment = path[path.length - 1];
  if (!(lastSegment in cursor)) {
    throw new RegistryError(`Field "${path.join(".")}" not found.`, 404);
  }

  return { owner, raw, localPath: [...localPath, lastSegment] };
}

// Immutable replace at localPath within raw.properties (nested via
// properties.<seg>.properties.<seg>...), leaving every other key (including
// sibling properties, required[], x-example-source, x-rules) untouched.
function replaceAtPath(raw: Record<string, unknown>, localPath: string[], replacement: unknown): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
  let cursor = clone;
  for (let i = 0; i < localPath.length - 1; i++) {
    cursor = (cursor.properties as Record<string, unknown>)[localPath[i]] as Record<string, unknown>;
  }
  const props = cursor.properties as Record<string, unknown>;
  props[localPath[localPath.length - 1]] = replacement;
  return clone;
}

export async function extractComponent(
  family: string,
  source: ExtractionSource,
  path: string[],
  componentName: string,
): Promise<void> {
  assertSafeSegment(componentName);

  try {
    await readComponent(family, componentName);
    throw new RegistryError(`A component named "${componentName}" already exists.`, 409);
  } catch (err) {
    if (err instanceof RegistryError && err.statusCode === 409) throw err;
    // 404 ("not found") is the expected/desired outcome — no collision, fall through.
  }

  const { owner, raw: ownerRaw, localPath } = await locateFieldOwner(family, source, path);

  let parentProps = ((ownerRaw.properties as Record<string, unknown>) ?? {}) as Record<string, unknown>;
  for (let i = 0; i < localPath.length - 1; i++) {
    const node = parentProps[localPath[i]] as Record<string, unknown> | undefined;
    parentProps = (node?.properties as Record<string, unknown>) ?? {};
  }
  const fieldKey = localPath[localPath.length - 1];
  const fieldNode = parentProps[fieldKey] as Record<string, unknown> | undefined;

  if (!fieldNode) {
    throw new RegistryError(`Field "${path.join(".")}" not found.`, 404);
  }
  if (typeof fieldNode.$ref === "string") {
    throw new RegistryError(`"${path.join(".")}" is already a component reference; nothing to extract.`, 400);
  }
  if (fieldNode.type !== "object") {
    throw new RegistryError(
      `"${path.join(".")}" is not an object field; only object fields can be extracted into a component.`,
      400,
    );
  }

  // Build the new component, matching the shape of hand-authored components
  // (registry/<family>/components/*.schema.json): $schema/title wrapping
  // around the extracted node's own properties/required/description.
  const componentContent: Record<string, unknown> = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: `${family}.${componentName}`,
    type: "object",
    properties: fieldNode.properties ?? {},
  };
  if (Array.isArray(fieldNode.required)) componentContent.required = fieldNode.required;
  if (typeof fieldNode.description === "string") componentContent.description = fieldNode.description;

  // Validate before writing anything.
  await resolveComponent(family, componentContent);
  await writeComponent(family, componentName, componentContent);

  // Patch the owner: swap the field's inline schema for a $ref. required[]
  // (wherever it lives) still lists the same key name, so required-ness is
  // preserved automatically — nothing to do there.
  const patchedOwnerRaw = replaceAtPath(ownerRaw, localPath, {
    $ref: `components/${componentName}.schema.json`,
  });

  if (owner.type === "schema") {
    await resolveSchema(family, owner.name, patchedOwnerRaw);
  } else {
    await resolveComponent(family, patchedOwnerRaw);
  }

  await writeSource(family, owner, patchedOwnerRaw);
}
