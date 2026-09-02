import { prisma } from "../src/lib/db";

/** Marks Wine rows with no company_wines listing (leftovers from the
 * lookup_code dedupe — see dedupe-lookup-codes.ts / repoint-to-classified-
 * wine.ts) as sectionSource: "excluded", the same status
 * classifyAndEnrichPendingWines() already treats as "done, skip forever".
 * Non-destructive: no rows are deleted, and this is the same effect a
 * proper cleanup DELETE would have on the classification queue — it just
 * stops the sweep from wasting Gemini calls re-classifying rows nothing
 * references, instead of actually reaching newly imported wines. */
async function main() {
  const before = await prisma.$queryRawUnsafe<{ n: number }[]>(
    `SELECT count(*)::int as n FROM wines WHERE section_source NOT IN ('ai','excluded')`
  );
  console.log("Pending classification before:", before[0].n);

  const result = await prisma.$executeRawUnsafe(`
    UPDATE wines w
    SET section_source = 'excluded'
    WHERE NOT EXISTS (SELECT 1 FROM company_wines cw WHERE cw.wine_id = w.id)
      AND w.section_source NOT IN ('ai','excluded')
  `);
  console.log("Marked as excluded:", result);

  const after = await prisma.$queryRawUnsafe<{ n: number }[]>(
    `SELECT count(*)::int as n FROM wines WHERE section_source NOT IN ('ai','excluded')`
  );
  console.log("Pending classification after:", after[0].n);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
