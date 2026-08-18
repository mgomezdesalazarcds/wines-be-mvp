import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { cleanField, parsePrice, isLikelyWine, normalizeSize } from "./wine-classifier";
import { findExistingWine } from "./wine-matcher";
import { classifyAndEnrichPendingWines } from "./enrichment";

// Measured: a single companyWine.update() over this Supabase project's
// pooler averages ~1.1s/row — 35,979 rows sequentially would take ~11
// hours. Batching many rows into one UPDATE...FROM(VALUES...) statement
// turns that into one round-trip per chunk instead of one per row.
// Postgres's real limit is 32,767 bind params per statement (confirmed by
// hitting it at chunk size 9000 => 36,000 params); 4 params/row caps this
// around 8,191 — stay comfortably under that.
const UPDATE_CHUNK_SIZE = 8000;

interface CsvRow {
  lookup_code: string;
  item_name: string;
  price: string;
  sale: string;
  size: string;
  stock_count: string;
  availability: string;
  staff_pick: string;
  is_last_arrival: string;
}

function parseCsvLine(line: string, delimiter: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === delimiter && !inQuotes) {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

/** Spreadsheet apps set to a Spanish/European locale (comma as the decimal
 * separator) export CSVs with ";" instead of ",", which silently breaks a
 * comma-only parser — every column ends up concatenated into one, so every
 * row fails the lookup_code/item_name check and gets skipped with no
 * obvious error. Pick whichever delimiter actually splits the header into
 * more than one field. */
function detectDelimiter(headerLine: string): string {
  const commaCount = (headerLine.match(/,/g) ?? []).length;
  const semicolonCount = (headerLine.match(/;/g) ?? []).length;
  return semicolonCount > commaCount ? ";" : ",";
}

function parseCsv(content: string): { rows: CsvRow[]; headers: string[] } {
  const lines = content.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0) return { rows: [], headers: [] };
  const delimiter = detectDelimiter(lines[0]);
  const headers = parseCsvLine(lines[0], delimiter).map((h) => cleanField(h).toLowerCase());
  const rows: CsvRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvLine(lines[i], delimiter);
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => {
      row[h] = values[idx] ?? "";
    });
    rows.push(row as unknown as CsvRow);
  }

  return { rows, headers };
}

export interface ImportSummary {
  totalRows: number;
  created: number;
  reused: number;
  updated: number;
  unchanged: number;
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
  sale: number | null;
  stockCount: number;
  availability: string | null;
  staffPick: boolean;
  isLastArrival: boolean;
}

