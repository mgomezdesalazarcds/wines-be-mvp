import { Router, Request, Response } from "express";
import multer from "multer";
import { prisma, getDefaultCompanyId } from "../lib/db";
import { importCsvForCompany } from "../lib/csv-import";
import { asyncHandler } from "../lib/asyncHandler";

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

router.post(
  "/imports",
  upload.single("file"),
  asyncHandler(async (req: Request, res: Response) => {
    const companyId = await getDefaultCompanyId();

    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: "No se recibió el archivo" });
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
      message: `Importado: ${summary.updated} actualizados, ${summary.created} vinos nuevos, ${summary.reused} SKUs nuevos sobre vinos existentes, ${summary.skipped} filas salteadas.`,
      summary,
      import: record,
    });
  })
);

router.get(
  "/imports",
  asyncHandler(async (_req: Request, res: Response) => {
    const companyId = await getDefaultCompanyId();
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
  "/imports/:id/download",
  asyncHandler(async (req: Request, res: Response) => {
    const companyId = await getDefaultCompanyId();
    const record = await prisma.csvImport.findFirst({
      where: { id: String(req.params.id), companyId },
      select: { filename: true, content: true },
    });
    if (!record) {
      return res.status(404).json({ error: "Import no encontrado" });
    }

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="${record.filename}"`);
    return res.send(record.content);
  })
);

export default router;
