/**
 * Contract event vector sync (#1129).
 *
 * `apps/indexer/fixtures/contract-event-vectors.json` is the canonical,
 * checked-in record of every on-chain event the indexer claims to parse: the
 * topic discriminator the contract emits (Soroban `#[contractevent]` naming),
 * the payload shape, and the expected `Normalized*` output.
 * `docs/indexer-event-mapping.md` points contributors at it.
 *
 * The fixture is only useful if something fails when it drifts, so this test
 * drives every vector through the real parser:
 *
 *   1. Every event key in the fixture must have a parser under test — a new
 *      on-chain event added to the fixture without a parser fails here.
 *   2. Each vector's XDR (or, for vectors that only carry `decodedNative`, the
 *      equivalent XDR built from it) must parse to `expectedNormalized`.
 *   3. Each `malformedVectors` entry must be rejected with the expected error
 *      class, i.e. adversarial input never escapes as an uncaught throw.
 *
 * A parser or fixture change that alters the contract encoding (field rename,
 * scale change, topic rename) therefore breaks CI instead of silently
 * mis-indexing trades/collateral/resolutions.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";
import { parseTradeEvent } from "./tradeParser.js";
import { parseResolutionEvent } from "./resolutionParser.js";
import { parseMarketCreatedChainEvent } from "./marketCreatedParser.js";
import { parseCollateralDepositedEvent } from "./collateralDepositedParser.js";
import type { RawChainEvent } from "./types.js";

interface FixtureVector {
  label: string;
  note?: string;
  topicsXdr?: string[];
  valueXdr?: string;
  decodedNative?: unknown;
  expectedNormalized?: Record<string, unknown>;
}

interface FixtureMalformedVector {
  label: string;
  note?: string;
  topicsXdr?: string[];
  valueXdr?: string;
  decodedNative?: unknown;
  expectedError: string;
}

interface FixtureEvent {
  discriminator: { value: string; xdr?: string; topicIndex: number };
  payloadShape: string;
  fields: Record<string, string>;
  note?: string;
  vectors: FixtureVector[];
  malformedVectors?: FixtureMalformedVector[];
}

interface Fixture {
  $schema: string;
  description: string;
  events: Record<string, FixtureEvent>;
}

const fixture = JSON.parse(
  readFileSync(
    new URL("../fixtures/contract-event-vectors.json", import.meta.url),
    "utf8"
  )
) as Fixture;

const CONTRACT_ID = "CTESTCONTRACTID";

function symbolTopicXdr(symbol: string): string {
  return nativeToScVal(symbol, { type: "symbol" }).toXDR("base64");
}

function buildEvent(
  id: string,
  topicsXdr: string[],
  valueXdr: string
): RawChainEvent {
  return {
    id,
    ledger: 1,
    ledgerClosedAt: "2024-01-01T00:00:00Z",
    contractId: CONTRACT_ID,
    type: "contract",
    pagingToken: `token-${id}`,
    eventIndex: 0,
    valueXdr,
    topicsXdr,
  };
}

/**
 * Vectors for `collateral_deposited` document the decoded native tuple rather
 * than a checked-in XDR blob, so rebuild the ScvVec with the exact types the
 * contract emits: ScvString account, ScvU32 market_id, ScvI128 amount.
 */
function encodeCollateralDeposit(nativeTuple: unknown[]): string {
  const [account, marketId, amount] = nativeTuple as [string, number, string];
  return xdr.ScVal.scvVec([
    nativeToScVal(account, { type: "string" }),
    nativeToScVal(marketId, { type: "u32" }),
    nativeToScVal(BigInt(amount), { type: "i128" }),
  ]).toXDR("base64");
}

/** Legacy resolution tuple: ScvVec[ScvU32 market_id, ScvBool, ScvU64]. */
function encodeLegacyResolutionTuple(nativeTuple: unknown[]): string {
  const [marketId, outcome, resolvedAt] = nativeTuple as [
    number,
    boolean,
    string,
  ];
  return xdr.ScVal.scvVec([
    nativeToScVal(marketId, { type: "u32" }),
    nativeToScVal(outcome, { type: "bool" }),
    nativeToScVal(BigInt(resolvedAt), { type: "u64" }),
  ]).toXDR("base64");
}

function topicsFor(event: FixtureEvent, vector: FixtureVector): string[] {
  if (vector.topicsXdr) return vector.topicsXdr;
  return [event.discriminator.xdr ?? symbolTopicXdr(event.discriminator.value)];
}

