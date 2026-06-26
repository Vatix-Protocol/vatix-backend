import type { NormalizedTrade, NormalizedResolution, NormalizedCollateralDeposit } from "./types.js";
import type {
  PersistedTrade,
  PersistedResolution,
  PersistedCollateralDeposit,
  DuplicateEventLogger,
} from "./idempotency.js";
import { insertIfNew } from "./idempotency.js";
import { getPrismaClient } from "../../../src/services/prisma.js";
import type { ILogger } from "../../../packages/shared/src/logger.js";
import type { PrismaClient } from "../../../src/generated/prisma/client/index.js";

export type BatchRecord =
  | { kind: "trade"; data: PersistedTrade }
  | { kind: "resolution"; data: PersistedResolution }
  | { kind: "collateral_deposited"; data: PersistedCollateralDeposit };

export interface BatchWriteError {
  record: BatchRecord;
  error: string;
}

export interface BatchWriteResult {
  written: number;
  skipped: number;
  errors: BatchWriteError[];
}

export interface BatchWriter {
  write(records: BatchRecord[]): Promise<BatchWriteResult>;
  flush(): Promise<void>;
}

const CHAIN_RESOLUTION_SOURCE_PREFIX = "chain:market_resolved";
/** Stellar null account — used when the on-chain tuple omits oracle address. */
const UNKNOWN_OPERATOR_ADDRESS =
  "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

export class PrismaBatchWriter implements BatchWriter {
  private readonly prisma = getPrismaClient();

  constructor(private readonly logger?: ILogger) {}

  async write(records: BatchRecord[]): Promise<BatchWriteResult> {
    if (records.length === 0) {
      return { written: 0, skipped: 0, errors: [] };
    }

    let written = 0;
    let skipped = 0;
    const errors: BatchWriteError[] = [];
    const duplicateLogger: DuplicateEventLogger | undefined = this.logger
      ? {
          info: (message, meta) => this.logger!.info(message, meta),
        }
      : undefined;

    await this.prisma.$transaction(async (tx) => {
      for (const record of records) {
        try {
          const result = await insertIfNew(
            record.data,
            async (persisted) => this.persistRecord(tx, record, persisted),
            { logger: duplicateLogger }
          );

          if (result.status === "inserted") {
            written += 1;
          } else {
            skipped += 1;
          }
        } catch (error) {
          errors.push({
            record,
            error: error instanceof Error ? error.message : String(error),
          });
          this.logger?.warn("Failed to persist indexer batch record", {
            kind: record.kind,
            idempotencyKey: record.data.idempotencyKey,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    });

    return { written, skipped, errors };
  }

  async flush(): Promise<void> {
    // Single $transaction per write() — nothing buffered between batches.
  }

  private async persistRecord(
    tx: Omit<
      PrismaClient,
      "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends"
    >,
    record: BatchRecord,
    persisted: PersistedTrade | PersistedResolution | PersistedCollateralDeposit
  ): Promise<PersistedTrade | PersistedResolution | PersistedCollateralDeposit | null> {
    const existing = await tx.indexerProcessedEvent.findUnique({
      where: { idempotencyKey: persisted.idempotencyKey },
    });
    if (existing) {
      return null;
    }

    await tx.indexerProcessedEvent.create({
      data: {
        idempotencyKey: persisted.idempotencyKey,
        eventKind: record.kind,
        ledger: persisted.ledger,
      },
    });

    if (record.kind === "trade") {
      const trade = persisted as PersistedTrade;
      await tx.indexedTrade.create({
        data: {
          idempotencyKey: trade.idempotencyKey,
          eventId: trade.eventId,
          ledger: trade.ledger,
          marketId: trade.marketId,
          traderAddress: trade.traderAddress,
          counterpartyAddress: trade.counterpartyAddress,
          direction: trade.direction,
          outcome: trade.outcome,
          priceRaw: trade.priceRaw.toString(),
          quantityRaw: trade.quantityRaw.toString(),
          buyOrderId: trade.buyOrderId,
          sellOrderId: trade.sellOrderId,
        },
      });
      // TODO: update UserPosition shares/collateral when position events are parsed.
    } else if (record.kind === "resolution") {
      const resolution = persisted as PersistedResolution;
      await tx.resolutionCandidate.create({
        data: {
          marketId: resolution.marketId,
          proposedOutcome: resolution.outcome === "YES",
          source: `${CHAIN_RESOLUTION_SOURCE_PREFIX}:${resolution.contractId}`,
          status: "PROPOSED",
          operatorAddress:
            resolution.oracleAddress.trim() !== ""
              ? resolution.oracleAddress
              : UNKNOWN_OPERATOR_ADDRESS,
          idempotencyKey: resolution.idempotencyKey,
        },
      });
    } else {
      const deposit = persisted as PersistedCollateralDeposit;
      await (tx as any).collateralDeposit.create({
        data: {
          idempotencyKey: deposit.idempotencyKey,
          eventId: deposit.eventId,
          ledger: deposit.ledger,
          contractId: deposit.contractId,
          account: deposit.account,
          marketId: deposit.marketId,
          amountRaw: deposit.amountRaw.toString(),
        },
      });
    }

    return persisted;
  }
}

/** @deprecated Use PersistedTrade in BatchRecord after withIdempotencyKey(). */
export type { NormalizedTrade, NormalizedResolution, NormalizedCollateralDeposit };
