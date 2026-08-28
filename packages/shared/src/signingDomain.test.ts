import { describe, it, expect } from "vitest";
import {
  SIGNING_DOMAINS,
  STUB_NETWORK_PASSPHRASE,
  SigningDomainConfigError,
  resolveSigningNetworkPassphrase,
  buildDomainSeparatedMessage,
} from "./signingDomain.js";

describe("signingDomain — domain separation (#978)", () => {
  describe("SIGNING_DOMAINS", () => {
    it("uses distinct tags for order receipts and oracle resolutions", () => {
      expect(SIGNING_DOMAINS.ORDER_RECEIPT).not.toBe(
        SIGNING_DOMAINS.ORACLE_RESOLUTION
      );
    });
  });

  describe("resolveSigningNetworkPassphrase", () => {
    it("returns the configured passphrase when set", () => {
      const passphrase = "Public Global Stellar Network ; September 2015";
      expect(
        resolveSigningNetworkPassphrase({
          SOROBAN_NETWORK_PASSPHRASE: passphrase,
        })
      ).toBe(passphrase);
    });

    it("trims surrounding whitespace on the configured passphrase", () => {
      expect(
        resolveSigningNetworkPassphrase({
          SOROBAN_NETWORK_PASSPHRASE: "  net  ",
        })
      ).toBe("net");
    });

    it("falls back to the stub passphrase outside production", () => {
      expect(resolveSigningNetworkPassphrase({ NODE_ENV: "development" })).toBe(
        STUB_NETWORK_PASSPHRASE
      );
      expect(resolveSigningNetworkPassphrase({ NODE_ENV: "test" })).toBe(
        STUB_NETWORK_PASSPHRASE
      );
    });

    it("throws in production when the passphrase is unset (no silent stub)", () => {
      expect(() =>
        resolveSigningNetworkPassphrase({ NODE_ENV: "production" })
      ).toThrow(SigningDomainConfigError);
    });

    it("throws in production when the passphrase is blank", () => {
      expect(() =>
        resolveSigningNetworkPassphrase({
          NODE_ENV: "production",
          SOROBAN_NETWORK_PASSPHRASE: "   ",
        })
      ).toThrow(/SOROBAN_NETWORK_PASSPHRASE is required in production/);
    });
  });

  describe("buildDomainSeparatedMessage", () => {
    it("embeds the domain tag and network in the signed bytes", () => {
      const msg = buildDomainSeparatedMessage(
        SIGNING_DOMAINS.ORDER_RECEIPT,
        "net-a",
        { a: 1 }
      );
      const parsed = JSON.parse(msg);
      expect(parsed.domain).toBe(SIGNING_DOMAINS.ORDER_RECEIPT);
      expect(parsed.network).toBe("net-a");
      expect(parsed.payload).toEqual({ a: 1 });
    });

    it("produces different bytes for the same payload under different domains", () => {
      const a = buildDomainSeparatedMessage(
        SIGNING_DOMAINS.ORDER_RECEIPT,
        "net",
        { x: 1 }
      );
      const b = buildDomainSeparatedMessage(
        SIGNING_DOMAINS.ORACLE_RESOLUTION,
        "net",
        { x: 1 }
      );
      expect(a).not.toBe(b);
    });

    it("produces different bytes for the same payload on different networks", () => {
      const a = buildDomainSeparatedMessage(
        SIGNING_DOMAINS.ORDER_RECEIPT,
        "testnet",
        { x: 1 }
      );
      const b = buildDomainSeparatedMessage(
        SIGNING_DOMAINS.ORDER_RECEIPT,
        "mainnet",
        { x: 1 }
      );
      expect(a).not.toBe(b);
    });

    it("is deterministic for identical inputs", () => {
      const mk = () =>
        buildDomainSeparatedMessage(SIGNING_DOMAINS.ORDER_RECEIPT, "net", {
          x: 1,
          y: 2,
        });
      expect(mk()).toBe(mk());
    });
  });
});
