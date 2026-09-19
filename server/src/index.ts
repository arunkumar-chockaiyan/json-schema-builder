import Fastify from "fastify";
import cors from "@fastify/cors";
import { registryRoutes } from "./routes/registry.js";
import { familyRoutes } from "./routes/families.js";
import { schemaRoutes } from "./routes/schemas.js";
import { componentRoutes } from "./routes/components.js";
import { RegistryError } from "./types.js";

const app = Fastify({ logger: true });

await app.register(cors, { origin: true });

app.setErrorHandler((err, _req, reply) => {
  if (err instanceof RegistryError) {
    reply.code(err.statusCode).send({ error: err.message });
    return;
  }
  app.log.error(err);
  reply.code(500).send({ error: "Internal server error" });
});

await app.register(registryRoutes);
await app.register(familyRoutes);
await app.register(schemaRoutes);
await app.register(componentRoutes);

const PORT = Number(process.env.PORT ?? 3001);

app
  .listen({ port: PORT, host: "0.0.0.0" })
  .then(() => app.log.info(`Registry API listening on :${PORT}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
