// Public surface of the API middleware layer.
// Consumers should import guards/helpers from here rather than deep paths.
export { requireAdmin } from './adminGuard.js';
export { errorHandler } from './errorHandler.js';
export {
  sendSuccess,
  sendError,
  sendCreated,
  sendNoContent,
} from './responses.js';
export { requestId } from './requestId.js';

// Non-middleware re-exports kept for backwards compatibility: the matching
// engine's OrderBook and the Stellar auth helpers are imported from this
// barrel by existing consumers, so they remain part of the surface here.
export { OrderBook } from '../../matching/orderbook.js';
export { buildSignableMessage, verifyStellarSignature } from './stellarAuth.js';
