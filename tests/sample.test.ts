import { describe, it, expect } from "vitest";
import { testUtils } from "./setup.js";

describe("Sample Test Setup", () => {
  it("should create and retrieve a test market", async () => {
    const market = await testUtils.createTestMarket({
      question: "Will this test pass?",
    });

    expect(market).toBeDefined();
    expect(market.question).toBe("Will this test pass?");
    expect(market.status).toBe("ACTIVE");
    expect(market.id).toBeDefined();
  });

  it("should create a test position with correct defaults", async () => {
    // First create a market
    const market = await testUtils.createTestMarket();
    
    // Create a position
    const position = await testUtils.createTestPosition(
      market.id,
      testUtils.generateStellarAddress()
    );

    expect(position).toBeDefined();
    expect(position.yesShares).toBe(100);
    expect(position.noShares).toBe(50);
    expect(position.marketId).toBe(market.id);
  });

  it("should validate decimal precision correctly", () => {
    expect(testUtils.assertDecimalEqual(0.12345678, 0.12345678)).toBe(true);
    expect(testUtils.assertDecimalEqual(0.12345678, 0.12345679)).toBe(false);
    expect(testUtils.assertDecimalEqual(1.00000001, 1.00000000, 8)).toBe(false);
    expect(testUtils.assertDecimalEqual(1.00000001, 1.00000000, 7)).toBe(true);
  });

  it("should generate valid Stellar addresses", () => {
    const address = testUtils.generateStellarAddress();
    expect(address).toMatch(/^G[A-Z0-9]{55}$/);
    
    const customAddress = testUtils.generateStellarAddress("GTEST");
    expect(customAddress).toMatch(/^GTEST[A-Z0-9]{51}$/);
  });
});
