import crypto from "crypto";
import { prisma } from "./db";

const INVITE_EXPIRY_DAYS = 7;

/** Creates a one-time invite for a freshly-created user and returns the raw
 * token (the only time it's ever available in plaintext — only its DB row
 * exists after this, looked up by the value itself). */
export async function createInviteToken(userId: string): Promise<string> {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
  await prisma.inviteToken.create({ data: { userId, token, expiresAt } });
  return token;
}

/** Placeholder passwordHash for a user created via invite — nobody knows
 * this value, so login is impossible until they accept the invite and set
 * a real password. Avoids making `passwordHash` nullable just for this. */
export function randomUnusablePassword(): string {
  return crypto.randomBytes(32).toString("hex");
}
