import type { FastifyInstance } from "fastify";
import { extractComponent, type ExtractionSource } from "../lib/extraction.js";
import { RegistryError } from "../types.js";

interface ExtractBody {
  sourceType: "base" | "schema";
  sourceName?: string;
  path: string[];
  componentName: string;
}

export async function extractionRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { family: string }; Body: ExtractBody }>(
    "/api/families/:family/extract-component",
    async (req, reply) => {
      const { family } = req.params;
      const body = req.body ?? ({} as ExtractBody);
      const { sourceType, sourceName, path, componentName } = body;

      if (sourceType !== "base" && sourceType !== "schema") {
        throw new RegistryError('sourceType must be "base" or "schema".', 400);
      }
      if (sourceType === "schema" && !sourceName) {
        throw new RegistryError('sourceName is required when sourceType is "schema".', 400);
      }
      if (!Array.isArray(path) || path.length === 0 || !path.every((p) => typeof p === "string")) {
        throw new RegistryError("path must be a non-empty array of field names.", 400);
      }
      if (!componentName || typeof componentName !== "string") {
        throw new RegistryError("componentName is required.", 400);
      }

      const source: ExtractionSource =
        sourceType === "base" ? { type: "base" } : { type: "schema", name: sourceName as string };

      await extractComponent(family, source, path, componentName);

      reply.code(204);
    },
  );
}
