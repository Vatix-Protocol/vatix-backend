import { describe, it, expect } from "vitest";
import { validateOrderSide } from "./validation.js";

describe("validateOrderSide", () => {
  it("rejects a missing side (undefined) with 'Order side is required'", () => {
    expect(validateOrderSide(undefined)).toBe("Order side is required");
  });

  it("accepts 'SELL'", () => {
    expect(validateOrderSide("SELL")).toBeNull();
  });

  it("rejects 'HOLD' with \"Order side must be 'BUY' or 'SELL'\"", () => {
    expect(validateOrderSide("HOLD")).toBe("Order side must be 'BUY' or 'SELL'");
  });
});
