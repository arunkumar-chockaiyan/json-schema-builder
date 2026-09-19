import type { FastifyInstance } from "fastify";
import { listFamilies } from "../lib/registryFs.js";

export async function registryRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/registry", async () => {
    const families = await listFamilies();
    return { families };
  });
}
