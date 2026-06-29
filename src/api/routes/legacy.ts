import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

const DEPRECATION_DATE = "2026-09-27T00:00:00Z";
const DEPRECATION_SUNSET_MS = Date.parse(DEPRECATION_DATE);
const DEPRECATION_HEADERS = {
  Deprecation: "true",
  Sunset: DEPRECATION_DATE,
};

interface LegacyRoute {
  method: "GET" | "POST" | "PATCH";
  url: string;
  canonical: string;
  paramMap?: Record<string, string>;
}

const legacyRoutes: LegacyRoute[] = [
  { method: "GET", url: "/health", canonical: "/v1/health" },
  { method: "GET", url: "/ready", canonical: "/v1/ready" },
  { method: "GET", url: "/readiness", canonical: "/v1/ready" },
  { method: "GET", url: "/markets", canonical: "/v1/markets" },
  { method: "GET", url: "/markets/:id", canonical: "/v1/markets/:id" },
  {
    method: "GET",
    url: "/markets/:id/orderbook",
    canonical: "/v1/markets/:id/orderbook",
  },
  { method: "POST", url: "/orders", canonical: "/v1/orders" },
  {
    method: "GET",
    url: "/orders/user/:address",
    canonical: "/v1/orders/user/:address",
  },
  {
    method: "GET",
    url: "/trades/user/:address",
    canonical: "/v1/trades/user/:address",
  },
  {
    method: "GET",
    url: "/positions/user/:address",
    canonical: "/v1/wallets/:wallet/positions",
    paramMap: { wallet: "address" },
  },
  { method: "GET", url: "/admin/markets", canonical: "/v1/admin/markets" },
  {
    method: "PATCH",
    url: "/admin/markets/:id/status",
    canonical: "/v1/admin/markets/:id/status",
  },
];

function buildCanonicalPath(
  template: string,
  params: Record<string, string | string[] | undefined>,
  query: string,
  paramMap: Record<string, string> = {}
) {
  let path = template;
  for (const key of Object.keys(paramMap)) {
    const value = params[paramMap[key]];
    if (typeof value === "string") {
      path = path.replace(`:${key}`, value);
    }
  }
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") {
      path = path.replace(`:${key}`, value);
    }
  }
  return query ? `${path}${query}` : path;
}

export function registerDeprecatedAliases(fastify: FastifyInstance) {
  for (const route of legacyRoutes) {
    fastify.route({
      method: route.method,
      url: route.url,
      handler: async (request: FastifyRequest, reply: FastifyReply) => {
        if (Date.now() >= DEPRECATION_SUNSET_MS) {
          return reply.status(404).send({
            error: `Route ${request.method} ${request.url} not found`,
            requestId: request.id,
            statusCode: 404,
          });
        }

        const query = request.url.includes("?")
          ? request.url.slice(request.url.indexOf("?"))
          : "";
        const canonical = buildCanonicalPath(
          route.canonical,
          request.params as Record<string, string>,
          query,
          route.paramMap
        );

        request.log.info(
          {
            event: "api.deprecated_path",
            path: request.url,
            clientIp: request.ip,
          },
          "Deprecated API path used"
        );

        const status = route.url === "/readiness" ? 301 : 308;

        reply
          .status(status)
          .header("Location", canonical)
          .header("Link", `<${canonical}>; rel="alternate"`)
          .header("Deprecation", DEPRECATION_HEADERS.Deprecation)
          .header("Sunset", DEPRECATION_HEADERS.Sunset)
          .send();
      },
    });
  }
}
