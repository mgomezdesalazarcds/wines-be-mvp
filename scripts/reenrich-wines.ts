import "../src/env";
import { Prisma } from "@prisma/client";
import { reenrichClassifiedWines } from "../src/lib/enrichment";
import { prisma } from "../src/lib/db";

/**
 * Regenerates AI enrichment (taste_summary + flavors circles + scales) for
 * wines already marked sectionSource=ai. Does not re-classify and does not
 * touch CompanyWine.extraData (staff_note / staff_name stay put).
 *
 * Usage:
 *   npx tsx scripts/reenrich-wines.ts
 *   npx tsx scripts/reenrich-wines.ts --force
 *   npx tsx scripts/reenrich-wines.ts --limit 20
 *   npx tsx scripts/reenrich-wines.ts --ids <uuid>,<uuid>
 *   npx tsx scripts/reenrich-wines.ts --sample 5   # after run, print a sample
 */

function readFlag(name: string): boolean {
  return process.argv.includes(name);
}

function readArg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

async function main() {
  const force = readFlag("--force");
  const limitRaw = readArg("--limit");
  const idsRaw = readArg("--ids");
  const sampleRaw = readArg("--sample");

  const summary = await reenrichClassifiedWines({
    force,
    limit: limitRaw ? Number(limitRaw) : undefined,
    wineIds: idsRaw ? idsRaw.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
  });

  console.log(JSON.stringify(summary, null, 2));

  const sampleN = sampleRaw ? Number(sampleRaw) : 0;
  if (sampleN > 0) {
    const sample = await prisma.wine.findMany({
      where: { isWine: true, sectionSource: "ai", NOT: { extraData: { equals: Prisma.DbNull } } },
      select: { id: true, itemName: true, extraData: true },
      take: sampleN * 3,
      orderBy: { itemName: "asc" },
    });

    let shown = 0;
    for (const wine of sample) {
      const e = (wine.extraData ?? {}) as Record<string, unknown>;
      if (!Array.isArray(e.flavors)) continue;
      console.log("\n---", wine.itemName, `(${wine.id})`);
      console.log("  wine_type:", e.wine_type);
      console.log("  taste_summary:", e.taste_summary);
      console.log("  flavors:", JSON.stringify(e.flavors));
      console.log("  scales:", {
        body: e.body,
        acidity: e.acidity,
        tannin: e.tannin,
        sweetness: e.sweetness,
        fruity_earthy: e.fruity_earthy,
        crisp_creamy: e.crisp_creamy,
      });
      shown += 1;
      if (shown >= sampleN) break;
    }
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
