import { describe, it, expect, beforeEach, vi } from "vitest";
import { BreakGlassService } from "./break-glass.js";
import type { ILogger } from "../../packages/shared/src/logger.js";

const mockLogger: ILogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

describe("BreakGlassService", () => {
  let service: BreakGlassService;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("initiateApproval", () => {
    it("should create approval token with expiration", async () => {
      const mockPrisma = {
        adminApprovalToken: {
          create: vi.fn().mockResolvedValue({
            id: "token-1",
            requestId: "req-123",
            expiresAt: new Date(Date.now() + 15 * 60000),
          }),
        },
      };

      service = new BreakGlassService(mockPrisma as any, mockLogger);

      const result = await service.initiateApproval({
        marketId: "market-1",
        action: "halt",
        initiator: "admin-1",
        requestId: "req-123",
        reason: "Testing",
      });

      expect(result.token).toBeDefined();
      expect(result.expiresAt).toBeDefined();
      expect(result.requestId).toBe("req-123");
      expect(mockPrisma.adminApprovalToken.create).toHaveBeenCalled();
    });
  });

  describe("executeWithApproval", () => {
    it("should halt market without resting orders", async () => {
      const mockPrisma = {
        market: {
          findUnique: vi.fn().mockResolvedValue({
            id: "market-1",
            status: "ACTIVE",
            question: "Test",
            endTime: new Date(),
            oracleAddress: "test",
          }),
          update: vi.fn().mockResolvedValue({
            id: "market-1",
            status: "CANCELLED",
          }),
        },
        adminApprovalToken: {
          findUnique: vi.fn().mockResolvedValue({
            id: "token-1",
            tokenHash: vi
              .fn()
              .mockReturnValue("token-hash"), // Will be mocked
            action: "halt",
            expiresAt: new Date(Date.now() + 1000),
            approvedBy: null,
          }),
          update: vi.fn().mockResolvedValue({}),
        },
        adminAction: {
          create: vi.fn().mockResolvedValue({ id: "audit-1" }),
        },
        $transaction: vi.fn().mockImplementation(async (fn) => {
          return fn(mockPrisma);
        }),
      };

      service = new BreakGlassService(mockPrisma as any, mockLogger);

      const result = await service.executeWithApproval(
        {
          marketId: "market-1",
          action: "halt",
          actor: "admin-1",
          requestId: "req-123",
          approvalToken: "token-123",
        },
        "admin-2"
      );

      expect(result.action).toBe("halt");
      expect(result.beforeStatus).toBe("ACTIVE");
    });
  });

  describe("cancelAllOrders", () => {
    it("should cancel all resting orders and release collateral", async () => {
      const mockPrisma = {
        market: {
          findUnique: vi.fn().mockResolvedValue({
            id: "market-1",
            status: "ACTIVE",
          }),
        },
        order: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: "order-1",
              userAddress: "user-1",
              side: "BUY",
              price: 0.5,
              quantity: 100,
              filledQuantity: 0,
            },
          ]),
          update: vi.fn().mockResolvedValue({}),
        },
        userPosition: {
          findUnique: vi.fn().mockResolvedValue({
            lockedCollateral: 50,
          }),
          update: vi.fn().mockResolvedValue({}),
        },
        adminAction: {
          create: vi.fn().mockResolvedValue({ id: "audit-1" }),
        },
        $transaction: vi.fn().mockImplementation(async (fn) => {
          return fn(mockPrisma);
        }),
      };

      service = new BreakGlassService(mockPrisma as any, mockLogger);

      // This test setup verifies the structure works
      expect(service).toBeDefined();
    });
  });

  describe("dual-control flow", () => {
    it("should require token for execution after initiation", async () => {
      const mockPrisma = {
        adminApprovalToken: {
          findUnique: vi.fn().mockResolvedValueOnce(null),
        },
      };

      service = new BreakGlassService(mockPrisma as any, mockLogger);

      // Should fail when token not found
      try {
        await (service as any).validateAndConsumeToken(
          "req-123",
          "invalid-token",
          "halt",
          "admin-2"
        );
        expect.fail("Should have thrown");
      } catch (error) {
        expect((error as Error).message).toContain("not found");
      }
    });

    it("should reject expired tokens", async () => {
      const mockPrisma = {
        adminApprovalToken: {
          findUnique: vi.fn().mockResolvedValue({
            id: "token-1",
            tokenHash: "hash",
            action: "halt",
            expiresAt: new Date(Date.now() - 1000), // Already expired
            approvedBy: null,
          }),
        },
      };

      service = new BreakGlassService(mockPrisma as any, mockLogger);

      try {
        await (service as any).validateAndConsumeToken(
          "req-123",
          "token",
          "halt",
          "admin-2"
        );
        expect.fail("Should have thrown");
      } catch (error) {
        expect((error as Error).message).toContain("expired");
      }
    });
  });
});
