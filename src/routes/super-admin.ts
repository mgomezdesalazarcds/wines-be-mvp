import { Router, Request, Response } from "express";
import { Role } from "@prisma/client";
import { prisma } from "../lib/db";
import { requireAuth, requireSuperAdmin, hashPassword } from "../lib/auth";
import { createInviteToken, randomUnusablePassword } from "../lib/invites";
import { asyncHandler } from "../lib/asyncHandler";

const router = Router();

router.use(requireAuth, requireSuperAdmin);

const COMPANY_SELECT = {
  id: true,
  name: true,
  slug: true,
  logoUrl: true,
  createdAt: true,
  _count: { select: { users: true, wines: true } },
};

router.get(
  "/companies",
  asyncHandler(async (_req: Request, res: Response) => {
    const companies = await prisma.company.findMany({
      select: COMPANY_SELECT,
      orderBy: { name: "asc" },
    });
    return res.json({ companies });
  })
);

router.post(
  "/companies",
  asyncHandler(async (req: Request, res: Response) => {
    const { name, slug } = req.body ?? {};
    if (typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "name must be a non-empty string" });
    }
    if (typeof slug !== "string" || !/^[a-z0-9-]+$/.test(slug)) {
      return res.status(400).json({ error: "slug must contain only lowercase letters, numbers, and hyphens" });
    }

    const existing = await prisma.company.findUnique({ where: { slug } });
    if (existing) {
      return res.status(409).json({ error: "A company with this slug already exists" });
    }

    const company = await prisma.company.create({
      data: { name: name.trim(), slug },
      select: COMPANY_SELECT,
    });
    return res.status(201).json({ company });
  })
);

// Deletes the company along with everything that has a real FK to it
// (its listings and users) — Wine rows in the shared catalog are untouched
// since other companies may reference the same generic wines. ScanLog,
// FailureLog, and CsvImport rows are plain history with no FK constraint,
// so they're left as orphaned records rather than deleted (not worth the
// extra round-trips for logs nobody will look up by a dead companyId).
router.delete(
  "/companies/:id",
  asyncHandler(async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const company = await prisma.company.findUnique({ where: { id } });
    if (!company) {
      return res.status(404).json({ error: "Company not found" });
    }

    await prisma.$transaction([
      prisma.companyWine.deleteMany({ where: { companyId: id } }),
      prisma.user.deleteMany({ where: { companyId: id } }),
      prisma.company.delete({ where: { id } }),
    ]);

    return res.status(204).send();
  })
);

const USER_SELECT = {
  id: true,
  email: true,
  role: true,
  companyId: true,
  createdAt: true,
  company: { select: { id: true, name: true, slug: true } },
};

router.get(
  "/users",
  asyncHandler(async (req: Request, res: Response) => {
    const companyId = typeof req.query.companyId === "string" ? req.query.companyId : undefined;
    const users = await prisma.user.findMany({
      where: companyId ? { companyId } : undefined,
      select: USER_SELECT,
      orderBy: { email: "asc" },
    });
    return res.json({ users });
  })
);

// No password field here on purpose — the super admin never sees or picks
// a user's password. This creates the account with an unusable placeholder
// hash and an invite token; the returned `inviteToken` is only ever
// available here, in this response, for the caller to share with the
// invitee (e.g. as a copyable /accept-invite/<token> link).
router.post(
  "/users",
  asyncHandler(async (req: Request, res: Response) => {
    const { email, companyId, isSuperAdmin } = req.body ?? {};

    if (typeof email !== "string" || !email.trim()) {
      return res.status(400).json({ error: "email is required" });
    }
    const makeSuperAdmin = isSuperAdmin === true;

    if (makeSuperAdmin) {
      if (companyId !== undefined && companyId !== null) {
        return res.status(400).json({ error: "Super admins can't be scoped to a company" });
      }
    } else if (typeof companyId !== "string" || !companyId) {
      return res.status(400).json({ error: "companyId is required for non-super-admin users" });
    } else {
      const company = await prisma.company.findUnique({ where: { id: companyId } });
      if (!company) {
        return res.status(400).json({ error: "companyId does not match an existing company" });
      }
    }

    const normalizedEmail = email.trim().toLowerCase();
    const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (existing) {
      return res.status(409).json({ error: "A user with this email already exists" });
    }

    const passwordHash = await hashPassword(randomUnusablePassword());
    const user = await prisma.user.create({
      data: {
        email: normalizedEmail,
        passwordHash,
        role: makeSuperAdmin ? Role.SUPER_ADMIN : Role.ADMIN,
        companyId: makeSuperAdmin ? null : companyId,
      },
      select: USER_SELECT,
    });
    const inviteToken = await createInviteToken(user.id);
    return res.status(201).json({ user, inviteToken });
  })
);

router.delete(
  "/users/:id",
  asyncHandler(async (req: Request, res: Response) => {
    const id = String(req.params.id);
    if (id === req.auth!.userId) {
      return res.status(400).json({ error: "You can't delete your own account" });
    }

    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    await prisma.user.delete({ where: { id } });
    return res.status(204).send();
  })
);

export default router;
