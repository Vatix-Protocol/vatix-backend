// Error response format

export interface ErrorResponse {
  error: string;
  code: string;
  requestId: string;
  statusCode: number;
  requestId?: string;
  fields?: Record<string, string>;
  stack?: string;
}
