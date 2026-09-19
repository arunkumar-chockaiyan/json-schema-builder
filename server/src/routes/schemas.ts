import type { FastifyInstance } from "fastify";
import { absoluteSchemaPath, readSchema, writeSchema } from "../lib/registryFs.js";
import { resolveSchema } from "../lib/resolver.js";
import { logForPath } from "../lib/git.js";
import { RegistryError } from "../types.js";

export async function schemaRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { family: string; schema: string } }>(
    "/api/families/:family/schemas/:schema",
    async (req) => {
      const { family, schema } = req.params;
      const raw = await readSchema(family, schema);
      const resolved = await resolveSchema(family, schema, raw);
      return { raw, resolved };
    },
  );

  app.get<{ Params: { family: string; schema: string } }>(
    "/api/families/:family/schemas/:schema/history",
    async (req) => {
      const { family, schema } = req.params;
      const commits = await logForPath(absoluteSchemaPath(family, schema));
      return { commits };
    },
  );

  app.put<{ Params: { family: string; schema: string }; Body: unknown }>(
    "/api/families/:family/schemas/:schema",
    async (req, reply) => {
      const { family, schema } = req.params;
      const content = req.body;

      if (!content || typeof content !== "object") {
        throw new RegistryError("Request body must be a JSON object (a JSON Schema document).", 400);
      }

      // Validate it resolves cleanly (refs exist, no base-field collisions)
      // before persisting.
      await resolveSchema(family, schema, content);
      await writeSchema(family, schema, content);

      reply.code(204);
    },
  );
}
