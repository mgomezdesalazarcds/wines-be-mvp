import "../src/env";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const company = await prisma.company.upsert({
    where: { slug: "little-bros" },
    update: {},
    create: {
      name: "Little Bros Beverage Outlet",
      slug: "little-bros",
      logoUrl: null,
    },
  });

  const wines = [
    {
      itemName: "Cecchi Chianti D.O.C.G.",
      variety: "Sangiovese",
      region: "Tuscany",
      country: "Italy",
      tastingNotes:
        "Bright cherry and red plum with a savory, herbal edge and firm, food-friendly acidity.",
      tasteProfile: ["Cherry", "Herb", "Earth"],
      pairsWellWith: ["Pasta", "Pizza", "Grilled meats"],
      body: 3,
      acidity: 4,
      tannin: 3,
      sweetness: 1,
      drynessLabel: "Dry",
      provenance: "verified",
      lookupCode: "86891083872",
      price: 22.99,
      staffPick: true,
      whyWeLoveIt: "A classic Chianti that overdelivers for the price.",
      fromTheTeam: "Our go-to bottle for weeknight pasta.",
    },
    {
      itemName: "Banfi Brunello di Montalcino",
      variety: "Sangiovese Grosso",
      region: "Tuscany",
      country: "Italy",
      tastingNotes:
        "Rich dark fruit, dried rose, and leather, with structured tannin built to age.",
      tasteProfile: ["Dark fruit", "Leather", "Rose"],
      pairsWellWith: ["Steak", "Aged cheese", "Braised short rib"],
      body: 5,
      acidity: 3,
      tannin: 5,
      sweetness: 1,
      drynessLabel: "Dry",
      provenance: "verified",
      lookupCode: "87199000123",
      price: 87.99,
      staffPick: true,
      whyWeLoveIt: "A special-occasion bottle that always impresses.",
      fromTheTeam: "Worth decanting an hour before you pour it.",
    },
  ];

  for (const w of wines) {
    const { lookupCode, price, staffPick, whyWeLoveIt, fromTheTeam, ...wineData } = w;

    const existing = await prisma.companyWine.findUnique({
      where: { companyId_lookupCode: { companyId: company.id, lookupCode } },
    });
    if (existing) continue;

    const wine = await prisma.wine.create({ data: wineData });

    await prisma.companyWine.create({
      data: {
        companyId: company.id,
        wineId: wine.id,
        lookupCode,
        price,
        isWine: true,
        staffPick,
        whyWeLoveIt,
        fromTheTeam,
      },
    });
  }

  console.log(`Seeded company "${company.name}" with ${wines.length} wines.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
