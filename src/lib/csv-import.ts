import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { cleanField, parsePrice, isLikelyWine, normalizeSize } from "./wine-classifier";
import { findExistingWine } from "./wine-matcher";

// Measured: a single companyWine.update() over this Supabase project's
// pooler averages ~1.1s/row — 35,979 rows sequentially would take ~11
// hours. Batching many rows into one UPDATE...FROM(VALUES...) statement
// turns that into one round-trip per chunk instead of one per row.
const UPDATE_CHUNK_SIZE = 1000;

interface CsvRow {
  lookup_code: string;
  item_name: string;
  price: string;
  size: string;
  stock_count: string;
  availability: string;
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

function parseCsv(content: string): CsvRow[] {
  const lines = content.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0) return [];
  const headers = parseCsvLine(lines[0]).map((h) => cleanField(h).toLowerCase());
  const rows: CsvRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvLine(lines[i]);
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => {
      row[h] = values[idx] ?? "";
    });
    rows.push(row as unknown as CsvRow);
  }

  return rows;
}

export interface ImportSummary {
  totalRows: number;
  created: number;
  reused: number;
  updated: number;
  skipped: number;
}

/** Shared by the CLI script (scripts/import-csv.ts) and the admin upload
 * endpoint (routes/admin.ts) — same import behavior either way. See
 * scripts/import-csv.ts's git history for why existing SKUs skip the fuzzy
 * dedup instead of re-running it. */
interface ParsedRow {
  lookupCode: string;
  itemName: string;
  size: string | null;
  price: number;
  stockCount: number;
  availability: string | null;
}

export async function importCsvForCompany(
  companyId: string,
  csvContent: string
): Promise<ImportSummary> {
  const rawRows = parseCsv(csvContent);

  const existingRows = await prisma.companyWine.findMany({
    where: { companyId },
    select: { lookupCode: true },
  });
  const existingLookupCodes = new Set(existingRows.map((r) => r.lookupCode));

  let skipped = 0;
  const toUpdate: ParsedRow[] = [];
  const toCreate: ParsedRow[] = [];

  for (const row of rawRows) {
    const itemName = cleanField(row.item_name);
    const lookupCode = cleanField(row.lookup_code);
    if (!itemName || !lookupCode) {
      skipped++;
      continue;
    }

    const parsed: ParsedRow = {
      lookupCode,
      itemName,
      size: normalizeSize(row.size),
      price: parsePrice(row.price),
      stockCount: parseInt(cleanField(row.stock_count), 10) || 0,
      availability: cleanField(row.availability) || null,
    };

    (existingLookupCodes.has(lookupCode) ? toUpdate : toCreate).push(parsed);
  }

  // Already-known SKUs: one UPDATE...FROM(VALUES...) per chunk instead of
  // one round-trip per row (see UPDATE_CHUNK_SIZE above for why).
  for (let i = 0; i < toUpdate.length; i += UPDATE_CHUNK_SIZE) {
    const chunk = toUpdate.slice(i, i + UPDATE_CHUNK_SIZE);
    const values = chunk.map(
      (r) => Prisma.sql`(${r.lookupCode}, ${r.price}::float8, ${r.stockCount}::int, ${r.availability})`
    );
    await prisma.$executeRaw`
      UPDATE company_wines AS cw
      SET price = v.price, stock_count = v.stock_count, availability = v.availability
      FROM (VALUES ${Prisma.join(values)}) AS v(lookup_code, price, stock_count, availability)
      WHERE cw.company_id = ${companyId} AND cw.lookup_code = v.lookup_code
    `;
  }

  // Genuinely new SKUs: still one at a time — each needs its own fuzzy
  // dedup decision against the generic catalog, which can't be batched the
  // same way. Normally a small set on a routine re-import.
  let created = 0;
  let reused = 0;
  for (const row of toCreate) {
    const isWine = isLikelyWine(row.itemName, row.size ?? "");

    let wineId: string;
    const existingWine = await findExistingWine(row.itemName, row.size);
    if (existingWine) {
      wineId = existingWine.id;
      reused++;
    } else {
      const wine = await prisma.wine.create({
        data: { itemName: row.itemName, size: row.size, isWine, section: null, sectionSource: "heuristic" },
      });
      wineId = wine.id;
      created++;
    }

    await prisma.companyWine.create({
      data: {
        companyId,
        wineId,
        lookupCode: row.lookupCode,
        price: row.price,
        stockCount: row.stockCount,
        availability: row.availability,
      },
    });
  }

  return { totalRows: rawRows.length, created, reused, updated: toUpdate.length, skipped };
}
