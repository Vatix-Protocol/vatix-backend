import { readFileSync } from "fs";
import { describe, it, expect, afterAll } from "vitest";
import {
  getTestPrismaClient,
  disconnectTestPrisma,
} from "./helpers/test-database.js";

const schema = readFileSync("prisma/schema.prisma", "utf8");
const modelNames = Array.from(schema.matchAll(/^model\s+(\w+)\s+\{/gm)).map(
  ([, name]) => name
);

describe("Prisma Schema", () => {
  afterAll(async () => {
    await disconnectTestPrisma();
  });

  it("should instantiate the Prisma client without throwing", () => {
    expect(() => getTestPrismaClient()).not.toThrow();
  });

  it("should expose required model delegates on the client", () => {
    const prisma = getTestPrismaClient();

    expect(prisma.market).toBeDefined();
    expect(prisma.order).toBeDefined();
    expect(prisma.trade).toBeDefined();
    expect(prisma.userPosition).toBeDefined();
    expect(prisma.position).toBeDefined();
    expect(prisma.indexerCursor).toBeDefined();
    expect(prisma.indexerProcessedEvent).toBeDefined();
    expect(prisma.indexedTrade).toBeDefined();
    expect(prisma.trade).toBeDefined();
    expect(prisma.collateralDeposit).toBeDefined();
  });

  it("should define the expected schema models", () => {
    expect(modelNames).toEqual([
      "Market",
      "Order",
      "OracleReport",
      "UserPosition",
      "ResolutionCandidate",
      "Resolution",
      "Position",
      "IndexerCursor",
      "IndexerProcessedEvent",
      "Trade",
      "IndexedTrade",
      "OracleSourceAlias",
      "CollateralDeposit",
    ]);
    expect(modelNames).toHaveLength(13);
  });
});
