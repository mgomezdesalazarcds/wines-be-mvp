import { Router, Request, Response } from "express";
import { prisma } from "../lib/db";
import { verifyPassword, signToken, requireAuth } from "../lib/auth";
import { asyncHandler } from "../lib/asyncHandler";

const router = Router();

router.post(
  "/login",
  asyncHandler(async (req: Request, res: Response) => {
    const { email, password } = req.body ?? {};
    if (typeof email !== "string" || typeof password !== "string") {
      return res.status(400).json({ error: "email and password are required" });
    }

    const user = await prisma.user.findUnique({
      where: { email: email.trim().toLowerCase() },
      include: { company: { select: { id: true, name: true, slug: true, logoUrl: true } } },
    });
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const token = signToken({
      userId: user.id,
      companyId: user.companyId,
      role: user.role,
    });
    return res.json({
      token,
      user: { id: user.id, email: user.email, role: user.role },
      company: user.company,
    });
  })
);

router.get(
  "/me",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const auth = req.auth!;
    const user = await prisma.user.findUnique({
      where: { id: auth.userId },
      include: { company: { select: { id: true, name: true, slug: true, logoUrl: true } } },
    });
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    return res.json({
      user: { id: user.id, email: user.email, role: user.role },
      company: user.company,
    });
  })
);

export default router;