export async function importCsvForCompany(
  companyId: string,
  csvContent: string
): Promise<ImportSummary> {
  const importStartedAt = Date.now();

  const parseStartedAt = Date.now();
  const { rows: rawRows, headers } = parseCsv(csvContent);
  // staff_pick is opt-in per file: the regular inventory export doesn't
  // include it, and treating a missing column as "false" would wipe out
  // every curated staff pick on the next routine re-import. Only a CSV
  // that explicitly has the column can change it.
  const hasStaffPickColumn = headers.includes("staff_pick");
  const hasLastArrivalColumn = headers.includes("is_last_arrival");
  console.log(`CSV import timing: parse took ${Date.now() - parseStartedAt}ms (${rawRows.length} rows)`);

  const lookupFetchStartedAt = Date.now();
  const existingRows = await prisma.companyWine.findMany({
    where: { companyId },
    select: {
      lookupCode: true,
      price: true,
      sale: true,
      stockCount: true,
      availability: true,
      staffPick: true,
      isLastArrival: true,
    },
  });
  const existingByLookupCode = new Map(existingRows.map((r) => [r.lookupCode, r]));
  console.log(`CSV import timing: existing lookup codes fetch took ${Date.now() - lookupFetchStartedAt}ms (${existingByLookupCode.size} codes)`);

  let skipped = 0;
  let unchanged = 0;
  const toUpdate: ParsedRow[] = [];
  const toCreate: ParsedRow[] = [];

  for (const row of rawRows) {
    const itemName = cleanField(row.item_name);
    const lookupCode = cleanField(row.lookup_code);
    if (!itemName || !lookupCode) {
      skipped++;
      continue;
    }

    const saleValue = parsePrice(row.sale);

    const parsed: ParsedRow = {
      lookupCode,
      itemName,
      size: normalizeSize(row.size),
      price: parsePrice(row.price),
      sale: saleValue > 0 ? saleValue : null,
      stockCount: parseInt(cleanField(row.stock_count), 10) || 0,
      availability: cleanField(row.availability) || null,
      staffPick: cleanField(row.staff_pick).toUpperCase() === "YES",
      isLastArrival: cleanField(row.is_last_arrival).toUpperCase() === "YES",
    };

    const existing = existingByLookupCode.get(lookupCode);
    if (!existing) {
      toCreate.push(parsed);
      continue;
    }

    // Only the columns this CSV actually has can have changed — comparing
    // a field it doesn't include would flag every row as "changed" just
    // because staffPick/isLastArrival parsed to false by default.
    const changed =
      existing.price !== parsed.price ||
      existing.sale !== parsed.sale ||
      existing.stockCount !== parsed.stockCount ||
      existing.availability !== parsed.availability ||
      (hasStaffPickColumn && existing.staffPick !== parsed.staffPick) ||
      (hasLastArrivalColumn && existing.isLastArrival !== parsed.isLastArrival);

    if (changed) {
      toUpdate.push(parsed);
    } else {
      unchanged++;
    }
  }

  // Already-known SKUs: one UPDATE...FROM(VALUES...) per chunk instead of
  // one round-trip per row (see UPDATE_CHUNK_SIZE above for why). The
  // optional columns (staff_pick, is_last_arrival) are only included in the
  // VALUES tuple/SET clause when the CSV actually has that header — see the
  // hasStaffPickColumn comment above for why.
  const updateColumns = [
    "lookup_code",
    "price",
    "sale",
    "stock_count",
    "availability",
    ...(hasStaffPickColumn ? ["staff_pick"] : []),
    ...(hasLastArrivalColumn ? ["is_last_arrival"] : []),
  ];
  const setClause = Prisma.join(
    updateColumns.filter((c) => c !== "lookup_code").map((c) => Prisma.raw(`${c} = v.${c}`)),
    ", "
  );
  const columnList = Prisma.raw(updateColumns.join(", "));

  const updateStartedAt = Date.now();
  for (let i = 0; i < toUpdate.length; i += UPDATE_CHUNK_SIZE) {
    const chunkStartedAt = Date.now();
    const chunk = toUpdate.slice(i, i + UPDATE_CHUNK_SIZE);
    const values = chunk.map((r) => {
      const tuple = [
        Prisma.sql`${r.lookupCode}`,
        Prisma.sql`${r.price}::float8`,
        Prisma.sql`${r.sale}::float8`,
        Prisma.sql`${r.stockCount}::int`,
        Prisma.sql`${r.availability}`,
        ...(hasStaffPickColumn ? [Prisma.sql`${r.staffPick}::boolean`] : []),
        ...(hasLastArrivalColumn ? [Prisma.sql`${r.isLastArrival}::boolean`] : []),
      ];
      return Prisma.sql`(${Prisma.join(tuple)})`;
    });
    await prisma.$executeRaw`
      UPDATE company_wines AS cw
      SET ${setClause}
      FROM (VALUES ${Prisma.join(values)}) AS v(${columnList})
      WHERE cw.company_id = ${companyId} AND cw.lookup_code = v.lookup_code
    `;
    console.log(`CSV import timing: update chunk ${i / UPDATE_CHUNK_SIZE + 1} (${chunk.length} rows) took ${Date.now() - chunkStartedAt}ms`);
  }
  console.log(`CSV import timing: all updates took ${Date.now() - updateStartedAt}ms total (${toUpdate.length} rows)`);

  // Genuinely new SKUs: still one at a time — each needs its own fuzzy
  // dedup decision against the generic catalog, which can't be batched the
  // same way. Normally a small set on a routine re-import.
  const createStartedAt = Date.now();
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
        sale: row.sale,
        stockCount: row.stockCount,
        availability: row.availability,
        staffPick: hasStaffPickColumn ? row.staffPick : false,
        isLastArrival: hasLastArrivalColumn ? row.isLastArrival : false,
      },
    });
  }
  console.log(`CSV import timing: new SKU creation took ${Date.now() - createStartedAt}ms total (${toCreate.length} rows)`);

  console.log(`CSV import timing: total import took ${Date.now() - importStartedAt}ms`);

  // Fire-and-forget: classifies section/is_wine and generates enrichment for
  // any wine still unreviewed by AI. Not awaited — this can take minutes at
  // Gemini's rate limits and the import response shouldn't wait on it (see
  // enrichment.ts for why it's still safe to just let it run in the
  // background of this same process).
  classifyAndEnrichPendingWines().catch((err) => {
    console.error("Classify/enrich pass failed:", err);
  });

  return { totalRows: rawRows.length, created, reused, updated: toUpdate.length, unchanged, skipped };
}
