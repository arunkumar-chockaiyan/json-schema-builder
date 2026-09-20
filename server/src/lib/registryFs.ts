// File-system helpers scoped to the /registry directory.
// All reads/writes to registry data go through this module so path handling
// (and eventually locking/atomic writes) stays in one place.

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RegistryError } from "../types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// server/src/lib -> repo root is three levels up (lib -> src -> server -> root)
export const REGISTRY_ROOT = path.resolve(__dirname, "../../../registry");

function familyDir(family: string): string {
  assertSafeSegment(family);
  return path.join(REGISTRY_ROOT, family);
}

function schemaPath(family: string, schema: string): string {
  assertSafeSegment(schema);
  return path.join(familyDir(family), "schemas", `${schema}.schema.json`);
}

function componentPath(family: string, component: string): string {
  assertSafeSegment(component);
  return path.join(familyDir(family), "components", `${component}.schema.json`);
}

function basePath(family: string): string {
  return path.join(familyDir(family), "base.schema.json");
}

function testCasesDir(family: string, schema: string): string {
  assertSafeSegment(schema);
  return path.join(familyDir(family), "tests", schema);
}

function testCasePath(family: string, schema: string, name: string): string {
  assertSafeSegment(name);
  return path.join(testCasesDir(family, schema), `${name}.json`);
}

// Guard against path traversal via family/schema/component names coming from
// route params. Exported so callers constructing a *new* name (e.g. schema
// creation, component extraction) can validate before ever touching the fs.
export function assertSafeSegment(segment: string): void {
  if (!segment || segment.includes("/") || segment.includes("\\") || segment.includes("..")) {
    throw new RegistryError(`Invalid path segment: "${segment}"`, 400);
  }
}

async function readJson<T>(filePath: string): Promise<T> {
  try {
    const contents = await fs.readFile(filePath, "utf-8");
    return JSON.parse(contents) as T;
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === "ENOENT") {
      throw new RegistryError(`Not found: ${path.relative(REGISTRY_ROOT, filePath)}`, 404);
    }
    throw err;
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  const serialized = JSON.stringify(value, null, 2) + "\n";
  await fs.writeFile(filePath, serialized, "utf-8");
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return typeof err === "object" && err !== null && "code" in err;
}

export async function listFamilies(): Promise<{ name: string; description: string }[]> {
  const indexPath = path.join(REGISTRY_ROOT, "registry.json");
  const index = await readJson<{ families: { name: string; description: string }[] }>(indexPath);
  return index.families;
}

export async function readFamilyMeta(family: string): Promise<{ name: string; description: string }> {
  return readJson(path.join(familyDir(family), "family.json"));
}

export async function listComponents(family: string): Promise<string[]> {
  return listSchemaFiles(path.join(familyDir(family), "components"));
}

export async function listSchemas(family: string): Promise<string[]> {
  return listSchemaFiles(path.join(familyDir(family), "schemas"));
}

async function listSchemaFiles(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir);
    return entries
      .filter((f) => f.endsWith(".schema.json"))
      .map((f) => f.replace(/\.schema\.json$/, ""))
      .sort();
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === "ENOENT") return [];
    throw err;
  }
}

export async function readBase(family: string): Promise<unknown> {
  return readJson(basePath(family));
}

export async function writeBase(family: string, content: unknown): Promise<void> {
  await writeJson(basePath(family), content);
}

export async function readSchema(family: string, schema: string): Promise<unknown> {
  return readJson(schemaPath(family, schema));
}

export async function writeSchema(family: string, schema: string, content: unknown): Promise<void> {
  await writeJson(schemaPath(family, schema), content);
}

export async function readComponent(family: string, component: string): Promise<unknown> {
  return readJson(componentPath(family, component));
}

export async function writeComponent(family: string, component: string, content: unknown): Promise<void> {
  await writeJson(componentPath(family, component), content);
}

// Absolute path helpers, used by the resolver ($ref resolution) and the git
// log/diff wrapper (which needs a path relative to the repo root).
export function absoluteSchemaPath(family: string, schema: string): string {
  return schemaPath(family, schema);
}

export function absoluteComponentPath(family: string, component: string): string {
  return componentPath(family, component);
}

export function familyComponentsDir(family: string): string {
  return path.join(familyDir(family), "components");
}

export async function listTestCases(family: string, schema: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(testCasesDir(family, schema));
    return entries
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""))
      .sort();
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === "ENOENT") return [];
    throw err;
  }
}

export async function readTestCase(family: string, schema: string, name: string): Promise<unknown> {
  return readJson(testCasePath(family, schema, name));
}
