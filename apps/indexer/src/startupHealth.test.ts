import { describe, it, expect } from "vitest";
import { checkStartupHealth } from "./startupHealth.js";

const validInput = {
  cursor: "12345",
  networkId: "mainnet",
  cursorKey: "ingestion",
};

describe("checkStartupHealth", () => {
  it("returns 200 for valid input", () => {
    expect(checkStartupHealth(validInput)).toMatchObject({
      status: 200,
      valid: true,
      errors: [],
    });
  });

  it("accepts null cursor (no persisted cursor yet)", () => {
    const result = checkStartupHealth({ ...validInput, cursor: null });
    expect(result.status).toBe(200);
    expect(result.valid).toBe(true);
  });

  it("returns 400 when networkId is empty", () => {
    const result = checkStartupHealth({ ...validInput, networkId: "" });
    expect(result.status).toBe(400);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("networkId"))).toBe(true);
  });

  it("returns 400 when networkId is whitespace only", () => {
    const result = checkStartupHealth({ ...validInput, networkId: "   " });
    expect(result.status).toBe(400);
    expect(result.valid).toBe(false);
  });

  it("returns 400 when cursorKey is empty", () => {
    const result = checkStartupHealth({ ...validInput, cursorKey: "" });
    expect(result.status).toBe(400);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("cursorKey"))).toBe(true);
  });

  it("returns 400 when cursor is non-numeric", () => {
    const result = checkStartupHealth({ ...validInput, cursor: "not-a-number" });
    expect(result.status).toBe(400);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("cursor"))).toBe(true);
  });

  it("returns 400 when cursor is negative", () => {
    const result = checkStartupHealth({ ...validInput, cursor: "-1" });
    expect(result.status).toBe(400);
    expect(result.valid).toBe(false);
  });

  it("returns 400 when cursor is a float", () => {
    const result = checkStartupHealth({ ...validInput, cursor: "1.5" });
    expect(result.status).toBe(400);
    expect(result.valid).toBe(false);
  });

  it("collects multiple validation errors", () => {
    const result = checkStartupHealth({
      cursor: "bad",
      networkId: "",
      cursorKey: "",
    });
    expect(result.status).toBe(400);
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });
});
