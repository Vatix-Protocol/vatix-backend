import "dotenv/config";
import { defineConfig } from "prisma/config";
import { requireEnv } from "./packages/shared/src/requireEnv";

requireEnv(["DATABASE_URL"]);

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: process.env["DATABASE_URL"]!,
  },
});
