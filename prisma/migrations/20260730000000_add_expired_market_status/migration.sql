-- Add a distinct terminal status for markets that expire naturally, so the
-- expiry worker no longer records them as operator CANCELLED (#1478).
ALTER TYPE "MarketStatus" ADD VALUE IF NOT EXISTS 'EXPIRED';
