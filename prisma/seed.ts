import "../src/env";
import { PrismaClient, Prisma } from "@prisma/client";
import type { EnrichmentData } from "../src/lib/enrichment-data";

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

  const wines: {
    itemName: string;
    size: string;
    section: string;
    lookupCode: string;
    price: number;
    staffPick: boolean;
    extraData: EnrichmentData;
  }[] = [
    {
      itemName: "Cecchi Chianti D.O.C.G.",
      size: "750ML",
      section: "italy",
      lookupCode: "SEED-CECCHI-001",
      price: 22.99,
      staffPick: true,
      extraData: {
        tasting_notes:
          "Bright cherry and red plum with a savory, herbal edge and firm, food-friendly acidity.",
        taste_summary:
          "Bright and savory, with ripe cherry, herbal notes and a food-friendly finish.",
        flavors: [
          { name: "Cherry", intensity: 3, family: "red_fruit" },
          { name: "Herb", intensity: 2, family: "herbal" },
          { name: "Earth", intensity: 1, family: "earth_mineral" },
        ],
        taste_profile: ["Cherry", "Herb", "Earth"],
        pairs_well_with: ["Pasta", "Pizza", "Grilled meats"],
        variety: "Sangiovese",
        region: "Tuscany",
        country: "Italy",
        wine_type: "red",
        body: 3,
        acidity: 4,
        tannin: 3,
        sweetness: 1,
        fruity_earthy: 2,
        crisp_creamy: 2,
        dryness_label: "Dry",
        why_we_love_it: "A classic Chianti that overdelivers for the price.",
        provenance: "verified",
      },
    },
    {
      itemName: "Banfi Brunello di Montalcino",
      size: "750ML",
      section: "italy",
      lookupCode: "SEED-BANFI-001",
      price: 87.99,
      staffPick: true,
      extraData: {
        tasting_notes:
          "Rich dark fruit, dried rose, and leather, with structured tannin built to age.",
        taste_summary:
          "Deep and structured, with dark fruit, dried rose and a firm, age-worthy finish.",
        flavors: [
          { name: "Dark Cherry", intensity: 3, family: "black_fruit" },
          { name: "Rose", intensity: 2, family: "floral" },
          { name: "Leather", intensity: 1, family: "earth_mineral" },
        ],
        taste_profile: ["Dark Cherry", "Rose", "Leather"],
        pairs_well_with: ["Steak", "Aged cheese", "Braised short rib"],
        variety: "Sangiovese Grosso",
        region: "Tuscany",
        country: "Italy",
        wine_type: "red",
        body: 5,
        acidity: 3,
        tannin: 5,
        sweetness: 1,
        fruity_earthy: 3,
        crisp_creamy: 3,
        dryness_label: "Dry",
        why_we_love_it: "A special-occasion bottle that always impresses.",
        provenance: "verified",
      },
    },
  ];

  for (const w of wines) {
    const existing = await prisma.companyWine.findUnique({
      where: { companyId_lookupCode: { companyId: company.id, lookupCode: w.lookupCode } },
    });
    if (existing) {
      // Keep local demos on the new Flavor Circles contract even if the
      // listing already exists from an older seed.
      await prisma.wine.update({
        where: { id: existing.wineId },
        data: { extraData: w.extraData as unknown as Prisma.InputJsonValue },
      });
      continue;
    }

    const wine = await prisma.wine.create({
      data: {
        itemName: w.itemName,
        size: w.size,
        isWine: true,
        section: w.section,
        sectionSource: "ai",
        extraData: w.extraData as unknown as Prisma.InputJsonValue,
      },
    });

    await prisma.companyWine.create({
      data: {
        companyId: company.id,
        wineId: wine.id,
        lookupCode: w.lookupCode,
        price: w.price,
        staffPick: w.staffPick,
        // extraData left null — this company hasn't customized its copy yet,
        // so reads fall back to the wine's AI-generated default.
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
