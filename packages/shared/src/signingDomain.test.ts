import { describe, it, expect } from "vitest";
import {
  SIGNING_DOMAINS,
  STUB_NETWORK_PASSPHRASE,
  SigningDomainConfigError,
  resolveSigningNetworkPassphrase,
  buildDomainSeparatedMessage,
} from "./signingDomain";

describe("resolveSigningNetworkPassphrase", () => {
  it("throws SigningDomainConfigError in production when passphrase is unset", () => {
    expect(() =>
      resolveSigningNetworkPassphrase({ NODE_ENV: "production" })
    ).toThrow(SigningDomainConfigError);
  });

  it("throws SigningDomainConfigError in production when passphrase is whitespace-only", () => {
    expect(() =>
      resolveSigningNetworkPassphrase({
        NODE_ENV: "production",
        SOROBAN_NETWORK_PASSPHRASE: "   ",
      })
    ).toThrow(SigningDomainConfigError);
  });

  it("returns the trimmed configured passphrase in production", () => {
    const result = resolveSigningNetworkPassphrase({
      NODE_ENV: "production",
      SOROBAN_NETWORK_PASSPHRASE: "  Public Global Stellar Network ; September 2015  ",
    });
    expect(result).toBe("Public Global Stellar Network ; September 2015");
  });

  it("falls back to STUB_NETWORK_PASSPHRASE outside production when unset", () => {
    expect(resolveSigningNetworkPassphrase({})).toBe(STUB_NETWORK_PASSPHRASE);
    expect(
      resolveSigningNetworkPassphrase({ NODE_ENV: "development" })
    ).toBe(STUB_NETWORK_PASSPHRASE);
    expect(resolveSigningNetworkPassphrase({ NODE_ENV: "test" })).toBe(
      STUB_NETWORK_PASSPHRASE
    );
  });
});

describe("buildDomainSeparatedMessage", () => {
  it("produces an envelope with exactly domain/network/payload in order", () => {
    const message = buildDomainSeparatedMessage(
      SIGNING_DOMAINS.ORDER_RECEIPT,
      STUB_NETWORK_PASSPHRASE,
      { orderId: "abc", amount: 10 }
    );
    const parsed = JSON.parse(message);
    expect(Object.keys(parsed)).toEqual(["domain", "network", "payload"]);
    expect(parsed.domain).toBe(SIGNING_DOMAINS.ORDER_RECEIPT);
    expect(parsed.network).toBe(STUB_NETWORK_PASSPHRASE);
    expect(parsed.payload).toEqual({ orderId: "abc", amount: 10 });
  });

  it("produces different messages for different domains with the same payload", () => {
    const payload = { orderId: "abc", amount: 10 };
    const receipt = buildDomainSeparatedMessage(
      SIGNING_DOMAINS.ORDER_RECEIPT,
      STUB_NETWORK_PASSPHRASE,
      payload
    );
    const resolution = buildDomainSeparatedMessage(
      SIGNING_DOMAINS.ORACLE_RESOLUTION,
      STUB_NETWORK_PASSPHRASE,
      payload
    );
    expect(receipt).not.toBe(resolution);
  });
});
