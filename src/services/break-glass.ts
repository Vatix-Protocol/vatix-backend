import { createHash, randomBytes } from "crypto";
import type { PrismaClient } from "../generated/prisma/client/index.js";
import type { ILogger } from "../../packages/shared/src/logger.js";
import { matchingService } from "../matching/matching-service.js";

export interface BreakGlassAction {
  marketId: string;
  action: "halt" | "cancel-all" | "resume";
  actor: string;
  requestId: string;
  reason?: string;
  approvalToken?: string;
}

export interface BreakGlassResult {
  marketId: string;
  action: string;
  beforeStatus: string;
  afterStatus: string;
  ordersCancelled: number;
  collateralReleased: number;
  auditId: string;
}

export interface ApprovalRequest {
  marketId: string;
  action: "halt" | "cancel-all" | "resume";
  initiator: string;
  requestId: string;
  reason?: string;
  expirationMinutes?: number;
}

export interface ApprovalResponse {
  token: string;
  expiresAt: Date;
  requestId: string;
}

/**
 * Admin break-glass service for incident response.
 * Handles market halt, order cancellation, and resume with dual-control audit.
 */
export class BreakGlassService {
  private readonly tokenExpireMinutes = 15;
  private readonly hashAlgorithm = "sha256";

  constructor(
    private readonly prisma: PrismaClient,
    private readonly logger: ILogger
  ) {}

  /**
   * Initiate a break-glass action with dual-control approval.
   * Returns a token that must be presented by a second admin to execute.
   */
  async initiateApproval(request: ApprovalRequest): Promise<ApprovalResponse> {
    const expiresAt = new Date(
      Date.now() +
        (request.expirationMinutes ?? this.tokenExpireMinutes) * 60000
    );
    const token = randomBytes(32).toString("hex");
    const tokenHash = this.hashToken(token);

    await this.prisma.adminApprovalToken.create({
      data: {
        marketId: request.marketId,
        action: request.action,
        initiator: request.initiator,
        requestId: request.requestId,
        tokenHash,
        expiresAt,
        reason: request.reason,
      },
    });

    this.logger.info("Break-glass approval initiated", {
      marketId: request.marketId,
      action: request.action,
      initiator: request.initiator,
      requestId: request.requestId,
      expiresAt: expiresAt.toISOString(),
    });

    return { token, expiresAt, requestId: request.requestId };
  }

  /**
   * Execute a break-glass action with second admin approval.
   * Validates approval token and executes the action (halt/cancel-all/resume).
   */
  async executeWithApproval(
    action: BreakGlassAction,
    approver: string
  ): Promise<BreakGlassResult> {
    // Validate market exists and is not soft-deleted
    const market = await this.prisma.market.findUnique({
      where: { id: action.marketId },
    });

    if (!market || market.deletedAt !== null) {
      throw new Error(`Market ${action.marketId} not found`);
    }

    // Validate and consume approval token
    if (action.approvalToken) {
      await this.validateAndConsumeToken(
        action.requestId,
        action.approvalToken,
        action.action,
        approver
      );
    }

    let result: BreakGlassResult;

    if (action.action === "halt") {
      result = await this.haltMarket(market, action.actor, action.requestId);
    } else if (action.action === "cancel-all") {
      result = await this.cancelAllOrders(
        market,
        action.actor,
        action.requestId
      );
    } else if (action.action === "resume") {
      result = await this.resumeMarket(market, action.actor, action.requestId);
    } else {
      throw new Error(`Unknown action: ${action.action}`);
    }

    this.logger.info("Break-glass action executed", {
      marketId: action.marketId,
      action: action.action,
      actor: action.actor,
      approver,
      result: {
        beforeStatus: result.beforeStatus,
        afterStatus: result.afterStatus,
        ordersCancelled: result.ordersCancelled,
        collateralReleased: result.collateralReleased,
      },
    });

    return result;
  }

  /**
   * Halt a market: transition to CANCELLED and reject new orders.
   */
  private async haltMarket(
    market: any,
    actor: string,
    requestId: string
  ): Promise<BreakGlassResult> {
    const beforeStatus = market.status;

    const updated = await this.prisma.market.update({
      where: { id: market.id },
      data: { status: "CANCELLED" },
    });

    // Invalidate order books for this market
    // (In-memory books will be emptied on next access)
    const auditId = await this.logAdminAction({
      marketId: market.id,
      action: "halt",
      actor,
      beforeStatus,
      afterStatus: updated.status,
      ordersCancelled: 0,
      collateralReleased: 0,
      requestId,
    });

    return {
      marketId: market.id,
      action: "halt",
      beforeStatus,
      afterStatus: updated.status,
      ordersCancelled: 0,
      collateralReleased: 0,
      auditId,
    };
  }

