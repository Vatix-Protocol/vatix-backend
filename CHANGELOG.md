# Changelog

## Unreleased

- Public API routes are canonical under `/v1/*`. Update frontend clients
  (`apps/web`) and external integrations to use `/v1/health`, `/v1/ready`,
  `/v1/markets`, `/v1/orders`, `/v1/orders/user/:address`,
  `/v1/trades/user/:address`, and `/v1/wallets/:wallet/positions`.
- Legacy root aliases such as `/markets`, `/orders`, and
  `/positions/user/:address` return `308` with deprecation headers until
  `2027-01-01T00:00:00Z`, then return `404`.
