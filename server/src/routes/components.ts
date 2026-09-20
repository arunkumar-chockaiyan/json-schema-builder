import type { FastifyInstance } from "fastify";
import {
  absoluteComponentPath,
  listComponents,
  listSchemas,
  readComponent,
  readSchema,
  writeComponent,
} from "../lib/registryFs.js";
import { findUsages, resolveComponent } from "../lib/resolver.js";
import { generateFullExample } from "../lib/exampleGenerator.js";
import { logForPath } from "../lib/git.js";
import { RegistryError } from "../types.js";

export async function componentRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { family: string; component: string } }>(
    "/api/families/:family/components/:component",
    async (req) => {
      const { family, component } = req.params;
      const raw = await readComponent(family, component);
      const resolved = await resolveComponent(family, raw);

      const [componentNames, schemaNames] = await Promise.all([listComponents(family), listSchemas(family)]);
      const allComponents = await Promise.all(
        componentNames.map(async (name) => ({ name, raw: await readComponent(family, name) })),
      );
      const allSchemas = await Promise.all(
        schemaNames.map(async (name) => ({ name, raw: await readSchema(family, name) })),
      );
      const usedBy = await findUsages(family, component, allComponents, allSchemas);

      return { raw, resolved, usedBy };
    },
  );

  app.get<{ Params: { family: string; component: string } }>(
    "/api/families/:family/components/:component/history",
    async (req) => {
      const { family, component } = req.params;
      const commits = await logForPath(absoluteComponentPath(family, component));
      return { commits };
    },
  );

  // A single synthesized example. Uses the same generator as a schema's
  // "Full (generated)" example. Computed on demand, not persisted.
  app.get<{ Params: { family: string; component: string } }>(
    "/api/families/:family/components/:component/example",
    async (req) => {
      const { family, component } = req.params;
      const raw = await readComponent(family, component);
      const resolved = await resolveComponent(family, raw);
      return generateFullExample(resolved);
    },
  );

  app.put<{ Params: { family: string; component: string }; Body: unknown }>(
    "/api/families/:family/components/:component",
    async (req, reply) => {
      const { family, component } = req.params;
      const content = req.body;

      if (!content || typeof content !== "object") {
        throw new RegistryError("Request body must be a JSON object (a JSON Schema document).", 400);
      }

      // Validate that all refs resolve before persisting. This also
      // detects cycles.
      await resolveComponent(family, content);
      await writeComponent(family, component, content);

      reply.code(204);
    },
  );
}
