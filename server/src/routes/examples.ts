import type { FastifyInstance } from "fastify";
import { listTestCases, readSchema, readTestCase } from "../lib/registryFs.js";
import { resolveSchema } from "../lib/resolver.js";
import { generateFullExample } from "../lib/exampleGenerator.js";
import { applyExampleConventions, stripComments } from "../lib/example.js";
import { RegistryError } from "../types.js";

export async function exampleRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { family: string; schema: string } }>(
    "/api/families/:family/schemas/:schema/examples",
    async (req) => {
      const { family, schema } = req.params;
      const names = await listTestCases(family, schema);
      return { names };
    },
  );

  // A synthesized "full" instance (every property populated, required or
  // not) from the resolved schema — always available, even for a schema
  // with no hand-authored fixture yet. Registered as a static route before
  // the ":name" param route below; Fastify's router prioritizes static
  // segments over parametric ones regardless of registration order, but
  // "_generated" can't collide with a real fixture name anyway (fixture
  // names come from listTestCases, which only lists real files).
  app.get<{ Params: { family: string; schema: string } }>(
    "/api/families/:family/schemas/:schema/examples/_generated",
    async (req) => {
      const { family, schema } = req.params;
      const raw = await readSchema(family, schema);
      const resolved = await resolveSchema(family, schema, raw);
      return generateFullExample(resolved);
    },
  );

  // The "Primary" example — the comment-stripped parse of the schema's own
  // x-example-source, i.e. whatever's currently on the left-hand Input tab.
  // No separate fixture file (that's a future "folder per schema"
  // iteration) — this just re-derives the plain JSON view of it on demand.
  // 404s if the schema has no x-example-source yet, so the frontend knows to
  // omit "Primary" from the dropdown.
  app.get<{ Params: { family: string; schema: string } }>(
    "/api/families/:family/schemas/:schema/examples/_primary",
    async (req) => {
      const { family, schema } = req.params;
      const raw = (await readSchema(family, schema)) as Record<string, unknown>;
      const source = raw["x-example-source"];
      if (typeof source !== "string") {
        throw new RegistryError(`Schema "${schema}" has no primary example yet.`, 404);
      }
      const { json } = stripComments(source);
      // Same comma -> enum convention as derivation: show the representative
      // (first) value for any comma-list field, so this stays a genuinely
      // valid instance against the derived schema rather than showing the
      // raw "card,check" as if it were one literal value.
      return applyExampleConventions(JSON.parse(json));
    },
  );

  app.get<{ Params: { family: string; schema: string; name: string } }>(
    "/api/families/:family/schemas/:schema/examples/:name",
    async (req) => {
      const { family, schema, name } = req.params;
      return readTestCase(family, schema, name);
    },
  );
}
