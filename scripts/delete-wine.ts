import "../src/env";
import { prisma } from "../src/lib/db";

async function main() {
  const lookupCode = process.argv[2];
  if (!lookupCode) {
    console.error("Usage: npm run delete-wine -- <lookup-code>");
    process.exit(1);
  }

  const companyWines = await prisma.companyWine.findMany({ where: { lookupCode } });
  if (companyWines.length === 0) {
    console.error(`No company_wines row with lookup_code "${lookupCode}".`);
    process.exit(1);
  }

  for (const cw of companyWines) {
    const otherListings = await prisma.companyWine.count({
      where: { wineId: cw.wineId, id: { not: cw.id } },
    });
    await prisma.companyWine.delete({ where: { id: cw.id } });
    if (otherListings === 0) {
      await prisma.wine.delete({ where: { id: cw.wineId } });
    }
    console.log(`Deleted company_wines row ${cw.id} (wine_id ${cw.wineId})${otherListings === 0 ? " and its wines row" : ""}.`);
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
