import { BlockList, isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";

/**
 * SSRF guard for the outbound gap-paging webhook (#1160).
 *
 * The webhook URL is operator-configured, never client-supplied, but it is
 * still the indexer's only outbound request to an arbitrary host. A
 * misconfigured or tampered value must not be able to reach loopback,
 * private-network or cloud-metadata addresses, leak credentials, or be
 * bounced elsewhere via redirects.
 */

export const WEBHOOK_URL_ERROR_CODES = {
  /** Not a parseable absolute http(s) URL. */
  WEBHOOK_URL_INVALID: "WEBHOOK_URL_INVALID",
  /** Plain http:// outside dev/test. */
  WEBHOOK_URL_INSECURE_SCHEME: "WEBHOOK_URL_INSECURE_SCHEME",
  /** URL embeds `user:password@` credentials. */
  WEBHOOK_URL_EMBEDDED_CREDENTIALS: "WEBHOOK_URL_EMBEDDED_CREDENTIALS",
  /** Host is, or resolves to, a loopback/private/link-local/reserved address. */
  WEBHOOK_URL_PRIVATE_HOST: "WEBHOOK_URL_PRIVATE_HOST",
} as const;

export type WebhookUrlErrorCode =
  (typeof WEBHOOK_URL_ERROR_CODES)[keyof typeof WEBHOOK_URL_ERROR_CODES];

/** Never carries the URL itself — webhook URLs routinely embed secrets. */
export class WebhookUrlError extends Error {
  constructor(
    readonly code: WebhookUrlErrorCode,
    message: string
  ) {
    super(message);
    this.name = "WebhookUrlError";
  }
}

export interface WebhookUrlPolicyOptions {
  /** `production` enforces https and public hosts. */
  nodeEnv?: string;
  /**
   * Opt-in for an alert receiver on a private network (e.g. an in-cluster
   * Alertmanager). Deny-by-default.
   */
  allowPrivateNetwork?: boolean;
}

const BLOCKED_RANGES = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8], // RFC 1918
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, incl. cloud metadata 169.254.169.254
  ["172.16.0.0", 12], // RFC 1918
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.168.0.0", 16], // RFC 1918
  ["198.18.0.0", 15], // benchmarking
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
] as const) {
  BLOCKED_RANGES.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
] as const) {
  BLOCKED_RANGES.addSubnet(network, prefix, "ipv6");
}

/** True for loopback, private, link-local, multicast and reserved addresses. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  // BlockList matches IPv4-mapped IPv6 (::ffff:a.b.c.d) against IPv4 rules.
  return BLOCKED_RANGES.check(address, family === 4 ? "ipv4" : "ipv6");
}

function isPrivateHostname(hostname: string): boolean {
  const host = hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    isPrivateAddress(host)
  );
}

function enforcesPublicHost(options: WebhookUrlPolicyOptions): boolean {
  return options.nodeEnv === "production" && !options.allowPrivateNetwork;
}

/**
 * Static checks, run once at startup so a bad URL fails fast.
 *
 * @throws {WebhookUrlError}
 */
export function validateWebhookUrl(
  rawUrl: string,
  options: WebhookUrlPolicyOptions = {}
): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new WebhookUrlError(
      WEBHOOK_URL_ERROR_CODES.WEBHOOK_URL_INVALID,
      "Webhook URL is not a valid absolute URL"
    );
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new WebhookUrlError(
      WEBHOOK_URL_ERROR_CODES.WEBHOOK_URL_INVALID,
      `Webhook URL scheme ${url.protocol} is not allowed; use https`
    );
  }
  if (url.protocol === "http:" && options.nodeEnv === "production") {
    throw new WebhookUrlError(
      WEBHOOK_URL_ERROR_CODES.WEBHOOK_URL_INSECURE_SCHEME,
      "Webhook URL must use https in production"
    );
  }
  if (url.username || url.password) {
    throw new WebhookUrlError(
      WEBHOOK_URL_ERROR_CODES.WEBHOOK_URL_EMBEDDED_CREDENTIALS,
      "Webhook URL must not embed credentials"
    );
  }
  if (enforcesPublicHost(options) && isPrivateHostname(url.hostname)) {
    throw new WebhookUrlError(
      WEBHOOK_URL_ERROR_CODES.WEBHOOK_URL_PRIVATE_HOST,
      "Webhook URL host is a private, loopback or link-local address"
    );
  }
  return url;
}

export type HostLookup = (
  hostname: string
) => Promise<ReadonlyArray<{ address: string }>>;

const defaultLookup: HostLookup = (hostname) =>
  dnsLookup(hostname, { all: true, verbatim: true });

/**
 * Send-time check: resolve the host and reject if any address is private,
 * so a public-looking hostname cannot point (or be re-pointed) at an
 * internal service. No-op where the policy allows private hosts.
 *
 * @throws {WebhookUrlError}
 */
export async function assertWebhookHostIsPublic(
  url: URL,
  options: WebhookUrlPolicyOptions = {},
  lookup: HostLookup = defaultLookup
): Promise<void> {
  if (!enforcesPublicHost(options)) return;

  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host);
  if (
    addresses.length === 0 ||
    addresses.some(({ address }) => isPrivateAddress(address))
  ) {
    throw new WebhookUrlError(
      WEBHOOK_URL_ERROR_CODES.WEBHOOK_URL_PRIVATE_HOST,
      "Webhook URL host resolves to a private, loopback or link-local address"
    );
  }
}
