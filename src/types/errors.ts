// Error response format — re-exports the shared envelope (#793) so API
// consumers keep importing from `../types/errors.js` unchanged.

export type { ErrorEnvelope as ErrorResponse } from "../../packages/shared/src/errors.js";
