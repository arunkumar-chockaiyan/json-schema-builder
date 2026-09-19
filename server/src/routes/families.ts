import type { FastifyInstance } from "fastify";
import { listComponents, listSchemas, readFamilyMeta } from "../lib/registryFs.js";
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
}
