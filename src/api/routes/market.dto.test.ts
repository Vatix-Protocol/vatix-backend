import { describe, it, expect } from "vitest";
import { computeMarketEtag } from "./market.dto";

describe("computeMarketEtag", () => {
  it("returns the same string for two Date instances built from the same ISO timestamp", () => {
    const iso = "2024-01-02T03:04:05.678Z";
    const a = computeMarketEtag({ id: "mkt-1", updatedAt: new Date(iso) });
    const b = computeMarketEtag({ id: "mkt-1", updatedAt: new Date(iso) });
    expect(a).toBe(b);
  });

  it("returns different strings when only updatedAt differs", () => {
    const a = computeMarketEtag({
      id: "mkt-1",
      updatedAt: new Date("2024-01-02T03:04:05.678Z"),
    });
    const b = computeMarketEtag({
      id: "mkt-1",
      updatedAt: new Date("2024-01-02T03:04:05.679Z"),
    });
    expect(a).not.toBe(b);
  });

  it("returns different strings when only id differs", () => {
    const updatedAt = new Date("2024-01-02T03:04:05.678Z");
    const a = computeMarketEtag({ id: "mkt-1", updatedAt });
    const b = computeMarketEtag({ id: "mkt-2", updatedAt });
    expect(a).not.toBe(b);
  });

  it("preserves the weak-validator W/ prefix and quoting", () => {
    const etag = computeMarketEtag({
      id: "mkt-1",
      updatedAt: new Date("2024-01-02T03:04:05.678Z"),
    });
    expect(etag.startsWith('W/"')).toBe(true);
    expect(etag.endsWith('"')).toBe(true);
  });

  it("pins the exact output for a fixed id and timestamp", () => {
    const etag = computeMarketEtag({
      id: "mkt-1",
      updatedAt: new Date("2024-01-02T03:04:05.678Z"),
    });
    expect(etag).toBe('W/"mkt-1-2024-01-02T03:04:05.678Z"');
  });
});
