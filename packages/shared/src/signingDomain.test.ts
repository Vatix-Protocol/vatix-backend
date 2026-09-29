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

    // #1133 — the dev/test stub IS the testnet passphrase, so it must not be
    // used to sign for a deployment that declares itself on mainnet. That
    // binding is the whole point of domain separation, and a testnet binding
    // on a mainnet deployment is a silent cross-network signature failure.
    it("refuses the testnet stub when STELLAR_NETWORK=mainnet, even in dev", () => {
      expect(() =>
        resolveSigningNetworkPassphrase({
          NODE_ENV: "development",
          STELLAR_NETWORK: "mainnet",
        })
      ).toThrow(SigningDomainConfigError);
      expect(() =>
        resolveSigningNetworkPassphrase({
          NODE_ENV: "development",
          STELLAR_NETWORK: "mainnet",
        })
      ).toThrow(/STELLAR_NETWORK="mainnet"/);
    });

    it("normalizes STELLAR_NETWORK before comparing it to the stub's network", () => {
      expect(() =>
        resolveSigningNetworkPassphrase({
          NODE_ENV: "test",
          STELLAR_NETWORK: "  MainNet  ",
        })
      ).toThrow(SigningDomainConfigError);
    });

    it("still allows the stub when STELLAR_NETWORK is unset or testnet", () => {
      expect(
        resolveSigningNetworkPassphrase({
          NODE_ENV: "development",
          STELLAR_NETWORK: "testnet",
        })
      ).toBe(STUB_NETWORK_PASSPHRASE);
    });

    it("still allows the stub for a custom network (no published passphrase)", () => {
      expect(
        resolveSigningNetworkPassphrase({
          NODE_ENV: "development",
          STELLAR_NETWORK: "futurenet",
        })
      ).toBe(STUB_NETWORK_PASSPHRASE);
    });

    it("never embeds a passphrase value in the thrown message", () => {
      let thrown: unknown;
      try {
        resolveSigningNetworkPassphrase({
          NODE_ENV: "development",
          STELLAR_NETWORK: "mainnet",
          SOROBAN_NETWORK_PASSPHRASE: "   ",
        });
      } catch (err) {
        thrown = err;
      }
      expect((thrown as Error).message).toContain(
        "SOROBAN_NETWORK_PASSPHRASE is required"
      );
      expect((thrown as Error).message).not.toContain(STUB_NETWORK_PASSPHRASE);
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
