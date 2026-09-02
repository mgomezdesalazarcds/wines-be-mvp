import { prisma } from "../src/lib/db";
import { normalizeLookupCode } from "../src/lib/wine-classifier";

/** Merges duplicate company_wines rows that only differ by leading zeros in
 * lookup_code (e.g. "86891083827" and "086891083827" — same physical
 * barcode, forked into two rows by inconsistent CSV exports over time).
 *
 * Rule: price/sale/stock_count/availability and any single-value field
 * (image_url, extra_data) come from whichever duplicate has that field set
 * and is most recent (created_at) among those that do. Booleans
 * (staff_pick, is_last_arrival, image_approved) are OR'd — true on any
 * duplicate wins regardless of recency. image_approved always travels
 * paired with the image_url it approves (prefer the most recent *approved*
 * photo; only fall back to the most recent unapproved one if none of the
 * duplicates has an approved photo). */
async function main() {
  const rows = await prisma.companyWine.findMany({
    select: {
      id: true,
      companyId: true,
      lookupCode: true,
      staffPick: true,
      isLastArrival: true,
      imageUrl: true,
      imageApproved: true,
      extraData: true,
      createdAt: true,
      wine: { select: { itemName: true } },
    },
  });

  type Row = (typeof rows)[number];
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const key = `${r.companyId}::${normalizeLookupCode(r.lookupCode)}`;
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }

  const dupGroups = [...groups.values()].filter((list) => list.length > 1);
  console.log(`Duplicate groups: ${dupGroups.length}`);

  // Only groups where a non-survivor row carries curation data the
  // survivor lacks need individual handling — everything else is safe to
  // clean up in bulk (step 2 below) without losing anything.
  const needsMerge = dupGroups.filter((list) => {
    const sorted = [...list].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const survivor = sorted[0];
    const rest = sorted.slice(1);
    return rest.some(
      (r) =>
        (r.staffPick && !survivor.staffPick) ||
        (r.isLastArrival && !survivor.isLastArrival) ||
        (r.imageUrl && !survivor.imageUrl) ||
        (r.extraData && !survivor.extraData) ||
        (r.imageApproved && !survivor.imageApproved)
    );
  });
  console.log(`Groups needing an explicit field merge: ${needsMerge.length}`);

  let mergedCount = 0;
  for (const list of needsMerge) {
    const sorted = [...list].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const survivor = sorted[0];

    const staffPick = list.some((r) => r.staffPick);
    const isLastArrival = list.some((r) => r.isLastArrival);

    // image_url/image_approved travel together: prefer the most recent
    // *approved* photo across the group; else the most recent photo at all.
    const approved = sorted.find((r) => r.imageApproved && r.imageUrl);
    const anyImage = sorted.find((r) => r.imageUrl);
    const imageUrl = approved?.imageUrl ?? anyImage?.imageUrl ?? null;
    const imageApproved = !!approved;

    const extraDataRow = sorted.find((r) => r.extraData);
    const extraData = extraDataRow?.extraData ?? null;

    console.log(
      `Merging "${survivor.wine.itemName}": survivor=${survivor.lookupCode} <- staffPick=${staffPick} isLastArrival=${isLastArrival} imageApproved=${imageApproved} imageUrl=${imageUrl ? "yes" : "no"} extraData=${extraData ? "yes" : "no"}`
    );

    // Delete the losers first — updating the survivor's lookup_code to the
    // normalized form can collide with a not-yet-deleted loser that's
    // already stored unpadded (unique constraint on company_id+lookup_code).
    await prisma.companyWine.deleteMany({
      where: { id: { in: sorted.slice(1).map((r) => r.id) } },
    });
    await prisma.companyWine.update({
      where: { id: survivor.id },
      data: {
        lookupCode: normalizeLookupCode(survivor.lookupCode),
        staffPick,
        isLastArrival,
        imageUrl,
        imageApproved,
        ...(extraData ? { extraData: extraData as any } : {}),
      },
    });
    mergedCount++;
  }
  console.log(`Explicitly merged ${mergedCount} groups.`);

  // Bulk cleanup for every remaining group (including the ones just merged
  // above, whose losers are now safe to delete since their data already
  // moved to the survivor): keep the most-recent row per (company_id,
  // normalized lookup_code), delete the rest, in one set-based query.
  const deleteResult: { count: number }[] = await prisma.$queryRawUnsafe(`
    WITH ranked AS (
      SELECT id,
        row_number() OVER (
          PARTITION BY company_id, regexp_replace(lookup_code, '^0+', '')
          ORDER BY created_at DESC
        ) AS rn
      FROM company_wines
    )
    DELETE FROM company_wines
    WHERE id IN (SELECT id FROM ranked WHERE rn > 1)
    RETURNING id
  `);
  console.log(`Bulk-deleted ${Array.isArray(deleteResult) ? deleteResult.length : "?"} leftover duplicate rows.`);

  // Normalize every surviving lookup_code so future imports match exactly,
  // without relying on the regexp fallback in the WHERE clause.
  const normalizeResult: unknown = await prisma.$executeRawUnsafe(`
    UPDATE company_wines
    SET lookup_code = regexp_replace(lookup_code, '^0+', '')
    WHERE lookup_code ~ '^0' AND regexp_replace(lookup_code, '^0+', '') <> ''
  `);
  console.log(`Normalized lookup_code on ${normalizeResult} rows.`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
