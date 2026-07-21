import { Router, Request, Response } from "express";
import { getDefaultCompanyId } from "../lib/db";
import { searchWines, getStaffPicks, listWines, getWineDetail } from "../lib/wine-matcher";
import { requiredMatchTokens } from "../lib/wine-classifier";
import { asyncHandler } from "../lib/asyncHandler";

const router = Router();
const DEFAULT_SECTIONS = (process.env.POC_SECTION || "italy")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const MIN_SEARCH_CONFIDENCE = 0.5;

router.get("/", asyncHandler(async (req: Request, res: Response) => {
  const companyId = await getDefaultCompanyId();
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const staffOnly = req.query.staff === "1";
  const querySection = typeof req.query.section === "string" ? req.query.section : null;
  const sections = querySection ? [querySection] : DEFAULT_SECTIONS;

  if (staffOnly) {
    const wines = await getStaffPicks(companyId, sections);
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

export default router;
