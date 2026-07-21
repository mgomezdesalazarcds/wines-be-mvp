import "../src/env";
import { randomUUID } from "crypto";
import { Client } from "pg";
import { Prisma } from "@prisma/client";
import { prisma } from "../src/lib/db";

/** One-time migration from the old single-tenant `wines` table
 * (wines-be-node) into the new Company / Wine / CompanyWine schema.
 *
 * This is a straight 1:1 copy, not the fuzzy-dedup import path
 * (scripts/import-csv.ts) — every legacy row becomes exactly one new Wine,
 * since it's a single company's own catalog being reshaped, not several
 * companies' catalogs being merged. Reuses each row's already-generated
 * `extra_data` as-is — does not call Gemini again.
 */

interface LegacyWineRow {
  lookup_code: string;
  item_name: string;
  price: number;
  size: string | null;
  stock_count: number | null;
  availability: string | null;
  is_wine: boolean;
  section: string | null;
  section_source: string;
  staff_pick: boolean;
  extra_data: unknown;
  image_url: string | null;
  created_at: Date;
}

const CHUNK_SIZE = 500;

async function main() {
  const slugArg = process.argv[2];
  const legacyUrl = process.env.LEGACY_DATABASE_URL;

  if (!slugArg || !legacyUrl) {
    console.error("Usage: LEGACY_DATABASE_URL=... npm run migrate-legacy -- <company-slug>");
    process.exit(1);
  }

  const company = await prisma.company.findUnique({ where: { slug: slugArg } });
  if (!company) {
    console.error(`No company with slug "${slugArg}". Create it first (see prisma/seed.ts).`);
    process.exit(1);
  }

  const legacyClient = new Client({ connectionString: legacyUrl });
  await legacyClient.connect();

  const { rows } = await legacyClient.query<LegacyWineRow>(`
    SELECT lookup_code, item_name, price, size, stock_count, availability,
           is_wine, section, section_source, staff_pick, extra_data,
           image_url, created_at
    FROM wines
  `);
  await legacyClient.end();

  console.log(`Read ${rows.length} rows from the legacy database.`);

  const existing = await prisma.companyWine.findMany({
    where: { companyId: company.id },
    select: { lookupCode: true },
  });
  const alreadyMigrated = new Set(existing.map((r) => r.lookupCode));
  const toMigrate = rows.filter((r) => !alreadyMigrated.has(r.lookup_code));
  console.log(`${rows.length - toMigrate.length} already migrated, ${toMigrate.length} to go.`);

  let migrated = 0;
  for (let i = 0; i < toMigrate.length; i += CHUNK_SIZE) {
    const chunk = toMigrate.slice(i, i + CHUNK_SIZE);

    const wineValues = chunk.map((r) => {
      const wineId = randomUUID();
      (r as LegacyWineRow & { _wineId: string })._wineId = wineId;
      return Prisma.sql`(
        ${wineId}, ${r.item_name}, ${r.size}, ${r.is_wine}, ${r.section},
        ${r.section_source}, ${JSON.stringify(r.extra_data)}::jsonb, ${r.created_at}
      )`;
    });

    const companyWineValues = chunk.map((r) => {
      const wineId = (r as LegacyWineRow & { _wineId: string })._wineId;
      return Prisma.sql`(
        ${randomUUID()}, ${company.id}, ${wineId}, ${r.lookup_code}, ${r.price},
        ${r.stock_count}, ${r.availability}, ${r.staff_pick}, ${r.image_url}, ${r.created_at}
      )`;
    });

    // Both inserts succeed or neither does — otherwise a crash mid-chunk
    // would leave `wines` rows with no `company_wines` row pointing at them.
    await prisma.$transaction([
      prisma.$executeRaw`
        INSERT INTO wines (id, item_name, size, is_wine, section, section_source, extra_data, created_at)
        VALUES ${Prisma.join(wineValues)}
      `,
      prisma.$executeRaw`
        INSERT INTO company_wines (id, company_id, wine_id, lookup_code, price, stock_count, availability, staff_pick, image_url, created_at)
        VALUES ${Prisma.join(companyWineValues)}
      `,
    ]);

    migrated += chunk.length;
    console.log(`Migrated ${migrated}/${toMigrate.length}`);
  }

  console.log("Done.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
