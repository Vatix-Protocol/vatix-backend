import { Keypair } from "@stellar/stellar-sdk";
import { randomUUID } from "node:crypto";
import type {
  OrderData,
  SignedOrderReceipt,
  VerificationResult,
} from "../types";
import {
  SIGNING_DOMAINS,
  buildDomainSeparatedMessage,
  resolveSigningNetworkPassphrase,
} from "../../packages/shared/src/signingDomain.js";

/**
 * Signing service for creating and verifying cryptographic order receipts.
 * Uses Ed25519 signatures for order verification in the off-chain matching system.
 *
 * Signed messages are domain- and network-separated (#978): every message
 * embeds the `vatix.order-receipt.v1` domain tag and the active Stellar
 * network passphrase, so an order-receipt signature cannot be replayed as
 * an oracle-resolution signature and a testnet signature cannot be replayed
 * on mainnet.
 */
export class SigningService {
  private keypair: Keypair | null = null;
  private networkPassphrase: string | null = null;

  /**
   * Initialize the signing keypair from environment variable
   * Must be called before using any signing functions
   *
   * @throws {Error} If ORACLE_SECRET_KEY is not found or invalid
   */
  public initialize(): void {
    const secretKey = process.env.ORACLE_SECRET_KEY;

    if (!secretKey) {
      throw new Error(
        "ORACLE_SECRET_KEY not found in environment variables. " +
          "Please set it in your .env file."
      );
    }

    try {
      this.keypair = Keypair.fromSecret(secretKey);
    } catch (error) {
      throw new Error(
        `Invalid ORACLE_SECRET_KEY format. Must be a valid Stellar secret key. ` +
          `Error: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }

    // Resolve the network binding up front so misconfiguration fails at boot,
    // not on the first signature. Throws in production when
    // SOROBAN_NETWORK_PASSPHRASE is unset (no silent stub fallback).
    this.networkPassphrase = resolveSigningNetworkPassphrase();

    // Structured init log. The passphrase and public key are not secrets; the
    // secret key is never logged.
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "info",
        message: "Signing keypair initialized",
        component: "signing-service",
        correlationId: randomUUID(),
        domain: SIGNING_DOMAINS.ORDER_RECEIPT,
        networkPassphrase: this.networkPassphrase,
        publicKey: this.keypair.publicKey(),
      })
    );
  }

  /**
   * Ensure keypair is initialized before use
   * @throws {Error} If keypair hasn't been initialized
   */
  private ensureInitialized(): Keypair {
    if (!this.keypair) {
      throw new Error(
        "Signing service not initialized. Call initialize() first."
      );
    }
    return this.keypair;
  }

  /**
   * Create a deterministic message string from order data
   * Same order data will always produce the same message
   *
   * @param order - Order data to serialize
   * @returns Deterministic string representation
   */
  private createOrderMessage(order: OrderData): string {
    // Sort keys to ensure deterministic serialization
    const sortedOrder = {
      orderId: order.orderId,
      userAddress: order.userAddress,
      side: order.side,
      outcome: order.outcome,
      price: order.price,
      quantity: order.quantity,
      timestamp: order.timestamp,
    };

    // Domain- and network-separate the signed bytes (#978). Resolve lazily so
    // verifyOrderReceipt() also works before initialize() has been called;
    // still throws in production when the network passphrase is unset.
    const networkPassphrase =
      this.networkPassphrase ?? resolveSigningNetworkPassphrase();

    return buildDomainSeparatedMessage(
      SIGNING_DOMAINS.ORDER_RECEIPT,
      networkPassphrase,
      sortedOrder
    );
  }

  /**
   * Sign an order receipt with the service's private key
   * Creates a cryptographic signature proving the order was received
   *
   * @param order - Order data to sign
   * @returns Signed order receipt with signature and public key
   * @throws {Error} If service not initialized
   *
   * @example
   * ```typescript
   * const order = {
   *   orderId: 'order-123',
   *   userAddress: 'GABC...',
   *   side: 'BUY',
   *   outcome: 'YES',
   *   price: 0.5,
   *   quantity: 100,
   *   timestamp: Date.now()
   * };
   *
   * const receipt = signingService.signOrderReceipt(order);
   * ```
   */
  public signOrderReceipt(order: OrderData): SignedOrderReceipt {
    const kp = this.ensureInitialized();

    // Create deterministic message
    const message = this.createOrderMessage(order);
    const messageBuffer = Buffer.from(message, "utf8");

    // Sign the message using Stellar SDK
    const signatureBuffer = kp.sign(messageBuffer);
    const signature = signatureBuffer.toString("base64");

    return {
      orderData: order,
      signature,
      publicKey: kp.publicKey(),
    };
  }

  /**
   * Verify a signed order receipt's signature
   * Checks if the signature is valid and the data hasn't been tampered with
   *
   * @param receipt - Signed order receipt to verify
   * @returns Verification result with validity status
   *
   * @example
   * ```typescript
   * const receipt = signingService.signOrderReceipt(order);
   * const result = signingService.verifyOrderReceipt(receipt);
   *
   * if (result.isValid) {
   *   console.log('Receipt is valid!');
   * } else {
   *   console.log('Receipt is invalid:', result.error);
   * }
   * ```
   */
  public verifyOrderReceipt(receipt: SignedOrderReceipt): VerificationResult {
    try {
      // Recreate the message from order data
      const message = this.createOrderMessage(receipt.orderData);
      const messageBuffer = Buffer.from(message, "utf8");

      // Decode signature from base64
      const signatureBuffer = Buffer.from(receipt.signature, "base64");

      // Create keypair from public key for verification
      const publicKeypair = Keypair.fromPublicKey(receipt.publicKey);

      // Verify signature
      const isValid = publicKeypair.verify(messageBuffer, signatureBuffer);

      return {
        isValid,
        error: isValid ? undefined : "Signature verification failed",
      };
    } catch (error) {
      return {
        isValid: false,
        error:
          error instanceof Error ? error.message : "Unknown verification error",
      };
    }
  }

  /**
   * Get the service's public key for user verification
   * Users can use this to independently verify their receipts
   *
   * @returns Public key string (Stellar format)
   * @throws {Error} If service not initialized
   *
   * @example
   * ```typescript
   * const publicKey = signingService.getPublicKey();
   * console.log('Service public key:', publicKey);
   * ```
   */
  public getPublicKey(): string {
    const kp = this.ensureInitialized();
    return kp.publicKey();
  }

  /**
   * Reset the keypair (useful for testing)
   * Not intended for production use
   */
  public reset(): void {
    this.keypair = null;
    this.networkPassphrase = null;
  }
}

// Export singleton instance
export const signingService = new SigningService();
