import "../src/env";
import fs from "fs";
import path from "path";
import { prisma } from "../src/lib/db";
import { importCsvForCompany } from "../src/lib/csv-import";

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
  const csvContent = fs.readFileSync(csvPath, "utf-8");
  const summary = await importCsvForCompany(company.id, csvContent);

  console.log(
    `Done. ${summary.totalRows} rows — ${summary.updated} existing SKUs updated, ` +
      `${summary.created} new generic wines created, ${summary.reused} new SKUs matched to ` +
      `existing wines, ${summary.skipped} skipped (missing name/code).`
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
