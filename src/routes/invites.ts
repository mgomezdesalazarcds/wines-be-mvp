import { Router, Request, Response } from "express";
import { prisma } from "../lib/db";
import { hashPassword, signToken } from "../lib/auth";
import { asyncHandler } from "../lib/asyncHandler";

const router = Router();

async function findValidInvite(token: string) {
  const invite = await prisma.inviteToken.findUnique({
    where: { token },
    include: {
      user: {
        include: { company: { select: { id: true, name: true, slug: true, logoUrl: true } } },
      },
    },
  });
  if (!invite || invite.expiresAt < new Date()) return null;
  return invite;
}

router.get(
  "/:token",
  asyncHandler(async (req: Request, res: Response) => {
    const invite = await findValidInvite(String(req.params.token));
    if (!invite) {
      return res.status(404).json({ error: "This invite link is invalid or has expired" });
    }
    return res.json({ email: invite.user.email });
  })
);

router.post(
  "/:token/accept",
  asyncHandler(async (req: Request, res: Response) => {
    const { password, passwordConfirm } = req.body ?? {};
    if (typeof password !== "string" || password.length < 8) {
      return res.status(400).json({ error: "password must be at least 8 characters" });
    }
    if (password !== passwordConfirm) {
      return res.status(400).json({ error: "Passwords don't match" });
    }

    const invite = await findValidInvite(String(req.params.token));
    if (!invite) {
      return res.status(404).json({ error: "This invite link is invalid or has expired" });
    }

    const passwordHash = await hashPassword(password);
    // Token is single-use: consuming it here means a stale tab that
    // already accepted can't do it again.
    await prisma.$transaction([
      prisma.user.update({ where: { id: invite.userId }, data: { passwordHash } }),
      prisma.inviteToken.delete({ where: { id: invite.id } }),
    ]);

    const authToken = signToken({
      userId: invite.user.id,
      companyId: invite.user.companyId,
      role: invite.user.role,
    });
    return res.json({
      token: authToken,
      user: { id: invite.user.id, email: invite.user.email, role: invite.user.role },
      company: invite.user.company,
    });
  })
);

export default router;
