import { describe, expect, it } from 'vitest';

import {
  assertNever,
  type NormalizedEvent,
  type NormalizedEventType,
} from './types.js';

const sampleEvent = (type: NormalizedEventType): NormalizedEvent => {
  const base = {
    marketId: '0x' as const,
    blockNumber: 0n,
    transactionHash: '0x' as const,
    logIndex: 0,
  };

  switch (type) {
    case 'market_created':
      return {
        ...base,
        type: 'market_created',
        creator: '0x' as const,
        collateral: '0x' as const,
      };
    case 'collateral_deposited':
      return {
        ...base,
        type: 'collateral_deposited',
        depositor: '0x' as const,
        amount: 0n,
      };
    case 'resolution':
      return { ...base, type: 'resolution', outcome: 0 };
    default:
      return assertNever(type);
  }
};

// Compile-time guard: if a NormalizedEventType member lacks a union variant,
// this Record is missing a key and tsc fails the build.
const eventByType: Record<NormalizedEventType, NormalizedEvent> = {
  market_created: sampleEvent('market_created'),
  collateral_deposited: sampleEvent('collateral_deposited'),
  resolution: sampleEvent('resolution'),
};

describe('NormalizedEvent union', () => {
  it('keeps the discriminant list and union variants in sync', () => {
    const discriminants = Object.keys(eventByType).sort();
    const variants = Object.values(eventByType)
      .map((event) => event.type)
      .sort();

    expect(discriminants).toEqual(variants);
  });

  it('narrows exhaustively via assertNever', () => {
    for (const event of Object.values(eventByType)) {
      switch (event.type) {
        case 'market_created':
          expect(event.creator).toBeDefined();
          break;
        case 'collateral_deposited':
          expect(event.depositor).toBeDefined();
          break;
        case 'resolution':
          expect(event.outcome).toBeTypeOf('number');
          break;
        default:
          assertNever(event);
      }
    }
  });
});
