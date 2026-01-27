import request from "supertest";
import { app } from "../../index";
import { getPrismaClient } from "../../services/prisma";

describe("Positions Route", () => {
  const prisma = getPrismaClient();
  const testAddress = "GBAHUIO7S6NXF...";

  it("GET /positions/user/:address - should return 400 for non-Stellar address", async () => {
    const res = await request(app).get("/positions/user/0x1234");
    expect(res.status).toBe(400);
    expect(res.body.message).toContain("Invalid Stellar address");
  });

  it("GET /positions/user/:address - should calculate payout as max of shares", async () => {});
});
