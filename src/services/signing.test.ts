import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { SigningService } from "./signing";
import type { OrderData } from "../types";

describe("Order Receipt Signing Service", () => {
	let signingService: SigningService;
	const testKeypair = Keypair.random();
	const originalEnv = process.env.ORACLE_SECRET_KEY;

	beforeEach(() => {
		// Create new instance for each test
		signingService = new SigningService();

		// Set test secret key
		process.env.ORACLE_SECRET_KEY = testKeypair.secret();
		signingService.initialize();
	});

	afterEach(() => {
		// Restore original env
		if (originalEnv) {
			process.env.ORACLE_SECRET_KEY = originalEnv;
		} else {
			delete process.env.ORACLE_SECRET_KEY;
		}
		signingService.reset();
	});

	describe("initialize", () => {
		it("should throw error when ORACLE_SECRET_KEY is missing", () => {
			delete process.env.ORACLE_SECRET_KEY;
			const service = new SigningService();

			expect(() => service.initialize()).toThrow(
				"ORACLE_SECRET_KEY not found in environment variables",
			);
		});

		it("should throw error when ORACLE_SECRET_KEY is invalid", () => {
			process.env.ORACLE_SECRET_KEY = "invalid-secret-key";
			const service = new SigningService();

			expect(() => service.initialize()).toThrow(
				"Invalid ORACLE_SECRET_KEY format",
			);
		});

		it("should initialize successfully with valid secret key", () => {
			const service = new SigningService();
			expect(() => service.initialize()).not.toThrow();
		});
	});

	describe("signOrderReceipt", () => {
		it("should throw error if service not initialized", () => {
			const service = new SigningService();

			const order: OrderData = {
				orderId: "order-123",
				userAddress: "GABC123",
				side: "BUY",
				outcome: "YES",
				price: 0.5,
				quantity: 100,
				timestamp: Date.now(),
			};

			expect(() => service.signOrderReceipt(order)).toThrow(
				"Signing service not initialized",
			);
		});

		it("should generate valid signature for order", () => {
			const order: OrderData = {
				orderId: "order-456",
				userAddress: "GDEF456",
				side: "SELL",
				outcome: "NO",
				price: 0.6,
				quantity: 50,
				timestamp: 1234567890,
			};

			const receipt = signingService.signOrderReceipt(order);

			expect(receipt).toHaveProperty("orderData");
			expect(receipt).toHaveProperty("signature");
			expect(receipt).toHaveProperty("publicKey");
			expect(receipt.signature).toBeTruthy();
			expect(receipt.signature.length).toBeGreaterThan(0);
			expect(receipt.publicKey).toBe(testKeypair.publicKey());
		});

		it("should include all order data in receipt", () => {
			const order: OrderData = {
				orderId: "order-789",
				userAddress: "GHIJ789",
				side: "BUY",
				outcome: "YES",
				price: 0.75,
				quantity: 200,
				timestamp: 9876543210,
			};

			const receipt = signingService.signOrderReceipt(order);

			expect(receipt.orderData).toEqual(order);
		});
	});

	describe("verifyOrderReceipt", () => {
		it("should verify valid receipt successfully", () => {
			const order: OrderData = {
				orderId: "order-valid",
				userAddress: "GVALID123",
				side: "BUY",
				outcome: "YES",
				price: 0.5,
				quantity: 100,
				timestamp: Date.now(),
			};

			const receipt = signingService.signOrderReceipt(order);
			const result = signingService.verifyOrderReceipt(receipt);

			expect(result.isValid).toBe(true);
			expect(result.error).toBeUndefined();
		});

		it("should fail verification for tampered order data", () => {
			const order: OrderData = {
				orderId: "order-tamper",
				userAddress: "GTAMPER123",
				side: "BUY",
				outcome: "YES",
				price: 0.5,
				quantity: 100,
				timestamp: Date.now(),
			};

			const receipt = signingService.signOrderReceipt(order);

			// Tamper with price
			receipt.orderData.price = 0.8;

			const result = signingService.verifyOrderReceipt(receipt);

			expect(result.isValid).toBe(false);
			expect(result.error).toBeDefined();
		});

		it("should fail verification for tampered quantity", () => {
			const order: OrderData = {
				orderId: "order-quantity",
				userAddress: "GQUANT123",
				side: "SELL",
				outcome: "NO",
				price: 0.4,
				quantity: 50,
				timestamp: Date.now(),
			};

			const receipt = signingService.signOrderReceipt(order);

			// Tamper with quantity
			receipt.orderData.quantity = 500;

			const result = signingService.verifyOrderReceipt(receipt);

			expect(result.isValid).toBe(false);
		});

		it("should fail verification for tampered user address", () => {
			const order: OrderData = {
				orderId: "order-user",
				userAddress: "GUSER123",
				side: "BUY",
				outcome: "YES",
				price: 0.6,
				quantity: 75,
				timestamp: Date.now(),
			};

			const receipt = signingService.signOrderReceipt(order);

			// Tamper with user address
			receipt.orderData.userAddress = "GHACKER999";

			const result = signingService.verifyOrderReceipt(receipt);

			expect(result.isValid).toBe(false);
		});

		it("should fail verification for invalid signature format", () => {
			const order: OrderData = {
				orderId: "order-invalid-sig",
				userAddress: "GINVALID123",
				side: "BUY",
				outcome: "YES",
				price: 0.5,
				quantity: 100,
				timestamp: Date.now(),
			};

			const receipt = signingService.signOrderReceipt(order);

			// Replace with invalid signature
			receipt.signature = "invalid-signature-data";

			const result = signingService.verifyOrderReceipt(receipt);

			expect(result.isValid).toBe(false);
			expect(result.error).toBeDefined();
		});
	});

	describe("deterministic signing", () => {
		it("should produce same signature for identical orders", () => {
			const order: OrderData = {
				orderId: "order-deterministic",
				userAddress: "GDETERM123",
				side: "BUY",
				outcome: "YES",
				price: 0.5,
				quantity: 100,
				timestamp: 1234567890, // Fixed timestamp for determinism
			};

			const receipt1 = signingService.signOrderReceipt(order);
			const receipt2 = signingService.signOrderReceipt(order);

			expect(receipt1.signature).toBe(receipt2.signature);
		});

		it("should produce different signatures for different orders", () => {
			const order1: OrderData = {
				orderId: "order-1",
				userAddress: "GUSER1",
				side: "BUY",
				outcome: "YES",
				price: 0.5,
				quantity: 100,
				timestamp: 1234567890,
			};

			const order2: OrderData = {
				orderId: "order-2",
				userAddress: "GUSER2",
				side: "SELL",
				outcome: "NO",
				price: 0.6,
				quantity: 200,
				timestamp: 9876543210,
			};

			const receipt1 = signingService.signOrderReceipt(order1);
			const receipt2 = signingService.signOrderReceipt(order2);

			expect(receipt1.signature).not.toBe(receipt2.signature);
		});

		it("should produce different signatures if any field changes", () => {
			const baseOrder: OrderData = {
				orderId: "order-base",
				userAddress: "GBASE123",
				side: "BUY",
				outcome: "YES",
				price: 0.5,
				quantity: 100,
				timestamp: 1234567890,
			};

			const modifiedOrder: OrderData = {
				...baseOrder,
				price: 0.51, // Slight price change
			};

			const receipt1 = signingService.signOrderReceipt(baseOrder);
			const receipt2 = signingService.signOrderReceipt(modifiedOrder);

			expect(receipt1.signature).not.toBe(receipt2.signature);
		});
	});

	describe("getPublicKey", () => {
		it("should return the correct public key", () => {
			const publicKey = signingService.getPublicKey();

			expect(publicKey).toBe(testKeypair.publicKey());
			expect(publicKey).toMatch(/^G[A-Z0-9]{55}$/); // Stellar public key format
		});

		it("should throw error if service not initialized", () => {
			const service = new SigningService();

			expect(() => service.getPublicKey()).toThrow(
				"Signing service not initialized",
			);
		});

		it("should return consistent public key", () => {
			const publicKey1 = signingService.getPublicKey();
			const publicKey2 = signingService.getPublicKey();

			expect(publicKey1).toBe(publicKey2);
		});
	});

	describe("integration tests", () => {
		it("should handle complete sign-verify workflow", () => {
			// Create order
			const order: OrderData = {
				orderId: "order-integration",
				userAddress: "GINTEG123",
				side: "BUY",
				outcome: "YES",
				price: 0.55,
				quantity: 150,
				timestamp: Date.now(),
			};

			// Sign order
			const receipt = signingService.signOrderReceipt(order);

			// Verify receipt
			const result = signingService.verifyOrderReceipt(receipt);

			expect(result.isValid).toBe(true);
			expect(receipt.publicKey).toBe(signingService.getPublicKey());
		});

		it("should handle multiple orders in sequence", () => {
			const orders: OrderData[] = [
				{
					orderId: "order-seq-1",
					userAddress: "GSEQ1",
					side: "BUY",
					outcome: "YES",
					price: 0.4,
					quantity: 100,
					timestamp: Date.now(),
				},
				{
					orderId: "order-seq-2",
					userAddress: "GSEQ2",
					side: "SELL",
					outcome: "NO",
					price: 0.6,
					quantity: 200,
					timestamp: Date.now(),
				},
				{
					orderId: "order-seq-3",
					userAddress: "GSEQ3",
					side: "BUY",
					outcome: "YES",
					price: 0.5,
					quantity: 150,
					timestamp: Date.now(),
				},
			];

			const receipts = orders.map((order) =>
				signingService.signOrderReceipt(order),
			);

			// Verify all receipts
			receipts.forEach((receipt) => {
				const result = signingService.verifyOrderReceipt(receipt);
				expect(result.isValid).toBe(true);
			});

			// Ensure all signatures are unique
			const signatures = receipts.map((r) => r.signature);
			const uniqueSignatures = new Set(signatures);
			expect(uniqueSignatures.size).toBe(signatures.length);
		});
	});
});
