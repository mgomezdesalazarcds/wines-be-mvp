import "../src/env";
import fs from "fs";
import path from "path";
import { prisma } from "../src/lib/db";
import { cleanField, parsePrice, isLikelyWine, normalizeSize } from "../src/lib/wine-classifier";
import { findExistingWine } from "../src/lib/wine-matcher";

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

async function main() {
  const slugArg = process.argv[2];
  const csvArg = process.argv[3];

  if (!slugArg || !csvArg) {
    console.error("Usage: npm run import -- <company-slug> /path/to/inventory.csv");
    process.exit(1);
  }

  const company = await prisma.company.findUnique({ where: { slug: slugArg } });
  if (!company) {
    console.error(`No company with slug "${slugArg}". Create it first (see prisma/seed.ts).`);
    process.exit(1);
  }

  const csvPath = path.isAbsolute(csvArg) ? csvArg : path.resolve(process.cwd(), csvArg);
  if (!fs.existsSync(csvPath)) {
    console.error(`CSV not found: ${csvPath}`);
    process.exit(1);
  }

  console.log(`Importing "${csvPath}" for company "${company.name}"...`);
  const rows = parseCsv(fs.readFileSync(csvPath, "utf-8"));
  console.log(`Total rows: ${rows.length}`);

  let created = 0;
  let reused = 0;

  for (const row of rows) {
    const itemName = cleanField(row.item_name);
    const size = normalizeSize(row.size);
    const lookupCode = cleanField(row.lookup_code);
    if (!itemName || !lookupCode) continue;

    const isWine = isLikelyWine(itemName, cleanField(row.size));
    const price = parsePrice(row.price);
    const stockCount = parseInt(cleanField(row.stock_count), 10) || 0;
    const availability = cleanField(row.availability) || null;

    let wineId: string;
    const existing = await findExistingWine(itemName, size);
    if (existing) {
      wineId = existing.id;
      reused++;
    } else {
      const wine = await prisma.wine.create({
        data: { itemName, size, isWine, section: null, sectionSource: "heuristic" },
      });
      wineId = wine.id;
      created++;
    }

    await prisma.companyWine.upsert({
      where: { companyId_lookupCode: { companyId: company.id, lookupCode } },
      update: { wineId, price, stockCount, availability },
      create: { companyId: company.id, wineId, lookupCode, price, stockCount, availability },
    });
  }

  console.log(`Done. ${created} new generic wines created, ${reused} matched to existing wines.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
