import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { isWineCandidate } from "./wine-classifier";
import {
  classifyAndEnrichWines,
  enrichWinesBatch,
  hasGeminiApiKey,
} from "./ai";
import {
  hasStructuredFlavors,
  mergeEnrichmentPreservingStaff,
} from "./enrichment-data";

// Same batching/pacing as wines-be-node's classify-and-enrich-all.ts — 30
// wines per Gemini call, an 8s gap between batches to stay under rate
// limits. A 30k-row CSV is mostly non-wine/already-classified rows filtered
// out below, so in practice this is far fewer than 1,000 calls.
const BATCH_SIZE = 30;
const DELAY_MS = 8000;

const SECTIONS = (process.env.POC_SECTION || "italy")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Sweeps every Wine not yet reviewed by AI (sectionSource not "ai" or
 * "excluded") and fills in isWine/section/extraData. Meant to be called
 * fire-and-forget right after a CSV import — the import response doesn't
 * wait for this, since a full sweep can take minutes at Gemini's rate
 * limits. Idempotent/resumable: already-classified or confirmed-excluded
 * wines are skipped, so a failed or interrupted run just picks back up
 * next time this is called. */
export async function classifyAndEnrichPendingWines(): Promise<void> {
  if (!hasGeminiApiKey()) {
    console.log("Classify/enrich: skipped, no GEMINI_API_KEY configured.");
    return;
  }

  const rows = await prisma.wine.findMany({
    where: { sectionSource: { notIn: ["ai", "excluded"] } },
    select: { id: true, itemName: true, size: true },
    orderBy: { id: "asc" },
  });
  if (rows.length === 0) return;

  // Permanently not a wine candidate by name/size — stop re-checking it on
  // every future sweep instead of leaving it in "heuristic" limbo.
  const notCandidates = rows.filter((w) => !isWineCandidate(w.itemName, w.size ?? ""));
  if (notCandidates.length > 0) {
    await prisma.wine.updateMany({
      where: { id: { in: notCandidates.map((w) => w.id) } },
      data: { sectionSource: "excluded" },
    });
  }

  const pending = rows.filter((w) => isWineCandidate(w.itemName, w.size ?? ""));
  console.log(
    `Classify/enrich: ${pending.length} candidate(s) to review, ${notCandidates.length} excluded as non-wine.`
  );

  let processed = 0;
  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    const batch = pending.slice(i, i + BATCH_SIZE);
    try {
      const results = await classifyAndEnrichWines(batch, SECTIONS);

      await prisma.$transaction(
        batch.map((wine) => {
          const result = results.get(wine.id);
          return prisma.wine.update({
            where: { id: wine.id },
            data: {
              isWine: result?.isWine ?? false,
              section: result?.section ?? null,
              sectionSource: "ai",
              ...(result?.enrichment
                ? { extraData: result.enrichment as unknown as Prisma.InputJsonValue }
                : {}),
            },
          });
        })
      );

      processed += batch.length;
      console.log(`Classify/enrich: processed ${processed}/${pending.length}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Classify/enrich: batch starting at ${i} failed, will retry next run:`, message);
    }

    if (i + BATCH_SIZE < pending.length) {
      await sleep(DELAY_MS);
    }
  }

  console.log(`Classify/enrich: sweep done, reviewed ${processed}/${pending.length}.`);
}

export interface ReenrichOptions {
  /** Re-run even when `flavors` already looks valid. Default: only missing. */
  force?: boolean;
  /** Cap how many wines to process this run. */
  limit?: number;
  /** Optional explicit Wine.id list. */
  wineIds?: string[];
}

export interface ReenrichSummary {
  candidates: number;
  updated: number;
  skipped: number;
  failed: number;
}

/** Regenerates Taste Profile / Flavor Circles for wines already classified
 * by AI. Only writes `Wine.extraData` — never touches `CompanyWine.extraData`,
 * so staff_note / staff_name / staff copy stay intact. */
