import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { isWineCandidate } from "./wine-classifier";
import { classifyAndEnrichWines, hasGeminiApiKey } from "./ai";

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
