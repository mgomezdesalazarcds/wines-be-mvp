import { Request, Response, NextFunction } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { Role } from "@prisma/client";

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET not configured in .env");
  return secret;
}

const TOKEN_EXPIRY = "7d";

export interface TokenPayload {
  userId: string;
  /** Null for super admins — they aren't scoped to one company. */
  companyId: string | null;
  role: Role;
}

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  return bcrypt.compare(password, passwordHash);
}

export function signToken(payload: TokenPayload): string {
  return jwt.sign(payload, getJwtSecret(), { expiresIn: TOKEN_EXPIRY });
}

function verifyToken(token: string): TokenPayload {
  return jwt.verify(token, getJwtSecret()) as TokenPayload;
}

declare global {
  namespace Express {
    interface Request {
      auth?: TokenPayload;
    }
  }
}

/** Verifies `Authorization: Bearer <token>` and attaches `req.auth`. On its
 * own this only proves "some valid login" — routes that need a specific
 * kind of login (company-scoped vs. super admin) chain requireCompanyScope
 * or requireSuperAdmin after it. */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
  if (!token) {
    return res.status(401).json({ error: "Missing Authorization header" });
  }

  try {
    req.auth = verifyToken(token);
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

/** Must run after requireAuth. Rejects super admin tokens (companyId is
 * null for them) on routes that operate on one company's data. */
export function requireCompanyScope(req: Request, res: Response, next: NextFunction) {
  if (!req.auth?.companyId) {
    return res.status(403).json({ error: "This account is not scoped to a company" });
  }
  next();
}

/** Must run after requireAuth. Gates the company/user management endpoints
 * to super admin logins only. */
export function requireSuperAdmin(req: Request, res: Response, next: NextFunction) {
  if (req.auth?.role !== Role.SUPER_ADMIN) {
    return res.status(403).json({ error: "Super admin access required" });
  }
  next();
}
