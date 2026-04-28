import Fastify from "fastify";

const server = Fastify({
  logger: true,
});

server.get("/health", async () => {
  return { status: "ok", service: "vatix-backend" };
});

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