export async function reenrichClassifiedWines(
  options: ReenrichOptions = {}
): Promise<ReenrichSummary> {
  if (!hasGeminiApiKey()) {
    console.log("Re-enrich: skipped, no GEMINI_API_KEY configured.");
    return { candidates: 0, updated: 0, skipped: 0, failed: 0 };
  }

  const rows = await prisma.wine.findMany({
    where: {
      isWine: true,
      sectionSource: "ai",
      ...(SECTIONS.length ? { section: { in: SECTIONS } } : {}),
      ...(options.wineIds?.length ? { id: { in: options.wineIds } } : {}),
    },
    select: { id: true, itemName: true, extraData: true },
    orderBy: { id: "asc" },
  });

  const pending = options.force
    ? rows
    : rows.filter((w) => !hasStructuredFlavors(w.extraData));

  const limited =
    typeof options.limit === "number" && options.limit > 0
      ? pending.slice(0, options.limit)
      : pending;

  console.log(
    `Re-enrich: ${limited.length} wine(s) to update` +
      (options.force ? " (force)" : " (missing flavors)") +
      `, ${rows.length - pending.length} already structured, ${pending.length - limited.length} deferred by limit.`
  );

  let updated = 0;
  let failed = 0;

  for (let i = 0; i < limited.length; i += BATCH_SIZE) {
    const batch = limited.slice(i, i + BATCH_SIZE);
    try {
      const results = await enrichWinesBatch(
        batch.map((w) => ({ id: w.id, itemName: w.itemName }))
      );

      const updates = batch.flatMap((wine) => {
        const enrichment = results.get(wine.id);
        if (!enrichment) return [];
        const merged = mergeEnrichmentPreservingStaff(wine.extraData, enrichment);
        return [
          prisma.wine.update({
            where: { id: wine.id },
            data: { extraData: merged as Prisma.InputJsonValue },
          }),
        ];
      });
      if (updates.length > 0) {
        await prisma.$transaction(updates);
      }

      const batchUpdated = updates.length;
      updated += batchUpdated;
      failed += batch.length - batchUpdated;
      console.log(`Re-enrich: processed ${Math.min(i + batch.length, limited.length)}/${limited.length}`);
    } catch (err) {
      failed += batch.length;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Re-enrich: batch starting at ${i} failed:`, message);
    }

    if (i + BATCH_SIZE < limited.length) {
      await sleep(DELAY_MS);
    }
  }

  const summary = {
    candidates: limited.length,
    updated,
    skipped: rows.length - pending.length + (pending.length - limited.length),
    failed,
  };
  console.log(
    `Re-enrich: done. updated=${summary.updated} skipped=${summary.skipped} failed=${summary.failed}`
  );
  return summary;
}

/** On-demand enrichment for a single generic Wine row (POST /api/wines/:id
 * and lazy upgrade on GET when Flavor Circles are missing). Legacy rows with
 * only taste_profile get a fresh Gemini pass — not keyword→color guessing. */
export async function enrichWineById(wineId: string): Promise<boolean> {
  if (!hasGeminiApiKey()) {
    throw new Error("GEMINI_API_KEY not configured");
  }

  const wine = await prisma.wine.findUnique({
    where: { id: wineId },
    select: { id: true, itemName: true, extraData: true, isWine: true },
  });
  if (!wine || !wine.isWine) return false;

  if (hasStructuredFlavors(wine.extraData)) {
    return true;
  }

  const results = await enrichWinesBatch([{ id: wine.id, itemName: wine.itemName }]);
  const enrichment = results.get(wine.id);
  if (!enrichment) return false;

  const merged = mergeEnrichmentPreservingStaff(wine.extraData, enrichment);
  await prisma.wine.update({
    where: { id: wine.id },
    data: { extraData: merged as Prisma.InputJsonValue },
  });
  return true;
}

/** Resolve company listing → wine id and upgrade Flavor Circles via AI when
 * the stored enrichment is still the legacy taste_profile-only shape. */
export async function ensureStructuredFlavorsForLookup(
  companyId: string,
  lookupCode: string
): Promise<"updated" | "already_ok" | "skipped_no_key" | "not_found" | "failed"> {
  const cw = await prisma.companyWine.findUnique({
    where: { companyId_lookupCode: { companyId, lookupCode } },
    select: {
      wineId: true,
      wine: { select: { extraData: true, isWine: true } },
      extraData: true,
    },
  });
  if (!cw) return "not_found";
  if (!cw.wine.isWine) return "already_ok";

  const resolved = {
    ...((cw.wine.extraData as Record<string, unknown> | null) ?? {}),
    ...((cw.extraData as Record<string, unknown> | null) ?? {}),
  };
  if (hasStructuredFlavors(resolved)) {
    return "already_ok";
  }
  if (!hasGeminiApiKey()) {
    return "skipped_no_key";
  }

  try {
    const ok = await enrichWineById(cw.wineId);
    return ok ? "updated" : "failed";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`ensureStructuredFlavorsForLookup(${lookupCode}):`, message);
    return "failed";
  }
}
