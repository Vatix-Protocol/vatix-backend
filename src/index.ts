import Fastify from "fastify";
import { getConfig } from "./config.js";

const server = Fastify({
  logger: true,
});

server.get("/health", async () => {
  return { status: "ok", service: "vatix-backend" };
});

const start = async () => {
  try {
    const port = getConfig().server.port;
    await server.listen({ port, host: "0.0.0.0" });
    console.log(`Server running at http://localhost:${port}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

start();
