/**
 * Standardised error envelope returned by every API error response.
 *
 * Machine-readable: `code`   – stable snake_case identifier, safe to switch on.
 * Human-readable:  `message` – plain-English description, may change between releases.
 * Correlation:     `requestId` – ties the response to server logs.
 * Extra context:   `metadata`  – optional structured details (e.g. field-level errors).
 */
export interface ErrorEnvelope {
  /** Stable snake_case error code, e.g. "validation_error", "not_found". */
  code: string;
  /** Human-readable description of the error. */
  message: string;
  /** HTTP status code mirrored in the body for clients that parse JSON only. */
  statusCode: number;
  fields?: Record<string, string>;
  // Stack trace included in non-production environments only
  stack?: string;
}
