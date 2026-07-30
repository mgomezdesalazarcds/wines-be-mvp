import { Router, Request, Response } from "express";
import multer from "multer";
import { prisma } from "../lib/db";
import { requireAuth } from "../lib/auth";
import { importCsvForCompany } from "../lib/csv-import";
import { asyncHandler } from "../lib/asyncHandler";

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

router.use(requireAuth);

router.post(
  "/imports",
  upload.single("file"),
  asyncHandler(async (req: Request, res: Response) => {
    const companyId = req.auth!.companyId;

    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: "No file received" });
    }

    const content = file.buffer.toString("utf-8");
    const summary = await importCsvForCompany(companyId, content);

    const record = await prisma.csvImport.create({
      data: {
        companyId,
        filename: file.originalname || "inventory.csv",
        content,
        totalRows: summary.totalRows,
        createdCount: summary.created,
        reusedCount: summary.reused,
        updatedCount: summary.updated,
        skippedCount: summary.skipped,
      },
      select: { id: true, filename: true, createdAt: true },
    });

    return res.json({
      message: `Import complete: ${summary.updated} updated, ${summary.created} new wines, ${summary.reused} new SKUs on existing wines, ${summary.skipped} rows skipped.`,
      summary,
      import: record,
    });
  })
);

router.get(
  "/imports",
  asyncHandler(async (req: Request, res: Response) => {
    const companyId = req.auth!.companyId;
    const imports = await prisma.csvImport.findMany({
      where: { companyId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        filename: true,
        totalRows: true,
        createdCount: true,
        reusedCount: true,
        updatedCount: true,
        skippedCount: true,
        createdAt: true,
      },
    });
    return res.json({ imports });
  })
);

router.get(
  "/imports/latest/download",
  asyncHandler(async (req: Request, res: Response) => {
    const companyId = req.auth!.companyId;
    const record = await prisma.csvImport.findFirst({
      where: { companyId },
      orderBy: { createdAt: "desc" },
      select: { filename: true, content: true },
    });
    if (!record) {
      return res.status(404).json({ error: "No CSV has been uploaded yet" });
    }

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="${record.filename}"`);
    return res.send(record.content);
  })
);

// Must come after /imports/latest/download — ":id" would otherwise swallow
// the literal "latest" segment first.
router.get(
  "/imports/:id/download",
  asyncHandler(async (req: Request, res: Response) => {
    const companyId = req.auth!.companyId;
    const record = await prisma.csvImport.findFirst({
      where: { id: String(req.params.id), companyId },
      select: { filename: true, content: true },
    });
    if (!record) {
      return res.status(404).json({ error: "Import not found" });
    }

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="${record.filename}"`);
    return res.send(record.content);
  })
);

export default router;
