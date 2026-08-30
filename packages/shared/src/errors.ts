// Standard API error envelope shared by the API and indexer (#793).
// See docs/error-handler.md for the canonical shape and examples.

export interface ErrorEnvelope {
  code: string;
  message: string;
  error: string;
  statusCode: number;
  requestId: string;
  fields?: Record<string, string>;
  stack?: string;
}

export interface CreateErrorEnvelopeInput {
  code: string;
  message: string;
  statusCode: number;
  requestId: string;
  fields?: Record<string, string>;
  stack?: string;
}

/** Builds an `ErrorEnvelope`, omitting optional fields that weren't supplied. */
export function createErrorEnvelope(
  input: CreateErrorEnvelopeInput
): ErrorEnvelope {
  const envelope: ErrorEnvelope = {
    code: input.code,
    message: input.message,
    error: input.message,
    statusCode: input.statusCode,
    requestId: input.requestId,
  };

  if (input.fields) {
    envelope.fields = input.fields;
  }

  if (input.stack) {
    envelope.stack = input.stack;
  }

  return envelope;
}
