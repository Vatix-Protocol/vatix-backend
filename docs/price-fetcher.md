# Price Fetcher

The **Price Fetcher** is an internal component of the Oracle app that is responsible for retrieving external asset pricing data.

## Overview

The component securely and reliably requests live price feeds from registered external providers and returns structured responses with confidence scores.

## Providers

- **Primary Provider**: Used for the first attempt.
- **Fallback Provider**: Kicks in automatically if the primary provider times out, fails authentication, or returns an invalid response.

## Integration

The price fetcher results are enqueued into the **Submission Queue** to be later signed and dispatched on-chain.
