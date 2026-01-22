
// Custom error classes for Vatix Backend
// used throughout the application for consistent error handling


// Base class for application errors
 
export class AppError extends Error {
  statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    Error.captureStackTrace(this, this.constructor);
  }
}

// ValidationError is used when request validation fails
// Returns 400 Bad Request with field-specific error details
export class ValidationError extends AppError {
  fields?: Record<string, string>;

  constructor(message: string, fields?: Record<string, string>) {
    super(message, 400);
    this.fields = fields;
  }
}

// NotFoundError is used when a requested resource doesn't exist
// Returns 404 Not Found
export class NotFoundError extends AppError {
  constructor(message: string = "Resource not found") {
    super(message, 404);
  }
}

// UnauthorizedError is used when authentication or authorization fails
// Returns 401 Unauthorized
export class UnauthorizedError extends AppError {
  constructor(message: string = "Unauthorized") {
    super(message, 401);
  }
}

// ForbiddenError is used when a user is not authorized to access a resource
// Returns 403 Forbidden
export class ForbiddenError extends AppError {
     constructor(message = "Forbidden") {
       super(message, 403);
     }
   }