import type { FastifyInstance } from "fastify";
import { absoluteSchemaPath, readBase, readSchema, writeSchema } from "../lib/registryFs.js";
import { resolveSchema } from "../lib/resolver.js";
import { logForPath } from "../lib/git.js";
import { MissingBaseFieldsError, parseAndDerive } from "../lib/example.js";
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

      const body = content as Record<string, unknown>;

      // If an annotated example was submitted, derive properties/required
      // from it — this is the primary authoring path for the left-hand
      // Input tab. Existing on-disk properties are consulted so a top-level
      // $ref (component wiring) is preserved rather than overwritten with
      // an inferred inline shape.
      if (typeof body["x-example-source"] === "string") {
        let existingProperties: Record<string, unknown> = {};
        try {
          const onDisk = (await readSchema(family, schema)) as Record<string, unknown>;
          existingProperties = (onDisk.properties as Record<string, unknown>) ?? {};
        } catch {
          // New schema with no file yet — nothing to preserve.
        }

        const baseRaw = (await readBase(family)) as Record<string, unknown>;
        const base = {
          properties: (baseRaw.properties as Record<string, unknown>) ?? {},
          required: Array.isArray(baseRaw.required) ? (baseRaw.required as string[]) : [],
        };

        let derived;
        try {
          derived = parseAndDerive(body["x-example-source"] as string, existingProperties, base);
        } catch (err) {
          if (err instanceof MissingBaseFieldsError) {
            throw new RegistryError(
              `${err.message}. The base schema's fields are the minimum every example must include — add them and try again.`,
              400,
            );
          }
          throw new RegistryError(
            `Could not parse the annotated example: ${err instanceof Error ? err.message : String(err)}`,
            400,
          );
        }
        body.properties = derived.properties;
        body.required = derived.required;
      }

      // Validate it resolves cleanly (refs exist, no base-field collisions,
      // rules reference real fields) before persisting.
      await resolveSchema(family, schema, body);
      await writeSchema(family, schema, body);

      reply.code(204);
    },
  );
}
