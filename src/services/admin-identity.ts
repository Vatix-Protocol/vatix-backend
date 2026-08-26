import { hash, compare } from "bcrypt";
import { PrismaClient } from "../generated/prisma/client/index.js";

const BCRYPT_ROUNDS = 12;

export class AdminIdentityService {
  constructor(private prisma: PrismaClient) {}

  async validateCredential(
    identityName: string,
    credential: string
  ): Promise<boolean> {
    const identity = await this.prisma.adminIdentity.findUnique({
      where: { name: identityName },
    });

    if (!identity || identity.revokedAt || !identity.active) {
      return false;
    }

    return compare(credential, identity.credentialHash);
  }

  async createIdentity(
    name: string,
    credential: string,
    actor: string
  ): Promise<void> {
    const credentialHash = await hash(credential, BCRYPT_ROUNDS);

    await this.prisma.adminIdentity.create({
      data: {
        name,
        credentialHash,
        auditLog: {
          create: {
            action: "CREATE",
            actor,
          },
        },
      },
    });
  }

  async rotateCredential(
    identityName: string,
    newCredential: string,
    actor: string
  ): Promise<void> {
    const identity = await this.prisma.adminIdentity.findUnique({
      where: { name: identityName },
    });

    if (!identity) {
      throw new Error(`Admin identity not found: ${identityName}`);
    }

    const credentialHash = await hash(newCredential, BCRYPT_ROUNDS);

    await this.prisma.adminIdentity.update({
      where: { id: identity.id },
      data: {
        credentialHash,
        rotatedAt: new Date(),
        auditLog: {
          create: {
            action: "ROTATE",
            actor,
          },
        },
      },
    });
  }

  async revokeIdentity(
    identityName: string,
    actor: string,
    reason?: string
  ): Promise<void> {
    const identity = await this.prisma.adminIdentity.findUnique({
      where: { name: identityName },
    });

    if (!identity) {
      throw new Error(`Admin identity not found: ${identityName}`);
    }

    await this.prisma.adminIdentity.update({
      where: { id: identity.id },
      data: {
        active: false,
        revokedAt: new Date(),
        auditLog: {
          create: {
            action: "REVOKE",
            actor,
            reason,
          },
        },
      },
    });
  }
}
