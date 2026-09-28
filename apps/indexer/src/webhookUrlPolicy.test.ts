import { describe, it, expect, vi } from "vitest";
import {
  WEBHOOK_URL_ERROR_CODES,
  WebhookUrlError,
  assertWebhookHostIsPublic,
  isPrivateAddress,
  validateWebhookUrl,
} from "./webhookUrlPolicy.js";

const PROD = { nodeEnv: "production" };

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof WebhookUrlError ? err.code : "NOT_WEBHOOK_URL_ERROR";
  }
  return undefined;
}

describe("isPrivateAddress", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "fd00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "::ffff:169.254.169.254",
  ])("blocks %s", (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each(["8.8.8.8", "172.32.0.1", "2606:4700:4700::1111", "not-an-ip"])(
    "allows %s",
    (address) => {
      expect(isPrivateAddress(address)).toBe(false);
    }
  );
});

describe("validateWebhookUrl", () => {
  it("accepts a public https URL in production", () => {
    expect(
      validateWebhookUrl("https://hooks.example.com/page", PROD).host
    ).toBe("hooks.example.com");
  });

  it("rejects unparseable and non-http(s) URLs", () => {
    expect(codeOf(() => validateWebhookUrl("not a url"))).toBe(
      WEBHOOK_URL_ERROR_CODES.WEBHOOK_URL_INVALID
    );
    for (const url of [
      "file:///etc/passwd",
      "ftp://example.com/",
      "gopher://x/",
    ]) {
      expect(codeOf(() => validateWebhookUrl(url))).toBe(
        WEBHOOK_URL_ERROR_CODES.WEBHOOK_URL_INVALID
      );
    }
  });

  it("requires https in production but allows http in dev/test", () => {
    expect(
      codeOf(() => validateWebhookUrl("http://hooks.example.com", PROD))
    ).toBe(WEBHOOK_URL_ERROR_CODES.WEBHOOK_URL_INSECURE_SCHEME);
    expect(() =>
      validateWebhookUrl("http://localhost:9093/hook", { nodeEnv: "test" })
    ).not.toThrow();
  });

  it("rejects embedded credentials in every environment", () => {
    expect(
      codeOf(() => validateWebhookUrl("https://user:secret@hooks.example.com/"))
    ).toBe(WEBHOOK_URL_ERROR_CODES.WEBHOOK_URL_EMBEDDED_CREDENTIALS);
  });

  it.each([
    "https://localhost/hook",
    "https://api.localhost/hook",
    "https://127.0.0.1/hook",
    "https://2130706433/hook", // decimal form of 127.0.0.1
    "https://0x7f.1/hook", // hex/short form of 127.0.0.1
    "https://169.254.169.254/latest/meta-data",
    "https://10.0.0.5/hook",
    "https://[::1]/hook",
    "https://[::ffff:127.0.0.1]/hook",
    "https://localhost./hook",
  ])("rejects private host %s in production", (url) => {
    expect(codeOf(() => validateWebhookUrl(url, PROD))).toBe(
      WEBHOOK_URL_ERROR_CODES.WEBHOOK_URL_PRIVATE_HOST
    );
  });

  it("allows a private host in production only with allowPrivateNetwork", () => {
    expect(() =>
      validateWebhookUrl("https://10.0.0.5/hook", {
        ...PROD,
        allowPrivateNetwork: true,
      })
    ).not.toThrow();
  });

  it("never echoes the URL (which may carry a token) in the error message", () => {
    try {
      validateWebhookUrl("http://hooks.example.com/T0KEN-SECRET", PROD);
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain("T0KEN-SECRET");
    }
  });
});

describe("assertWebhookHostIsPublic", () => {
  const url = new URL("https://hooks.example.com/page");

  it("passes when every resolved address is public", async () => {
    const lookup = vi.fn().mockResolvedValue([{ address: "93.184.216.34" }]);
    await expect(
      assertWebhookHostIsPublic(url, PROD, lookup)
    ).resolves.toBeUndefined();
    expect(lookup).toHaveBeenCalledWith("hooks.example.com");
  });

  it("rejects when any resolved address is private (DNS rebinding)", async () => {
    const lookup = vi
      .fn()
      .mockResolvedValue([
        { address: "93.184.216.34" },
        { address: "10.0.0.1" },
      ]);
    await expect(
      assertWebhookHostIsPublic(url, PROD, lookup)
    ).rejects.toMatchObject({
      code: WEBHOOK_URL_ERROR_CODES.WEBHOOK_URL_PRIVATE_HOST,
    });
  });

  it("fails closed when the host resolves to nothing", async () => {
    const lookup = vi.fn().mockResolvedValue([]);
    await expect(
      assertWebhookHostIsPublic(url, PROD, lookup)
    ).rejects.toBeInstanceOf(WebhookUrlError);
  });

  it("propagates DNS failures instead of sending", async () => {
    const lookup = vi.fn().mockRejectedValue(new Error("ENOTFOUND"));
    await expect(assertWebhookHostIsPublic(url, PROD, lookup)).rejects.toThrow(
      "ENOTFOUND"
    );
  });

  it("skips resolution outside production or when private hosts are allowed", async () => {
    const lookup = vi.fn();
    await assertWebhookHostIsPublic(url, { nodeEnv: "test" }, lookup);
    await assertWebhookHostIsPublic(
      url,
      { ...PROD, allowPrivateNetwork: true },
      lookup
    );
    expect(lookup).not.toHaveBeenCalled();
  });
});
