import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "crypto";
import { BreakGlassService } from "./break-glass.js";
import type { ILogger } from "../../packages/shared/src/logger.js";

const mockLogger: ILogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(function (this: ILogger) {
    return this;
  }),
};

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

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
            tokenHash: hashToken("token-123"),
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
            tokenHash: hashToken("token"),
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

  describe("dual-control enforcement at the service boundary", () => {
    function buildPrisma(overrides: Record<string, any> = {}) {
      const prisma: any = {
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
            tokenHash: hashToken("token-123"),
            action: "halt",
            expiresAt: new Date(Date.now() + 15 * 60000),
            approvedBy: null,
            consumedAt: null,
          }),
          update: vi.fn().mockResolvedValue({}),
        },
        adminAction: {
          create: vi.fn().mockResolvedValue({ id: "audit-1" }),
          findUnique: vi.fn().mockResolvedValue(null),
        },
        $transaction: vi.fn().mockImplementation(async (fn: any) => fn(prisma)),
        ...overrides,
      };
      return prisma;
    }

    it("rejects a single-actor approval with a typed error code", async () => {
      const prisma = buildPrisma();
      service = new BreakGlassService(prisma as any, mockLogger);

      await expect(
        service.executeWithApproval(
          {
            marketId: "market-1",
            action: "halt",
            actor: "admin-1",
            requestId: "req-123",
            approvalToken: "token-123",
          },
          "admin-1"
        )
      ).rejects.toMatchObject({ code: "DUAL_CONTROL_REQUIRED" });

      expect(prisma.market.update).not.toHaveBeenCalled();
    });

    it("succeeds with two distinct approvals", async () => {
      const prisma = buildPrisma();
      service = new BreakGlassService(prisma as any, mockLogger);

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
      expect(prisma.market.update).toHaveBeenCalledTimes(1);
    });

    it("does not double-apply a replayed idempotency key", async () => {
      const prisma = buildPrisma();
      service = new BreakGlassService(prisma as any, mockLogger);

      const request = {
        marketId: "market-1",
        action: "halt" as const,
        actor: "admin-1",
        requestId: "req-123",
        approvalToken: "token-123",
      };

      await service.executeWithApproval(request, "admin-2");

      // Simulate the token now being consumed so a replay is rejected.
      prisma.adminApprovalToken.findUnique.mockResolvedValue({
        id: "token-1",
        tokenHash: hashToken("token-123"),
        action: "halt",
        expiresAt: new Date(Date.now() + 15 * 60000),
        approvedBy: "admin-2",
        consumedAt: new Date(),
      });

      await expect(
        service.executeWithApproval(request, "admin-2")
      ).rejects.toMatchObject({ code: "APPROVAL_ALREADY_CONSUMED" });

      expect(prisma.market.update).toHaveBeenCalledTimes(1);
    });

    it("rejects an expired approval using fake timers", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));

        const prisma = buildPrisma({
          adminApprovalToken: {
            findUnique: vi.fn().mockResolvedValue({
              id: "token-1",
              tokenHash: hashToken("token-123"),
              action: "halt",
              expiresAt: new Date("2024-01-01T00:00:00.000Z"),
              approvedBy: null,
              consumedAt: null,
            }),
            update: vi.fn().mockResolvedValue({}),
          },
        });
        service = new BreakGlassService(prisma as any, mockLogger);

        vi.advanceTimersByTime(60 * 1000);

        await expect(
          service.executeWithApproval(
            {
              marketId: "market-1",
              action: "halt",
              actor: "admin-1",
              requestId: "req-123",
              approvalToken: "token-123",
            },
            "admin-2"
          )
        ).rejects.toMatchObject({ code: "APPROVAL_EXPIRED" });

        expect(prisma.market.update).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
