import type { FastifyInstance } from "fastify";
import { listComponents, listSchemas, readBase, readFamilyMeta, writeBase } from "../lib/registryFs.js";
import { resolveComponent } from "../lib/resolver.js";
import { generateFullExample } from "../lib/exampleGenerator.js";
import { RegistryError } from "../types.js";
import type { FamilyDetail } from "../types.js";

export async function familyRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { family: string } }>("/api/families/:family", async (req) => {
    const { family } = req.params;
    const [meta, components, schemas] = await Promise.all([
      readFamilyMeta(family),
      listComponents(family),
      listSchemas(family),
    ]);
    const detail: FamilyDetail = { ...meta, components, schemas };
    return detail;
  });

  // Base has no parent to merge into (it IS the thing schemas merge with),
  // so "resolved" here just means any $refs to components dereferenced —
  // reusing the same dereference resolveComponent already does.
  app.get<{ Params: { family: string } }>("/api/families/:family/base", async (req) => {
    const { family } = req.params;
    const raw = await readBase(family);
    const resolved = await resolveComponent(family, raw);
    return { raw, resolved };
  });

  // Single synthesized example for base — same generator used for a
  // schema's "Full (generated)" example, computed on demand rather than
  // persisted (base has no example-authoring concept of its own).
  app.get<{ Params: { family: string } }>("/api/families/:family/base/example", async (req) => {
    const { family } = req.params;
    const raw = await readBase(family);
    const resolved = await resolveComponent(family, raw);
    return generateFullExample(resolved);
  });

  app.put<{ Params: { family: string }; Body: unknown }>("/api/families/:family/base", async (req, reply) => {
    const { family } = req.params;
    const content = req.body;

    if (!content || typeof content !== "object") {
      throw new RegistryError("Request body must be a JSON object (a JSON Schema document).", 400);
    }

    // Validate it resolves cleanly (refs exist, no cycles) before persisting.
    // Changing base affects every schema in the family at once — there's no
    // guard here against name collisions with existing schemas' own fields;
    // those surface the next time an affected schema is resolved.
    await resolveComponent(family, content);
    await writeBase(family, content);

    reply.code(204);
  });
}
