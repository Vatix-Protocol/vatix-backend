// Error response format

export interface ErrorResponse {
  error: string;
  requestId: string;
  statusCode: number;
  fields?: Record<string, string>;
  // Stack trace included in non-production environments only
  stack?: string;
}
