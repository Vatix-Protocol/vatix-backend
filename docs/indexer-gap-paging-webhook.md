# Indexer gap-paging webhook: SSRF policy (#1160)

The indexer makes one outbound request to an operator-supplied URL: the
persistent-gap paging webhook (`GapPagingConfig.webhookUrl`, documented as
`INDEXER_GAP_PAGING_WEBHOOK_URL`). No API route accepts a webhook or callback
URL from clients, so no client-controlled outbound request exists. This page
covers the guard on the paging webhook.

References: `apps/indexer/src/webhookUrlPolicy.ts`,
`apps/indexer/src/gapDetector.ts`, [`SECURITY.md`](../SECURITY.md),
[`indexer-gap-backfill.md`](indexer-gap-backfill.md).

## Invariants

1. **Validated at startup.** `GapDetector` validates the URL in its
   constructor and throws `WebhookUrlError`, so a bad value stops the indexer
   before it starts polling. The URL must be absolute `http(s)` and must not
   embed `user:password@` credentials, in every environment.
2. **Production requires https and a public host.** With
   `nodeEnv=production`, `http://` is rejected, and so is any host that is
   `localhost`/`*.localhost` or a loopback, RFC 1918, carrier-grade NAT,
   link-local (including cloud metadata `169.254.169.254`), multicast or
   reserved address, in IPv4, IPv6 or IPv4-mapped IPv6 form. Alternate IP
   spellings (`2130706433`, `0x7f.1`) are normalised by the URL parser first.
3. **Re-checked before every send.** In production the hostname is resolved
   before each call, and the page is not sent if any resolved address is
   private or nothing resolves. This stops a public hostname from pointing (or
   being re-pointed) at an internal service.
4. **No redirects, bounded time.** The request uses `redirect: "error"` and
   `AbortSignal.timeout(PAGING_WEBHOOK_TIMEOUT_MS)` (5 s), so a receiver
   cannot bounce the call to an internal address or stall back-fill.
5. **The URL is never logged.** Webhook URLs often carry a secret token, so
   neither logs nor `WebhookUrlError` messages contain the URL.
6. **Paging never blocks ingestion.** Every failure is logged and counted.
   `runBackfill` goes on to the same result it would have reached without
   paging.

## Error codes

| Code                               | Meaning                                                   |
| ---------------------------------- | --------------------------------------------------------- |
| `WEBHOOK_URL_INVALID`              | Not a parseable absolute URL, or scheme is not `http(s)`. |
| `WEBHOOK_URL_INSECURE_SCHEME`      | `http://` in production.                                  |
| `WEBHOOK_URL_EMBEDDED_CREDENTIALS` | URL contains `user:password@`.                            |
| `WEBHOOK_URL_PRIVATE_HOST`         | Host is, or resolves to, a private/loopback/reserved IP.  |

## Observability

`vatix_indexer_gap_paging_webhook_total{outcome}` counts each paging attempt:

| Outcome      | Meaning                                                  |
| ------------ | -------------------------------------------------------- |
| `sent`       | Receiver answered 2xx.                                   |
| `http_error` | Receiver answered non-2xx.                               |
| `blocked`    | SSRF policy refused the resolved host; nothing was sent. |
| `failed`     | DNS failure, network error, timeout or refused redirect. |

Any non-`sent` outcome means operators were **not** paged. Alert on it.
Log events: `indexer.gap.paging.blocked` (error, with `code`),
`indexer.gap.paging.webhook_error` and `indexer.gap.paging.error` (warn). All
carry the back-fill `correlationId`.

## Private receivers and rollback

Set `pagingConfig.allowPrivateNetwork: true` when the receiver lives on a
private network (for example an in-cluster Alertmanager). This skips the
private-host and DNS checks and nothing else: https is still required in
production, and credentials, redirects and the timeout rules still apply. The
option is off by default. If the guard blocks a legitimate receiver, point the
URL at a public https endpoint, or turn on `allowPrivateNetwork` for that
deployment. Neither needs a code change.

## Residual risk

The send-time check and `fetch` each resolve the hostname, so a receiver
whose DNS changes between the two lookups (a DNS-rebinding race) is not fully
excluded. The URL is operator-configured, not client-supplied, which keeps
this risk low.