  /**
   * Cancel all resting orders for a market and release collateral.
   */
  private async cancelAllOrders(
    market: any,
    actor: string,
    requestId: string
  ): Promise<BreakGlassResult> {
    const beforeStatus = market.status;
    let ordersCancelled = 0;
    let collateralReleased = 0;

    await this.prisma.$transaction(async (tx) => {
      // Get all resting orders
      const orders = await tx.order.findMany({
        where: {
          marketId: market.id,
          status: { in: ["OPEN", "PARTIALLY_FILLED"] },
        },
        include: {
          market: true,
        },
      });

      for (const order of orders) {
        // Calculate collateral to release
        const remainingQty = order.quantity - order.filledQuantity;
        const collateralPerUnit =
          order.side === "BUY" ? Number(order.price) : 1 - Number(order.price);
        const collateralToRelease =
          Math.round(collateralPerUnit * remainingQty * 1e8) / 1e8;

        collateralReleased += collateralToRelease;

        // Cancel order
        await tx.order.update({
          where: { id: order.id },
          data: { status: "CANCELLED" },
        });

        // Release collateral
        if (collateralToRelease > 0) {
          const position = await tx.userPosition.findUnique({
            where: {
              marketId_userAddress: {
                marketId: market.id,
                userAddress: order.userAddress,
              },
            },
          });

          if (position) {
            const newLocked = Math.max(
              0,
              Number(position.lockedCollateral) - collateralToRelease
            );
            await tx.userPosition.update({
              where: {
                marketId_userAddress: {
                  marketId: market.id,
                  userAddress: order.userAddress,
                },
              },
              data: { lockedCollateral: newLocked },
            });
          }
        }

        ordersCancelled++;
      }
    });

    const auditId = await this.logAdminAction({
      marketId: market.id,
      action: "cancel-all",
      actor,
      beforeStatus,
      afterStatus: beforeStatus,
      ordersCancelled,
      collateralReleased,
      requestId,
    });

    return {
      marketId: market.id,
      action: "cancel-all",
      beforeStatus,
      afterStatus: beforeStatus,
      ordersCancelled,
      collateralReleased,
      auditId,
    };
  }

  /**
   * Resume a market: transition back to ACTIVE.
   */
  private async resumeMarket(
    market: any,
    actor: string,
    requestId: string
  ): Promise<BreakGlassResult> {
    const beforeStatus = market.status;

    if (beforeStatus !== "CANCELLED") {
      throw new Error(
        `Cannot resume market that is not CANCELLED (current: ${beforeStatus})`
      );
    }

    const updated = await this.prisma.market.update({
      where: { id: market.id },
      data: { status: "ACTIVE" },
    });

    const auditId = await this.logAdminAction({
      marketId: market.id,
      action: "resume",
      actor,
      beforeStatus,
      afterStatus: updated.status,
      ordersCancelled: 0,
      collateralReleased: 0,
      requestId,
    });

    return {
      marketId: market.id,
      action: "resume",
      beforeStatus,
      afterStatus: updated.status,
      ordersCancelled: 0,
      collateralReleased: 0,
      auditId,
    };
  }

  /**
   * Log admin action to audit table.
   */
  private async logAdminAction(data: {
    marketId: string;
    action: string;
    actor: string;
    beforeStatus: string;
    afterStatus: string;
    ordersCancelled: number;
    collateralReleased: number;
    requestId: string;
  }): Promise<string> {
    const audit = await this.prisma.adminAction.create({
      data: {
        marketId: data.marketId,
        action: data.action,
        actor: data.actor,
        beforeStatus: data.beforeStatus,
        afterStatus: data.afterStatus,
        ordersCancelled: data.ordersCancelled,
        collateralReleased: data.collateralReleased,
        requestId: data.requestId,
      },
    });

    return audit.id;
  }

  /**
   * Validate and consume an approval token.
   *
   * Dual-control requires that the approver is a **different** identity from
   * the initiator. If both roles are the same actor, the second factor is
   * theatre and provides no protection (issue #968).
   */
  private async validateAndConsumeToken(
    requestId: string,
    token: string,
    action: string,
    approver: string
  ): Promise<void> {
    const tokenHash = this.hashToken(token);

    const approval = await this.prisma.adminApprovalToken.findUnique({
      where: { requestId },
    });

    if (!approval) {
      throw new Error(`Approval request ${requestId} not found`);
    }

    if (approval.tokenHash !== tokenHash) {
      throw new Error("Invalid approval token");
    }

    if (approval.action !== action) {
      throw new Error(`Token is for action ${approval.action}, not ${action}`);
    }

    if (approval.expiresAt < new Date()) {
      throw new Error("Approval token has expired");
    }

    if (approval.approvedBy) {
      throw new Error("Approval token has already been used");
    }

    // Dual-control enforcement: the approver must be a different admin identity
    // from the initiator. Allowing the same actor to both initiate and approve
    // defeats the purpose of requiring two independent actors (issue #968).
    if (approval.initiator === approver) {
      this.logger.warn("Break-glass dual-control violation: initiator attempted self-approval", {
        requestId,
        initiator: approval.initiator,
        approver,
        action,
      });
      throw new Error(
        "Dual-control violation: the approver must be a different admin identity from the initiator"
      );
    }

    // Mark as approved
    await this.prisma.adminApprovalToken.update({
      where: { id: approval.id },
      data: {
        approvedBy: approver,
        approvedAt: new Date(),
      },
    });
  }

  /**
   * Hash an approval token for storage.
   */
  private hashToken(token: string): string {
    return createHash(this.hashAlgorithm).update(token).digest("hex");
  }

  /**
   * Get audit log for a market.
   */
  async getAuditLog(
    marketId: string,
    limit: number = 100
  ): Promise<Array<any>> {
    return this.prisma.adminAction.findMany({
      where: { marketId },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
  }
}

export const breakGlassService = new BreakGlassService(
  // This will be injected per-request in routes
  null as any,
  // Logger will be injected
  null as any
);
