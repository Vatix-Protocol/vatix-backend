import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getPrismaClient } from "./prisma.js";
import { AdminIdentityService } from "./admin-identity.js";

describe("AdminIdentityService", () => {
  let prisma = getPrismaClient();
  let service: AdminIdentityService;

  beforeEach(async () => {
    prisma = getPrismaClient();
    service = new AdminIdentityService(prisma);
    await prisma.adminIdentityAuditLog.deleteMany({});
    await prisma.adminIdentity.deleteMany({});
  });

  afterEach(async () => {
    await prisma.adminIdentityAuditLog.deleteMany({});
    await prisma.adminIdentity.deleteMany({});
  });

  describe("createIdentity", () => {
    it("creates a new admin identity with hashed credential", async () => {
      await service.createIdentity("alice", "secret123", "system");

      const identity = await prisma.adminIdentity.findUnique({
        where: { name: "alice" },
      });

      expect(identity).toBeDefined();
      expect(identity?.name).toBe("alice");
      expect(identity?.active).toBe(true);
      expect(identity?.revokedAt).toBeNull();
      expect(identity?.credentialHash).not.toBe("secret123");
    });

    it("creates audit log entry for identity creation", async () => {
      await service.createIdentity("alice", "secret123", "system");

      const auditLogs = await prisma.adminIdentityAuditLog.findMany({
        where: { action: "CREATE" },
      });

      expect(auditLogs).toHaveLength(1);
      expect(auditLogs[0].actor).toBe("system");
    });
  });

  describe("validateCredential", () => {
    it("returns true for valid identity and credential", async () => {
      await service.createIdentity("alice", "secret123", "system");
      const isValid = await service.validateCredential("alice", "secret123");
      expect(isValid).toBe(true);
    });

    it("returns false for invalid credential", async () => {
      await service.createIdentity("alice", "secret123", "system");
      const isValid = await service.validateCredential("alice", "wrongsecret");
      expect(isValid).toBe(false);
    });

    it("returns false for non-existent identity", async () => {
      const isValid = await service.validateCredential("nonexistent", "secret");
      expect(isValid).toBe(false);
    });

    it("returns false for revoked identity", async () => {
      await service.createIdentity("alice", "secret123", "system");
      await service.revokeIdentity("alice", "system");
      const isValid = await service.validateCredential("alice", "secret123");
      expect(isValid).toBe(false);
    });

    it("returns false for inactive identity", async () => {
      const identity = await prisma.adminIdentity.create({
        data: {
          name: "bob",
          credentialHash: "fakehash",
          active: false,
        },
      });

      const isValid = await service.validateCredential("bob", "anything");
      expect(isValid).toBe(false);
    });
  });

  describe("rotateCredential", () => {
    it("updates credential hash and records rotation", async () => {
      await service.createIdentity("alice", "oldcredential", "system");
      const oldIdentity = await prisma.adminIdentity.findUnique({
        where: { name: "alice" },
      });

      await service.rotateCredential("alice", "newcredential", "admin");

      const updatedIdentity = await prisma.adminIdentity.findUnique({
        where: { name: "alice" },
      });

      expect(updatedIdentity?.credentialHash).not.toBe(
        oldIdentity?.credentialHash
      );
      expect(updatedIdentity?.rotatedAt).not.toBeNull();
    });

    it("invalidates old credential after rotation", async () => {
      await service.createIdentity("alice", "oldcredential", "system");
      await service.rotateCredential("alice", "newcredential", "admin");

      const oldValid = await service.validateCredential(
        "alice",
        "oldcredential"
      );
      const newValid = await service.validateCredential(
        "alice",
        "newcredential"
      );

      expect(oldValid).toBe(false);
      expect(newValid).toBe(true);
    });

    it("creates audit log entry for rotation", async () => {
      await service.createIdentity("alice", "oldcredential", "system");
      await service.rotateCredential("alice", "newcredential", "admin");

      const auditLogs = await prisma.adminIdentityAuditLog.findMany({
        where: { action: "ROTATE" },
      });

      expect(auditLogs).toHaveLength(1);
      expect(auditLogs[0].actor).toBe("admin");
    });

    it("throws error for non-existent identity", async () => {
      await expect(
        service.rotateCredential("nonexistent", "newcred", "admin")
      ).rejects.toThrow();
    });
  });

  describe("revokeIdentity", () => {
    it("marks identity as revoked", async () => {
      await service.createIdentity("alice", "secret123", "system");
      await service.revokeIdentity("alice", "admin", "compromised");

      const identity = await prisma.adminIdentity.findUnique({
        where: { name: "alice" },
      });

      expect(identity?.active).toBe(false);
      expect(identity?.revokedAt).not.toBeNull();
    });

    it("creates audit log entry for revocation", async () => {
      await service.createIdentity("alice", "secret123", "system");
      await service.revokeIdentity("alice", "admin", "compromised");

      const auditLogs = await prisma.adminIdentityAuditLog.findMany({
        where: { action: "REVOKE" },
      });

      expect(auditLogs).toHaveLength(1);
      expect(auditLogs[0].actor).toBe("admin");
      expect(auditLogs[0].reason).toBe("compromised");
    });

    it("prevents revoked identity from validating", async () => {
      await service.createIdentity("alice", "secret123", "system");
      await service.revokeIdentity("alice", "admin");

      const isValid = await service.validateCredential("alice", "secret123");
      expect(isValid).toBe(false);
    });

    it("throws error for non-existent identity", async () => {
      await expect(
        service.revokeIdentity("nonexistent", "admin")
      ).rejects.toThrow();
    });
  });
});
