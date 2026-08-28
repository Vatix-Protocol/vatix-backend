/**
 * Unit tests for BreakGlassService dual-control enforcement (issue #968).
 *
 * Dual-control is only meaningful when the approver is a DIFFERENT admin identity
 * from the initiator. Without this check, a single compromised token-holder can
 * both initiate and approve a break-glass action, defeating the two-person rule.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { BreakGlassService } from "../src/services/break-glass.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeApprovalRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "approval-id-1",
    requestId: "req-001",
    marketId: "market-abc",
    action: "halt",
    initiator: "alice",      // alice initiated
    tokenHash: "deadbeef",   // will be overridden per test
    expiresAt: new Date(Date.now() + 60_000),
    approvedBy: null,
    reason: null,
    ...overrides,
  };
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BreakGlassService: dual-control same-actor rejection (issue #968)", () => {
  let prisma: any;
  let logger: ReturnType<typeof makeLogger>;
  let service: BreakGlassService;

  beforeEach(() => {
    logger = makeLogger();

    prisma = {
      adminApprovalToken: {
        findUnique: vi.fn(),
        update: vi.fn().mockResolvedValue({}),
        create: vi.fn().mockResolvedValue({}),
      },
      market: {
        findUnique: vi.fn(),
        update: vi.fn(),
      },
      adminAction: {
        create: vi.fn().mockResolvedValue({ id: "audit-id-1" }),
      },
      order: { findMany: vi.fn().mockResolvedValue([]) },
      userPosition: { findUnique: vi.fn(), update: vi.fn() },
      $transaction: vi.fn().mockImplementation((fn: any) => fn(prisma)),
    };

    service = new BreakGlassService(prisma, logger);
  });

  it("rejects when initiator and approver are the same identity (self-approval)", async () => {
    // Token hash in the approval record must match what hashToken produces for 'tok'.
    // We bypass internal hash by mocking findUnique to return the pre-hashed value
    // that the service will compute. Use a known token and derive its sha256.
    const { createHash } = await import("crypto");
    const rawToken = "my-raw-approval-token";
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");

    prisma.adminApprovalToken.findUnique.mockResolvedValue(
      makeApprovalRecord({ tokenHash, initiator: "alice" })
    );
    prisma.market.findUnique.mockResolvedValue({
      id: "market-abc",
      status: "ACTIVE",
    });

    // alice attempts to approve her own initiation — should be rejected
    await expect(
      service.executeWithApproval(
        {
          marketId: "market-abc",
          action: "halt",
          actor: "alice",        // same actor who initiated
          requestId: "req-001",
          approvalToken: rawToken,
        },
        "alice"                  // approver == initiator ← the bug
      )
    ).rejects.toThrow(/dual-control violation/i);
  });

  it("warns to the logger when self-approval is attempted", async () => {
    const { createHash } = await import("crypto");
    const rawToken = "another-token";
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");

    prisma.adminApprovalToken.findUnique.mockResolvedValue(
      makeApprovalRecord({ tokenHash, initiator: "bob" })
    );
    prisma.market.findUnique.mockResolvedValue({
      id: "market-abc",
      status: "ACTIVE",
    });

    await expect(
      service.executeWithApproval(
        {
          marketId: "market-abc",
          action: "halt",
          actor: "bob",
          requestId: "req-001",
          approvalToken: rawToken,
        },
        "bob"
      )
    ).rejects.toThrow(/dual-control violation/i);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("self-approval"),
      expect.objectContaining({
        initiator: "bob",
        approver: "bob",
      })
    );
  });

  it("succeeds when initiator and approver are different identities", async () => {
    const { createHash } = await import("crypto");
    const rawToken = "valid-two-actor-token";
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");

    prisma.adminApprovalToken.findUnique.mockResolvedValue(
      makeApprovalRecord({ tokenHash, initiator: "alice" })
    );
    prisma.market.findUnique.mockResolvedValue({
      id: "market-abc",
      status: "ACTIVE",
    });
    prisma.market.update.mockResolvedValue({
      id: "market-abc",
      status: "CANCELLED",
    });

    // bob (different identity) approves alice's initiation
    await expect(
      service.executeWithApproval(
        {
          marketId: "market-abc",
          action: "halt",
          actor: "alice",
          requestId: "req-001",
          approvalToken: rawToken,
        },
        "bob"                    // different approver ← correct
      )
    ).resolves.toMatchObject({
      action: "halt",
      marketId: "market-abc",
    });
  });

  it("rejects an already-consumed token", async () => {
    const { createHash } = await import("crypto");
    const rawToken = "reuse-token";
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");

    prisma.adminApprovalToken.findUnique.mockResolvedValue(
      makeApprovalRecord({ tokenHash, initiator: "alice", approvedBy: "bob" })
    );
    prisma.market.findUnique.mockResolvedValue({
      id: "market-abc",
      status: "ACTIVE",
    });

    await expect(
      service.executeWithApproval(
        {
          marketId: "market-abc",
          action: "halt",
          actor: "alice",
          requestId: "req-001",
          approvalToken: rawToken,
        },
        "charlie"
      )
    ).rejects.toThrow(/already been used/i);
  });

  it("rejects an expired token", async () => {
    const { createHash } = await import("crypto");
    const rawToken = "expired-token";
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");

    prisma.adminApprovalToken.findUnique.mockResolvedValue(
      makeApprovalRecord({
        tokenHash,
        initiator: "alice",
        expiresAt: new Date(Date.now() - 1000), // already expired
      })
    );
    prisma.market.findUnique.mockResolvedValue({
      id: "market-abc",
      status: "ACTIVE",
    });

    await expect(
      service.executeWithApproval(
        {
          marketId: "market-abc",
          action: "halt",
          actor: "alice",
          requestId: "req-001",
          approvalToken: rawToken,
        },
        "bob"
      )
    ).rejects.toThrow(/expired/i);
  });
});
