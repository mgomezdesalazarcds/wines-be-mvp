import { Router, Request, Response } from "express";
import multer from "multer";
import { prisma } from "../lib/db";
import { requireAuth, requireCompanyScope } from "../lib/auth";
import { uploadCompanyLogo } from "../lib/storage";
import { asyncHandler } from "../lib/asyncHandler";

const router = Router();
const logoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
});

router.use(requireAuth, requireCompanyScope);

const COMPANY_SELECT = { id: true, name: true, slug: true, logoUrl: true, createdAt: true };

router.get(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const company = await prisma.company.findUnique({
      where: { id: req.auth!.companyId! },
      select: COMPANY_SELECT,
    });
    if (!company) {
      return res.status(404).json({ error: "Company not found" });
    }
    return res.json({ company });
  })
);

// `slug` is intentionally not editable here — it's the lookup key used
// elsewhere (DEFAULT_COMPANY_SLUG, npm run create-user/import) and changing
// it out from under those would silently break them.
router.patch(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const body = req.body ?? {};

    if (body.name === undefined) {
      return res.status(400).json({ error: "No fields to update" });
    }
    if (typeof body.name !== "string" || !body.name.trim()) {
      return res.status(400).json({ error: "name must be a non-empty string" });
    }

    const company = await prisma.company.update({
      where: { id: req.auth!.companyId! },
      data: { name: body.name.trim() },
      select: COMPANY_SELECT,
    });
    return res.json({ company });
  })
);

router.post(
  "/logo",
  logoUpload.single("image"),
  asyncHandler(async (req: Request, res: Response) => {
    const companyId = req.auth!.companyId!;

    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: "No file received" });
    }
    if (!file.mimetype.startsWith("image/")) {
      return res.status(400).json({ error: "File must be an image" });
    }

    const extension = file.mimetype.split("/")[1] || "png";
    const filename = `${companyId}.${extension}`;
    const logoUrl = await uploadCompanyLogo(filename, file.buffer, file.mimetype);

    const company = await prisma.company.update({
      where: { id: companyId },
      data: { logoUrl },
      select: COMPANY_SELECT,
    });
    return res.json({ company });
  })
);

export default router;
