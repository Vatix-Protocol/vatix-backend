import Fastify, { type FastifyInstance } from "fastify";

const server: FastifyInstance = Fastify({
  logger: true,
});

/**
 * All public API routes are registered under the /v1 prefix.
 *
 * Non-versioned paths (e.g. GET /health) are not registered and will
 * receive Fastify's default 404 response.
 *
 * To add new routes, register them inside this plugin so they
 * automatically inherit the /v1 prefix.
 */
server.register(
  async (v1) => {
    v1.get("/health", async () => {
      return { status: "ok", service: "vatix-backend" };
    });
  },
  { prefix: "/v1" }
);

const start = async () => {
  try {
    const port = Number(process.env.PORT) || 3000;
    await server.listen({ port, host: "0.0.0.0" });
    console.log(`Server running at http://localhost:${port}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

start();
