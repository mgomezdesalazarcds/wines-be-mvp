import { Router, Request, Response } from "express";
import multer from "multer";
import { getDefaultCompanyId } from "../lib/db";
import {
  searchWines,
  getStaffPicks,
  getNewArrivals,
  listWines,
  getWineDetail,
  updateCompanyWine,
  UpdateCompanyWineInput,
} from "../lib/wine-matcher";
import { uploadWineImage } from "../lib/storage";
import { requiredMatchTokens } from "../lib/wine-classifier";
import { asyncHandler } from "../lib/asyncHandler";
import { requireAuth, requireCompanyScope } from "../lib/auth";

const router = Router();
const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
});
const DEFAULT_SECTIONS = (process.env.POC_SECTION || "italy")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const MIN_SEARCH_CONFIDENCE = 0.5;

router.get("/", asyncHandler(async (req: Request, res: Response) => {
  const companyId = await getDefaultCompanyId();
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const staffOnly = req.query.staff === "1";
  const arrivalsOnly = req.query.arrivals === "1";
  const querySection = typeof req.query.section === "string" ? req.query.section : null;
  const sections = querySection ? [querySection] : DEFAULT_SECTIONS;

  if (staffOnly) {
    const wines = await getStaffPicks(companyId, sections);
    return res.json({ wines });
  }

  if (arrivalsOnly) {
    const wines = await getNewArrivals(companyId, sections);
    return res.json({ wines });
  }

  if (q && q.length >= 2) {
    const results = await searchWines(companyId, q, sections, 15);

    const requiredTokens = requiredMatchTokens(q, 1);
    const relevant = results.filter((r) => {
      if (r.matchConfidence < MIN_SEARCH_CONFIDENCE) return false;
      if (requiredTokens.length === 0) return true;
      const nameUpper = r.item_name.toUpperCase();
      return requiredTokens.every((t) => nameUpper.includes(t));
    });

    return res.json({ wines: relevant });
  }

  const wines = await listWines(companyId, sections, 50);
  return res.json({ wines });
}));

router.get("/:id", asyncHandler(async (req: Request, res: Response) => {
  const companyId = await getDefaultCompanyId();
  const id = String(req.params.id);
  const result = await getWineDetail(companyId, id);

  if (!result) {
    return res.status(404).json({ error: "Vino no encontrado" });
  }

  return res.json(result);
}));

router.patch("/:id", requireAuth, requireCompanyScope, asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId!;
  const lookupCode = String(req.params.id);
  const body = req.body ?? {};

  const input: UpdateCompanyWineInput = {};

  if (body.price !== undefined) {
    if (typeof body.price !== "number") {
      return res.status(400).json({ error: "price must be a number" });
    }
    input.price = body.price;
  }
  if (body.stockCount !== undefined) {
    if (body.stockCount !== null && typeof body.stockCount !== "number") {
      return res.status(400).json({ error: "stockCount must be a number or null" });
    }
    input.stockCount = body.stockCount;
  }
  if (body.availability !== undefined) {
    if (body.availability !== null && typeof body.availability !== "string") {
      return res.status(400).json({ error: "availability must be a string or null" });
    }
    input.availability = body.availability;
  }
  if (body.staffPick !== undefined) {
    if (typeof body.staffPick !== "boolean") {
      return res.status(400).json({ error: "staffPick must be a boolean" });
    }
    input.staffPick = body.staffPick;
  }
  if (body.isLastArrival !== undefined) {
    if (typeof body.isLastArrival !== "boolean") {
      return res.status(400).json({ error: "isLastArrival must be a boolean" });
    }
    input.isLastArrival = body.isLastArrival;
  }
  if (body.imageUrl !== undefined) {
    if (body.imageUrl !== null && typeof body.imageUrl !== "string") {
      return res.status(400).json({ error: "imageUrl must be a string or null" });
    }
    input.imageUrl = body.imageUrl;
  }
  if (body.extraData !== undefined) {
    if (typeof body.extraData !== "object" || body.extraData === null || Array.isArray(body.extraData)) {
      return res.status(400).json({ error: "extraData must be an object" });
    }
    input.extraData = body.extraData;
  }

  if (Object.keys(input).length === 0) {
    return res.status(400).json({ error: "No fields to update" });
  }

  const result = await updateCompanyWine(companyId, lookupCode, input);
  if (!result) {
    return res.status(404).json({ error: "Wine not found" });
  }

  return res.json(result);
}));

router.post(
  "/:id/image",
  requireAuth,
  requireCompanyScope,
  imageUpload.single("image"),
  asyncHandler(async (req: Request, res: Response) => {
    const companyId = req.auth!.companyId!;
    const lookupCode = String(req.params.id);

    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: "No file received" });
    }
    if (!file.mimetype.startsWith("image/")) {
      return res.status(400).json({ error: "File must be an image" });
    }

    const extension = file.mimetype.split("/")[1] || "jpg";
    const filename = `${companyId}-${lookupCode}.${extension}`;
    const imageUrl = await uploadWineImage(filename, file.buffer, file.mimetype);

    const result = await updateCompanyWine(companyId, lookupCode, { imageUrl });
    if (!result) {
      return res.status(404).json({ error: "Wine not found" });
    }

    return res.json(result);
  })
);

export default router;
