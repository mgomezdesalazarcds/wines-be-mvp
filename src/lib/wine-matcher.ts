import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { normalizeWineName, normalizeSize, requiredMatchTokens } from "./wine-classifier";

/** Import-time dedup: does this (name, size) already exist as a generic
 * Wine, possibly imported by a different company? Two different companies'
 * CSVs have no shared identifier (no UPC/barcode — just each store's own
 * POS lookup_code), so this is the only signal available.
 *
 * Keyed on name + size together: a 750ml and a 1.5L of the same label are
 * different products, not the same wine at two sizes.
 *
 * Strategy: normalized-name exact match first (common case — POS
 * descriptions for the same product are often identical across stores),
 * then a stricter fuzzy fallback (high trigram similarity AND every
 * meaningful word of each name contained in the other) to avoid merging two
 * different wines that just share a producer or denomination.
 */
export async function findExistingWine(
  itemName: string,
  size: string | null
): Promise<{ id: string } | null> {
  const normalized = normalizeWineName(itemName);
  if (!normalized) return null;
  const normalizedSize = normalizeSize(size);

  const exact = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT id FROM wines
    WHERE upper(regexp_replace(item_name, '[^A-Za-z0-9 ]', ' ', 'g')) = ${normalized}
      AND size IS NOT DISTINCT FROM ${normalizedSize}
    LIMIT 1
  `);
  if (exact.length > 0) return exact[0];

  const FUZZY_THRESHOLD = 0.6;
  const candidates = await prisma.$queryRaw<{ id: string; item_name: string; sim: number }[]>(
    Prisma.sql`
      SELECT id, item_name, similarity(item_name, ${itemName}) AS sim
      FROM wines
      WHERE size IS NOT DISTINCT FROM ${normalizedSize}
        AND similarity(item_name, ${itemName}) >= ${FUZZY_THRESHOLD}
      ORDER BY sim DESC
      LIMIT 5
    `
  );

  const newTokens = requiredMatchTokens(itemName);
  for (const candidate of candidates) {
    const candidateTokens = requiredMatchTokens(candidate.item_name);
    const candidateNorm = normalizeWineName(candidate.item_name);
    const allNewTokensInCandidate = newTokens.every((t) => candidateNorm.includes(t));
    const allCandidateTokensInNew = candidateTokens.every((t) => normalized.includes(t));
    if (allNewTokensInCandidate && allCandidateTokensInNew) {
      return { id: candidate.id };
    }
  }

  return null;
}