function valueFor(eventKey: string, vector: FixtureVector): string {
  if (vector.valueXdr) return vector.valueXdr;
  const native = vector.decodedNative;
  if (eventKey === "collateral_deposited") {
    return encodeCollateralDeposit(native as unknown[]);
  }
  if (eventKey === "market_resolved") {
    return encodeLegacyResolutionTuple(native as unknown[]);
  }
  throw new Error(
    `Fixture vector "${vector.label}" has neither valueXdr nor a supported decodedNative shape`
  );
}

/**
 * Parses the given event key with the same parser the ingestion loop uses.
 */
function parseVector(eventKey: string, event: RawChainEvent) {
  switch (eventKey) {
    case "trade_executed":
      return parseTradeEvent(event, { nodeEnv: "test" }) as unknown as Record<
        string,
        unknown
      >;
    case "collateral_deposited":
      return parseCollateralDepositedEvent(event, {
        nodeEnv: "test",
      }) as unknown as Record<string, unknown>;
    case "market_resolved":
      return parseResolutionEvent(event, {
        nodeEnv: "test",
      }) as unknown as Record<string, unknown>;
    case "market_created":
      return parseMarketCreatedChainEvent(event) as unknown as Record<
        string,
        unknown
      >;
    default:
      throw new Error(`No parser is wired for fixture event "${eventKey}"`);
  }
}

const EVENT_KEYS = Object.keys(fixture.events);

describe("contract event vectors — fixture/parser sync (#1129)", () => {
  it("declares a known fixture schema version", () => {
    expect(fixture.$schema).toBe("vatix/indexer/event-fixtures/v1");
  });

  it("covers every documented contract event with a parser under test", () => {
    expect(EVENT_KEYS.sort()).toEqual([
      "collateral_deposited",
      "market_created",
      "market_resolved",
      "trade_executed",
    ]);
  });

  for (const eventKey of EVENT_KEYS) {
    const event = fixture.events[eventKey];

    describe(`${eventKey} (${event.payloadShape})`, () => {
      it("topic discriminator XDR encodes the documented event symbol", () => {
        const topicXdr =
          event.discriminator.xdr ?? symbolTopicXdr(event.discriminator.value);
        expect(scValToNative(xdr.ScVal.fromXDR(topicXdr, "base64"))).toBe(
          event.discriminator.value
        );
      });

      event.vectors.forEach((vector, index) => {
        it(`vector ${index + 1}: ${vector.label}`, () => {
          const parsed = parseVector(
            eventKey,
            buildEvent(
              `${eventKey}-${index + 1}`,
              topicsFor(event, vector),
              valueFor(eventKey, vector)
            )
          );

          // Fixture expectations may be partial (only the fields a vector is
          // asserting on), so compare the documented subset.
          for (const [field, expected] of Object.entries(
            vector.expectedNormalized ?? {}
          )) {
            expect(String(parsed[field]), `field "${field}"`).toBe(
              String(expected)
            );
          }
        });
      });

      for (const malformed of event.malformedVectors ?? []) {
        it(`rejects malformed vector: ${malformed.label}`, () => {
          // Malformed vectors either carry a raw XDR blob or the decoded
          // native tuple it was built from (same contract types as the vector
          // encoders above), never a valid expectation.
          const malformedValue =
            malformed.valueXdr ??
            (malformed.decodedNative !== undefined
              ? valueFor(eventKey, malformed)
              : "");
          let caught: unknown;
          try {
            parseVector(
              eventKey,
              buildEvent(
                `malformed-${eventKey}-${malformed.label}`,
                malformed.topicsXdr ?? topicsFor(event, malformed),
                malformedValue
              )
            );
          } catch (err) {
            caught = err;
          }

          expect(
            caught,
            "expected the parser to reject this vector"
          ).toBeDefined();
          expect((caught as Error).name).toBe(malformed.expectedError);
          // Stable error codes are part of the parser contract; every
          // rejection must carry one so alerting never parses message text.
          expect(
            (caught as { errorCode?: string }).errorCode,
            "rejection must carry a stable errorCode"
          ).toBeTruthy();
        });
      }

      it("documents every payload field it expects", () => {
        expect(Object.keys(event.fields).length).toBeGreaterThan(0);
      });
    });
  }
});
