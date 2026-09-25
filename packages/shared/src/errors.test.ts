import { describe, it, expect } from "vitest";
import { createErrorEnvelope } from "./errors.js";

describe("createErrorEnvelope", () => {
  it("builds the standard envelope shape, mirroring message into error", () => {
    const envelope = createErrorEnvelope({
      code: "NOT_FOUND",
      message: "Market not found",
      statusCode: 404,
      requestId: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    });

    expect(envelope).toEqual({
      code: "NOT_FOUND",
      message: "Market not found",
      error: "Market not found",
      statusCode: 404,
      requestId: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    });
  });

  it("omits fields and stack when not supplied", () => {
    const envelope = createErrorEnvelope({
      code: "INTERNAL_ERROR",
      message: "boom",
      statusCode: 500,
      requestId: "req-1",
    });

    expect(envelope).not.toHaveProperty("fields");
    expect(envelope).not.toHaveProperty("stack");
  });

  it("includes fields when supplied (e.g. ValidationError)", () => {
    const envelope = createErrorEnvelope({
      code: "VALIDATION_ERROR",
      message: "bad input",
      statusCode: 400,
      requestId: "req-2",
      fields: { email: "invalid" },
    });

    expect(envelope.fields).toEqual({ email: "invalid" });
  });

  it("includes stack when supplied", () => {
    const envelope = createErrorEnvelope({
      code: "INTERNAL_ERROR",
      message: "boom",
      statusCode: 500,
      requestId: "req-3",
      stack: "Error: boom\n  at somewhere",
    });

    expect(envelope.stack).toBe("Error: boom\n  at somewhere");
  });
});
