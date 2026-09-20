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

  // Base has no parent to merge into. Base IS the thing schemas merge
  // with. So "resolved" here just means: any $refs to components are
  // dereferenced. This reuses the same dereference logic resolveComponent
  // already does.
  app.get<{ Params: { family: string } }>("/api/families/:family/base", async (req) => {
    const { family } = req.params;
    const raw = await readBase(family);
    const resolved = await resolveComponent(family, raw);
    return { raw, resolved };
  });

  // A single synthesized example for base. Uses the same generator as a
  // schema's "Full (generated)" example, computed on demand, not persisted.
  // Base has no example-authoring concept of its own.
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

    // Validate that it resolves cleanly before persisting: refs must
    // exist, and there must be no cycles. Changing base affects every
    // schema in the family at once. There is no guard here against a name
    // collision with an existing schema's own field. That surfaces the
    // next time the affected schema is resolved.
    await resolveComponent(family, content);
    await writeBase(family, content);

    reply.code(204);
  });
}
