import { Router, Request, Response } from "express";
import multer from "multer";
import { randomUUID } from "crypto";
import { prisma, getDefaultCompanyId } from "../lib/db";
import { extractLabelsFromImage, hasGeminiApiKey } from "../lib/ai";
import { matchFromLabelText, searchWines, MatchResult } from "../lib/wine-matcher";
import { normalizeWineName } from "../lib/wine-classifier";
import { asyncHandler } from "../lib/asyncHandler";

const router = Router();
const SECTIONS = (process.env.POC_SECTION || "italy")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const upload = multer({ storage: multer.memoryStorage() });

router.post(
  "/",
  upload.single("image"),
  asyncHandler(async (req: Request, res: Response) => {
    const companyId = await getDefaultCompanyId();

    if (!hasGeminiApiKey()) {
      return res.status(500).json({
        error: "GEMINI_API_KEY no configurada. Agregá la key en .env",
      });
    }

    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: "No se recibió imagen" });
    }

    try {
      const buffer = file.buffer;
      const base64 = buffer.toString("base64");
      const mimeType = file.mimetype || "image/jpeg";

      const extractions = await extractLabelsFromImage(base64, mimeType);

      // Two extractions for the same producer+wine resolve to the same
      // inventory SKU either way — matching isn't vintage-aware — so
      // running the search/AI-disambiguation step for both would just
      // repeat the same work for the same result.
      const dedupedExtractions = new Map<string, (typeof extractions)[number]>();
      for (const extracted of extractions) {
        const key = normalizeWineName(`${extracted.producer} ${extracted.wineName}`);
        if (!dedupedExtractions.has(key)) dedupedExtractions.set(key, extracted);
      }

      // Usually one bottle per photo, but a shelf shot can have two genuinely
      // different, equally in-focus bottles — match what's left concurrently
      // and merge results, keeping the highest-confidence match per wine.
      const matchesByCode = new Map<string, MatchResult>();
      const perExtractionResults = await Promise.all(
        [...dedupedExtractions.values()].map((extracted) =>
          matchFromLabelText(companyId, extracted, SECTIONS)
        )
      );
      for (const results of perExtractionResults) {
        for (const m of results) {
          const existing = matchesByCode.get(m.wine.lookup_code);
          if (!existing || m.confidence > existing.confidence) {
            matchesByCode.set(m.wine.lookup_code, m);
          }
        }
      }
      const matches = [...matchesByCode.values()].sort((a, b) => b.confidence - a.confidence);
      const primary: (typeof extractions)[number] | undefined = extractions[0];

      const logId = randomUUID();

      // Response shape is always `wines: [...]` — 1 element for a confident
      // single match, 2+ when the label matched several bottle sizes of the
      // same wine.
      if (matches.length >= 1) {
        const isSingleMatch = matches.length === 1;
        const match = matches[0];

        await prisma.scanLog.create({
          data: {
            id: logId,
            companyId,
            status: isSingleMatch ? "matched" : "multiple_matches",
            extractedText: JSON.stringify(extractions),
            matchedLookupCode: isSingleMatch ? match.wine.lookup_code : null,
            confidence: match.confidence,
          },
        });

        return res.json({
          status: isSingleMatch ? "matched" : "multiple_matches",
          wines: matches.map((m) => ({
            ...m.wine,
            // Only meaningful for *this* physical bottle — not persisted,
            // since the same SKU can restock under a different vintage.
            vintage: isSingleMatch ? (primary?.vintage ?? null) : null,
            confidence: m.confidence,
          })),
          extracted: primary ?? null,
          logId,
        });
      }

      await prisma.scanLog.create({
        data: {
          id: logId,
          companyId,
          status: "not_identified",
          extractedText: JSON.stringify(extractions),
          confidence: primary?.confidence ?? 0,
          errorMessage: "No match found in inventory",
        },
      });

      const suggestions = primary?.fullText
        ? await searchWines(companyId, primary.fullText, SECTIONS, 5)
        : [];

      return res.json({
        status: "not_identified",
        extracted: primary ?? null,
        logId,
        suggestions,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Error al procesar imagen";
      console.error("Scan error:", err);
      await prisma.failureLog
        .create({ data: { companyId, source: "scan", message } })
        .catch((logErr) => console.error("Failed to write failure log:", logErr));
      return res.status(500).json({ error: message });
    }
  })
);

export default router;
