// Error response format

export interface ErrorResponse {
  error: string;
  code: string;
  message: string;
  requestId: string;
  statusCode: number;
  fields?: Record<string, string>;
}
