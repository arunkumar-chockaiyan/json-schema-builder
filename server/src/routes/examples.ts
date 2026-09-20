import type { FastifyInstance } from "fastify";
import { listTestCases, readSchema, readTestCase, writeTestCase } from "../lib/registryFs.js";
import { resolveSchema } from "../lib/resolver.js";
import { generateFullExample } from "../lib/exampleGenerator.js";
import { applyExampleConventions, stripComments } from "../lib/example.js";
import { repairFixture, validateFixture } from "../lib/fixtureValidation.js";
import { RegistryError } from "../types.js";

export async function exampleRoutes(app: FastifyInstance): Promise<void> {
  // Lists fixtures, and for each one, whether it is still valid against the
  // schema's *current* resolved output. Fixtures are static files. Nothing
  // updates them automatically when the schema, or a component or base it
  // depends on, changes. This check is the only way staleness surfaces.
  app.get<{ Params: { family: string; schema: string } }>(
    "/api/families/:family/schemas/:schema/examples",
    async (req) => {
      const { family, schema } = req.params;
      const names = await listTestCases(family, schema);

      const raw = await readSchema(family, schema);
      const resolved = await resolveSchema(family, schema, raw);

      const examples = await Promise.all(
        names.map(async (name) => {
          const instance = await readTestCase(family, schema, name);
          const result = validateFixture(resolved, instance);
          return { name, ...result };
        }),
      );

      return { examples };
    },
  );

  // A synthesized "full" instance from the resolved schema, with every
  // property populated, required or not. Always available, even for a
  // schema with no hand-authored fixture yet.
  //
  // This route is registered as a static route, before the ":name" param
  // route below. Fastify's router prioritizes static segments over
  // parametric ones regardless of registration order, but "_generated"
  // cannot collide with a real fixture name anyway. Fixture names come
  // from listTestCases, which only lists real files.
  app.get<{ Params: { family: string; schema: string } }>(
    "/api/families/:family/schemas/:schema/examples/_generated",
    async (req) => {
      const { family, schema } = req.params;
      const raw = await readSchema(family, schema);
      const resolved = await resolveSchema(family, schema, raw);
      return generateFullExample(resolved);
    },
  );

  // The "Primary" example: the comment-stripped parse of the schema's own
  // x-example-source, the same text currently on the left-hand Input tab.
  // There is no separate fixture file for this. That is a future "folder
  // per schema" iteration. This route just re-derives the plain JSON view
  // of it on demand. It returns 404 when the schema has no x-example-source
  // yet, so the frontend knows to omit "Primary" from the dropdown.
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
      // Uses the same comma-to-enum convention as derivation: show the
      // representative (first) value for any comma-list field. This keeps
      // the result a genuinely valid instance against the derived schema,
      // instead of showing the raw "card,check" as one literal value.
      return applyExampleConventions(JSON.parse(json));
    },
  );

  // Repairs every stale fixture for this schema in one go. This is the
  // "after all the changes are done" button.
  //
  // Two kinds of drift are fixed automatically: missing-required-property
  // validation errors, and any other schema-declared field (optional, at
  // any depth) that is simply absent from the fixture. This way, a
  // newly-added optional field shows up in examples too, not only fields
  // that broke validity.
  //
  // Anything ajv flags that is NOT a missing property (wrong type, enum,
  // pattern, and so on) is left for a person to fix. Guessing a
  // replacement could destroy a meaningful hand-authored value.
  //
  // Registered before the ":name" route below, for the same
  // static-vs-parametric reason as "_generated" and "_primary".
  app.post<{ Params: { family: string; schema: string } }>(
    "/api/families/:family/schemas/:schema/examples/repair",
    async (req) => {
      const { family, schema } = req.params;
      const names = await listTestCases(family, schema);

      const raw = await readSchema(family, schema);
      const resolved = await resolveSchema(family, schema, raw);

      const repaired = await Promise.all(
        names.map(async (name) => {
          const instance = await readTestCase(family, schema, name);
          const result = repairFixture(resolved, instance);
          if (result.repairedFields.length > 0 || result.addedOptionalFields.length > 0) {
            await writeTestCase(family, schema, name, result.instance);
          }
          return {
            name,
            valid: result.valid,
            repairedFields: result.repairedFields,
            addedOptionalFields: result.addedOptionalFields,
            remainingErrors: result.remainingErrors,
          };
        }),
      );

      return { repaired };
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
