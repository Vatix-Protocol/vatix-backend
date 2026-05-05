/**
 * Standardised error envelope returned by every API error response.
 *
 * Machine-readable: `code`   – stable snake_case identifier, safe to switch on.
 * Human-readable:  `message` – plain-English description, may change between releases.
 * Correlation:     `requestId` – ties the response to server logs.
 * Extra context:   `metadata`  – optional structured details (e.g. field-level errors).
 */
export interface ErrorEnvelope {
  code: string;
  message: string;
  statusCode: number;
  requestId?: string;
  fields?: Record<string, string>;
  stack?: string;
}
