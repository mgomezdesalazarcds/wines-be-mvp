import "../src/env";
import { PrismaClient, Prisma } from "@prisma/client";

const prisma = new PrismaClient();

/** Shape the AI enrichment pipeline produces — same as wines-be-node's
 * EnrichmentData. Stored as-is in `Wine.extraData`; a company only writes to
 * `CompanyWine.extraData` once it edits its own copy. */
interface EnrichmentData {
  tasting_notes: string;
  taste_profile: string[];
  pairs_well_with: string[];
  variety: string | null;
  region: string | null;
  country: string | null;
  body: number;
  acidity: number;
  tannin: number;
  sweetness: number;
  dryness_label: string;
  why_we_love_it: string;
  from_the_team: string;
  provenance: "verified" | "inferred";
}

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

  const wines: { itemName: string; lookupCode: string; price: number; staffPick: boolean; extraData: EnrichmentData }[] = [
    {
      itemName: "Cecchi Chianti D.O.C.G.",
      lookupCode: "86891083872",
      price: 22.99,
      staffPick: true,
      extraData: {
        tasting_notes:
          "Bright cherry and red plum with a savory, herbal edge and firm, food-friendly acidity.",
        taste_profile: ["Cherry", "Herb", "Earth"],
        pairs_well_with: ["Pasta", "Pizza", "Grilled meats"],
        variety: "Sangiovese",
        region: "Tuscany",
        country: "Italy",
        body: 3,
        acidity: 4,
        tannin: 3,
        sweetness: 1,
        dryness_label: "Dry",
        why_we_love_it: "A classic Chianti that overdelivers for the price.",
        from_the_team: "Our go-to bottle for weeknight pasta.",
        provenance: "verified",
      },
    },
    {
      itemName: "Banfi Brunello di Montalcino",
      lookupCode: "87199000123",
      price: 87.99,
      staffPick: true,
      extraData: {
        tasting_notes:
          "Rich dark fruit, dried rose, and leather, with structured tannin built to age.",
        taste_profile: ["Dark fruit", "Leather", "Rose"],
        pairs_well_with: ["Steak", "Aged cheese", "Braised short rib"],
        variety: "Sangiovese Grosso",
        region: "Tuscany",
        country: "Italy",
        body: 5,
        acidity: 3,
        tannin: 5,
        sweetness: 1,
        dryness_label: "Dry",
        why_we_love_it: "A special-occasion bottle that always impresses.",
        from_the_team: "Worth decanting an hour before you pour it.",
        provenance: "verified",
      },
    },
  ];

  for (const w of wines) {
    const existing = await prisma.companyWine.findUnique({
      where: { companyId_lookupCode: { companyId: company.id, lookupCode: w.lookupCode } },
    });
    if (existing) continue;

    const wine = await prisma.wine.create({
      data: {
        itemName: w.itemName,
        extraData: w.extraData as unknown as Prisma.InputJsonValue,
      },
    });

    await prisma.companyWine.create({
      data: {
        companyId: company.id,
        wineId: wine.id,
        lookupCode: w.lookupCode,
        price: w.price,
        isWine: true,
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
