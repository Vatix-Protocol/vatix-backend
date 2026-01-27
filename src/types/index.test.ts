import { describe, it, expectTypeOf } from "vitest";
import {
  // Re-exported Prisma types
  Market,
  Order,
  UserPosition,
  MarketStatus,
  OrderSide,
  OrderStatus,
  Outcome,
  Prisma,
  // Additional types
  OrderReceipt,
  OrderBookLevel,
  OrderBook,
  PositionWithPayout,
  MarketWithStats,
  ApiResponse,
  PaginationParams,
  PaginatedResponse,
} from "./index";

describe("Type Definitions", () => {
  describe("Prisma Type Re-exports", () => {
    it("should export Market type with expected properties", () => {
      expectTypeOf<Market>().toHaveProperty("id");
      expectTypeOf<Market>().toHaveProperty("question");
      expectTypeOf<Market>().toHaveProperty("endTime");
      expectTypeOf<Market>().toHaveProperty("resolutionTime");
      expectTypeOf<Market>().toHaveProperty("oracleAddress");
      expectTypeOf<Market>().toHaveProperty("status");
      expectTypeOf<Market>().toHaveProperty("outcome");
      expectTypeOf<Market>().toHaveProperty("createdAt");
      expectTypeOf<Market>().toHaveProperty("updatedAt");
    });

    it("should export Order type with expected properties", () => {
      expectTypeOf<Order>().toHaveProperty("id");
      expectTypeOf<Order>().toHaveProperty("marketId");
      expectTypeOf<Order>().toHaveProperty("outcome");
      expectTypeOf<Order>().toHaveProperty("price");
      expectTypeOf<Order>().toHaveProperty("quantity");
      expectTypeOf<Order>().toHaveProperty("buyerAddress");
      expectTypeOf<Order>().toHaveProperty("sellerAddress");
      expectTypeOf<Order>().toHaveProperty("buyOrderId");
      expectTypeOf<Order>().toHaveProperty("sellOrderId");
      expectTypeOf<Order>().toHaveProperty("timestamp");
    });

    it("should export UserPosition type with expected properties", () => {
      expectTypeOf<UserPosition>().toHaveProperty("id");
      expectTypeOf<UserPosition>().toHaveProperty("marketId");
      expectTypeOf<UserPosition>().toHaveProperty("userAddress");
      expectTypeOf<UserPosition>().toHaveProperty("yesShares");
      expectTypeOf<UserPosition>().toHaveProperty("noShares");
      expectTypeOf<UserPosition>().toHaveProperty("lockedCollateral");
      expectTypeOf<UserPosition>().toHaveProperty("isSettled");
      expectTypeOf<UserPosition>().toHaveProperty("updatedAt");
    });

    it("should export MarketStatus enum", () => {
      expectTypeOf<MarketStatus>().toBeString();
      expectTypeOf<"ACTIVE">().toMatchTypeOf<MarketStatus>();
      expectTypeOf<"RESOLVED">().toMatchTypeOf<MarketStatus>();
      expectTypeOf<"CANCELLED">().toMatchTypeOf<MarketStatus>();
    });

    it("should export OrderSide enum", () => {
      expectTypeOf<OrderSide>().toBeString();
      expectTypeOf<"BUY">().toMatchTypeOf<OrderSide>();
      expectTypeOf<"SELL">().toMatchTypeOf<OrderSide>();
    });

    it("should export OrderStatus enum", () => {
      expectTypeOf<OrderStatus>().toBeString();
      expectTypeOf<"OPEN">().toMatchTypeOf<OrderStatus>();
      expectTypeOf<"FILLED">().toMatchTypeOf<OrderStatus>();
      expectTypeOf<"CANCELLED">().toMatchTypeOf<OrderStatus>();
      expectTypeOf<"PARTIALLY_FILLED">().toMatchTypeOf<OrderStatus>();
    });

    it("should export Outcome enum", () => {
      expectTypeOf<Outcome>().toBeString();
      expectTypeOf<"YES">().toMatchTypeOf<Outcome>();
      expectTypeOf<"NO">().toMatchTypeOf<Outcome>();
    });

    it("should export Prisma namespace", () => {
      expectTypeOf<typeof Prisma>().toBeObject();
    });
  });

  describe("OrderReceipt Type", () => {
    it("should have all Order properties plus signature and timestamp", () => {
      expectTypeOf<OrderReceipt>().toHaveProperty("id");
      expectTypeOf<OrderReceipt>().toHaveProperty("marketId");
      expectTypeOf<OrderReceipt>().toHaveProperty("buyerAddress");
      expectTypeOf<OrderReceipt>().toHaveProperty("sellerAddress");
      expectTypeOf<OrderReceipt>().toHaveProperty("outcome");
      expectTypeOf<OrderReceipt>().toHaveProperty("price");
      expectTypeOf<OrderReceipt>().toHaveProperty("quantity");
      expectTypeOf<OrderReceipt>().toHaveProperty("signature");
      expectTypeOf<OrderReceipt>().toHaveProperty("timestamp");
    });

    it("should have correct types for additional fields", () => {
      expectTypeOf<OrderReceipt["signature"]>().toBeString();
      expectTypeOf<OrderReceipt["timestamp"]>().toBeNumber();
    });
  });

  describe("OrderBookLevel Type", () => {
    it("should have expected properties", () => {
      expectTypeOf<OrderBookLevel>().toHaveProperty("price");
      expectTypeOf<OrderBookLevel>().toHaveProperty("totalQuantity");
      expectTypeOf<OrderBookLevel>().toHaveProperty("orderCount");
    });

    it("should have correct types", () => {
      expectTypeOf<OrderBookLevel["price"]>().toBeNumber();
      expectTypeOf<OrderBookLevel["totalQuantity"]>().toBeNumber();
      expectTypeOf<OrderBookLevel["orderCount"]>().toBeNumber();
    });
  });

  describe("OrderBook Type", () => {
    it("should have expected properties", () => {
      expectTypeOf<OrderBook>().toHaveProperty("marketId");
      expectTypeOf<OrderBook>().toHaveProperty("outcome");
      expectTypeOf<OrderBook>().toHaveProperty("bids");
      expectTypeOf<OrderBook>().toHaveProperty("asks");
      expectTypeOf<OrderBook>().toHaveProperty("lastUpdated");
    });

    it("should have correct types", () => {
      expectTypeOf<OrderBook["marketId"]>().toBeString();
      expectTypeOf<OrderBook["outcome"]>().toMatchTypeOf<Outcome>();
      expectTypeOf<OrderBook["bids"]>().toMatchTypeOf<OrderBookLevel[]>();
      expectTypeOf<OrderBook["asks"]>().toMatchTypeOf<OrderBookLevel[]>();
      expectTypeOf<OrderBook["lastUpdated"]>().toBeNumber();
    });
  });

  describe("PositionWithPayout Type", () => {
    it("should have all UserPosition properties plus payout fields", () => {
      expectTypeOf<PositionWithPayout>().toHaveProperty("id");
      expectTypeOf<PositionWithPayout>().toHaveProperty("marketId");
      expectTypeOf<PositionWithPayout>().toHaveProperty("userAddress");
      expectTypeOf<PositionWithPayout>().toHaveProperty("yesShares");
      expectTypeOf<PositionWithPayout>().toHaveProperty("noShares");
      expectTypeOf<PositionWithPayout>().toHaveProperty("lockedCollateral");
      expectTypeOf<PositionWithPayout>().toHaveProperty("potentialPayoutIfYes");
      expectTypeOf<PositionWithPayout>().toHaveProperty("potentialPayoutIfNo");
      expectTypeOf<PositionWithPayout>().toHaveProperty("netPosition");
    });

    it("should have correct types for calculated fields", () => {
      expectTypeOf<PositionWithPayout["potentialPayoutIfYes"]>().toBeNumber();
      expectTypeOf<PositionWithPayout["potentialPayoutIfNo"]>().toBeNumber();
      expectTypeOf<PositionWithPayout["netPosition"]>().toBeNumber();
    });
  });

  describe("MarketWithStats Type", () => {
    it("should have all Market properties plus stats fields", () => {
      expectTypeOf<MarketWithStats>().toHaveProperty("id");
      expectTypeOf<MarketWithStats>().toHaveProperty("question");
      expectTypeOf<MarketWithStats>().toHaveProperty("endTime");
      expectTypeOf<MarketWithStats>().toHaveProperty("status");
      expectTypeOf<MarketWithStats>().toHaveProperty("totalVolume");
      expectTypeOf<MarketWithStats>().toHaveProperty("openOrders");
      expectTypeOf<MarketWithStats>().toHaveProperty("uniqueTraders");
    });

    it("should have correct types for calculated fields", () => {
      expectTypeOf<MarketWithStats["totalVolume"]>().toBeNumber();
      expectTypeOf<MarketWithStats["openOrders"]>().toBeNumber();
      expectTypeOf<MarketWithStats["uniqueTraders"]>().toBeNumber();
    });
  });

  describe("ApiResponse Generic Type", () => {
    it("should have expected properties", () => {
      expectTypeOf<ApiResponse<unknown>>().toHaveProperty("success");
      expectTypeOf<ApiResponse<unknown>>().toHaveProperty("data");
      expectTypeOf<ApiResponse<unknown>>().toHaveProperty("error");
      expectTypeOf<ApiResponse<unknown>>().toHaveProperty("timestamp");
    });

    it("should have correct types", () => {
      expectTypeOf<ApiResponse<unknown>["success"]>().toBeBoolean();
      expectTypeOf<ApiResponse<unknown>["timestamp"]>().toBeString();
    });

    it("should work with generic types correctly", () => {
      type StringResponse = ApiResponse<string>;
      expectTypeOf<StringResponse["data"]>().toMatchTypeOf<
        string | undefined
      >();

      type MarketResponse = ApiResponse<Market>;
      expectTypeOf<MarketResponse["data"]>().toMatchTypeOf<
        Market | undefined
      >();
    });
  });

  describe("PaginationParams Type", () => {
    it("should have expected properties", () => {
      expectTypeOf<PaginationParams>().toHaveProperty("page");
      expectTypeOf<PaginationParams>().toHaveProperty("limit");
      expectTypeOf<PaginationParams>().toHaveProperty("sortBy");
      expectTypeOf<PaginationParams>().toHaveProperty("sortOrder");
    });

    it("should have correct types", () => {
      expectTypeOf<PaginationParams["page"]>().toBeNumber();
      expectTypeOf<PaginationParams["limit"]>().toBeNumber();
      expectTypeOf<PaginationParams["sortBy"]>().toMatchTypeOf<
        string | undefined
      >();
      expectTypeOf<PaginationParams["sortOrder"]>().toMatchTypeOf<
        "asc" | "desc" | undefined
      >();
    });
  });

  describe("PaginatedResponse Generic Type", () => {
    it("should have expected properties", () => {
      expectTypeOf<PaginatedResponse<unknown>>().toHaveProperty("items");
      expectTypeOf<PaginatedResponse<unknown>>().toHaveProperty("total");
      expectTypeOf<PaginatedResponse<unknown>>().toHaveProperty("page");
      expectTypeOf<PaginatedResponse<unknown>>().toHaveProperty("limit");
      expectTypeOf<PaginatedResponse<unknown>>().toHaveProperty("totalPages");
    });

    it("should have correct types", () => {
      expectTypeOf<PaginatedResponse<unknown>["total"]>().toBeNumber();
      expectTypeOf<PaginatedResponse<unknown>["page"]>().toBeNumber();
      expectTypeOf<PaginatedResponse<unknown>["limit"]>().toBeNumber();
      expectTypeOf<PaginatedResponse<unknown>["totalPages"]>().toBeNumber();
    });

    it("should work with generic types correctly", () => {
      type MarketList = PaginatedResponse<Market>;
      expectTypeOf<MarketList["items"]>().toMatchTypeOf<Market[]>();

      type OrderList = PaginatedResponse<Order>;
      expectTypeOf<OrderList["items"]>().toMatchTypeOf<Order[]>();
    });
  });

  describe("Type Inference", () => {
    it("should correctly infer types from Prisma models", () => {
      const market: Market = {} as Market;
      expectTypeOf(market.id).toBeString();
      expectTypeOf(market.status).toMatchTypeOf<MarketStatus>();
    });

    it("should correctly infer extended types", () => {
      const receipt: OrderReceipt = {} as OrderReceipt;
      expectTypeOf(receipt.id).toBeString();
      expectTypeOf(receipt.signature).toBeString();
    });

    it("should correctly infer generic response types", () => {
      const response: ApiResponse<Market[]> = {} as ApiResponse<Market[]>;
      expectTypeOf(response.success).toBeBoolean();
      expectTypeOf(response.data).toMatchTypeOf<Market[] | undefined>();
    });
  });
});
