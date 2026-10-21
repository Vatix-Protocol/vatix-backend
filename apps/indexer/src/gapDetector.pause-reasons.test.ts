import { describe, it, expect, vi } from 'vitest';
import {
  runBackfill,
  type GapBackfillPauseReason,
  type BackfillResult,
} from './gapDetector.js';
import { BatchWriteError } from './batchWriterError.js';
import type { EventFetcher } from './eventFetcher.js';
import type { BatchWriter } from './batchWriter.js';
import type { InternalIndexerMetricsService } from './metrics.js';

function makeFetcher(overrides: Partial<EventFetcher> = {}): EventFetcher {
  return {
    fetchEvents: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as EventFetcher;
}

function makeWriter(overrides: Partial<BatchWriter> = {}): BatchWriter {
  return {
    writeBatch: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as BatchWriter;
}

function makeMetrics(
  overrides: Partial<InternalIndexerMetricsService> = {},
): InternalIndexerMetricsService {
  return {
    recordGap: vi.fn(),
    recordBackfill: vi.fn(),
    ...overrides,
  } as unknown as InternalIndexerMetricsService;
}

function expectCorrelationId(result: BackfillResult): void {
  expect(typeof result.correlationId).toBe('string');
  expect(result.correlationId.length).toBeGreaterThan(0);
}

describe('runBackfill pause reasons', () => {
  it('returns pausedReason "threshold" when the gap meets gapPauseThreshold', async () => {
    const result = await runBackfill({
      fetcher: makeFetcher(),
      writer: makeWriter(),
      metrics: makeMetrics(),
      gap: 100,
      gapPauseThreshold: 100,
      backfillEnabled: true,
    });

    expect(result.paused).toBe(true);
    expect(result.pausedReason).toBe<GapBackfillPauseReason>('threshold');
    expectCorrelationId(result);
  });

  it('returns pausedReason "disabled" when backfillEnabled is false', async () => {
    const result = await runBackfill({
      fetcher: makeFetcher(),
      writer: makeWriter(),
      metrics: makeMetrics(),
      gap: 1,
      gapPauseThreshold: 100,
      backfillEnabled: false,
    });

    expect(result.paused).toBe(true);
    expect(result.pausedReason).toBe<GapBackfillPauseReason>('disabled');
    expectCorrelationId(result);
  });

  it('returns pausedReason "in_progress" when a concurrent run is already active', async () => {
    const result = await runBackfill({
      fetcher: makeFetcher(),
      writer: makeWriter(),
      metrics: makeMetrics(),
      gap: 1,
      gapPauseThreshold: 100,
      backfillEnabled: true,
      isBackfillInProgress: () => true,
    });

    expect(result.paused).toBe(true);
    expect(result.pausedReason).toBe<GapBackfillPauseReason>('in_progress');
    expectCorrelationId(result);
  });

  it('returns pausedReason "dependency_unavailable" when the writer throws a BatchWriteError', async () => {
    const writer = makeWriter({
      writeBatch: vi
        .fn()
        .mockRejectedValue(new BatchWriteError('writer unavailable')),
    });

    const result = await runBackfill({
      fetcher: makeFetcher(),
      writer,
      metrics: makeMetrics(),
      gap: 1,
      gapPauseThreshold: 100,
      backfillEnabled: true,
    });

    expect(result.paused).toBe(true);
    expect(result.pausedReason).toBe<GapBackfillPauseReason>(
      'dependency_unavailable',
    );
    expectCorrelationId(result);
  });

  it('omits pausedReason and still carries a correlationId on a completed run', async () => {
    const result = await runBackfill({
      fetcher: makeFetcher(),
      writer: makeWriter(),
      metrics: makeMetrics(),
      gap: 1,
      gapPauseThreshold: 100,
      backfillEnabled: true,
    });

    expect(result.paused).toBe(false);
    expect(result.pausedReason).toBeUndefined();
    expectCorrelationId(result);
  });
});
