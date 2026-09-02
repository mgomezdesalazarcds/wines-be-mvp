import fs from "fs";
import { Prisma } from "@prisma/client";
import { prisma } from "../src/lib/db";

/** Repairs collateral damage from the lookup_code dedupe (see
 * dedupe-lookup-codes.ts): that script merged company_wines rows but never
 * looked at which of the two rows' *wines* record had been AI-classified,
 * so a chunk of survivors ended up pointing at an unclassified Wine while
 * the properly classified one (section, section_source: "ai", enrichment
 * in extra_data) was left orphaned — invisible to search, since search
 * filters on w.section. This repoints each affected company_wines.wine_id
 * back to that orphaned, already-classified Wine row, using the fix list
 * precomputed in /tmp/wine-repoint-fixes.json (cwId -> goodWineId).
 *
 * Leaves the now-fully-orphaned "bad" wine rows in place (harmless —
 * nothing references them once no company_wines points at them); those
 * can be cleaned up separately later. */
async function main() {
  const fixes: { cwId: string; goodWineId: string }[] = JSON.parse(
    fs.readFileSync("/tmp/wine-repoint-fixes.json", "utf8")
  );
  console.log(`Repointing ${fixes.length} company_wines rows...`);

  const CHUNK = 5000;
  let total = 0;
  for (let i = 0; i < fixes.length; i += CHUNK) {
    const chunk = fixes.slice(i, i + CHUNK);
    const values = chunk.map(
      (f) => Prisma.sql`(${f.cwId}::text, ${f.goodWineId}::text)`
    );
    const result: unknown = await prisma.$executeRaw`
      UPDATE company_wines AS cw
      SET wine_id = v.good_wine_id
      FROM (VALUES ${Prisma.join(values)}) AS v(cw_id, good_wine_id)
      WHERE cw.id = v.cw_id
    `;
    total += Number(result);
    console.log(`Chunk ${i / CHUNK + 1}: updated ${result}`);
  }
  console.log(`Total repointed: ${total}`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
