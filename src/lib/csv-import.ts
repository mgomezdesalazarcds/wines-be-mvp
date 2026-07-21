import { prisma } from "./db";
import { cleanField, parsePrice, isLikelyWine, normalizeSize } from "./wine-classifier";
import { findExistingWine } from "./wine-matcher";

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
export async function importCsvForCompany(
  companyId: string,
  csvContent: string
): Promise<ImportSummary> {
  const rows = parseCsv(csvContent);

  const existingRows = await prisma.companyWine.findMany({
    where: { companyId },
    select: { lookupCode: true },
  });
  const existingLookupCodes = new Set(existingRows.map((r) => r.lookupCode));

  let created = 0;
  let reused = 0;
  let updated = 0;
  let skipped = 0;

  for (const row of rows) {
    const itemName = cleanField(row.item_name);
    const size = normalizeSize(row.size);
    const lookupCode = cleanField(row.lookup_code);
    if (!itemName || !lookupCode) {
      skipped++;
      continue;
    }

    const price = parsePrice(row.price);
    const stockCount = parseInt(cleanField(row.stock_count), 10) || 0;
    const availability = cleanField(row.availability) || null;

    if (existingLookupCodes.has(lookupCode)) {
      await prisma.companyWine.update({
        where: { companyId_lookupCode: { companyId, lookupCode } },
        data: { price, stockCount, availability },
      });
      updated++;
      continue;
    }

    const isWine = isLikelyWine(itemName, cleanField(row.size));

    let wineId: string;
    const existingWine = await findExistingWine(itemName, size);
    if (existingWine) {
      wineId = existingWine.id;
      reused++;
    } else {
      const wine = await prisma.wine.create({
        data: { itemName, size, isWine, section: null, sectionSource: "heuristic" },
      });
      wineId = wine.id;
      created++;
    }

    await prisma.companyWine.create({
      data: { companyId, wineId, lookupCode, price, stockCount, availability },
    });
  }

  return { totalRows: rows.length, created, reused, updated, skipped };
}
