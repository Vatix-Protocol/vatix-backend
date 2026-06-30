/**
 * Canonical /v1 route mounts for the public API.
 * Keep in sync with src/index.ts registrations and docs/api-versioning.md.
 */
export interface CanonicalRoute {
  method: "GET" | "POST" | "PATCH";
  path: string;
  legacyAlias?: string;
  notes?: string;
}

export const CANONICAL_V1_ROUTES: CanonicalRoute[] = [
  { method: "GET", path: "/v1/health", legacyAlias: "/health" },
  {
    method: "GET",
    path: "/v1/ready",
    legacyAlias: "/ready, /readiness",
  },
  { method: "GET", path: "/v1/markets", legacyAlias: "/markets" },
  { method: "GET", path: "/v1/markets/:id", legacyAlias: "/markets/:id" },
  {
    method: "GET",
    path: "/v1/markets/:id/orderbook",
    legacyAlias: "/markets/:id/orderbook",
  },
  { method: "POST", path: "/v1/orders", legacyAlias: "/orders" },
  {
    method: "GET",
    path: "/v1/orders/user/:address",
    legacyAlias: "/orders/user/:address",
  },
  {
    method: "GET",
    path: "/v1/trades/user/:address",
    legacyAlias: "/trades/user/:address",
  },
  {
    method: "GET",
    path: "/v1/wallets/:wallet/positions",
    legacyAlias: "/positions/user/:address",
    notes: "Canonical wallet positions path",
  },
  {
    method: "GET",
    path: "/v1/wallets/:wallet/positions/:marketId",
    notes: "Single-market position read",
  },
  {
    method: "GET",
    path: "/v1/admin/markets",
    legacyAlias: "/admin/markets",
    notes: "Requires API key and admin auth",
  },
  {
    method: "PATCH",
    path: "/v1/admin/markets/:id/status",
    legacyAlias: "/admin/markets/:id/status",
    notes: "Requires API key and admin auth",
  },
  {
    method: "GET",
    path: "/v1/openapi.json",
    notes: "OpenAPI specification",
  },
];
