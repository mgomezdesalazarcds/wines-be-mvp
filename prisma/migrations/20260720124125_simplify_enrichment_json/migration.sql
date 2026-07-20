/*
  Warnings:

  - You are about to drop the column `from_the_team` on the `company_wines` table. All the data in the column will be lost.
  - You are about to drop the column `why_we_love_it` on the `company_wines` table. All the data in the column will be lost.
  - You are about to drop the column `acidity` on the `wines` table. All the data in the column will be lost.
  - You are about to drop the column `body` on the `wines` table. All the data in the column will be lost.
  - You are about to drop the column `country` on the `wines` table. All the data in the column will be lost.
  - You are about to drop the column `dryness_label` on the `wines` table. All the data in the column will be lost.
  - You are about to drop the column `pairs_well_with` on the `wines` table. All the data in the column will be lost.
  - You are about to drop the column `provenance` on the `wines` table. All the data in the column will be lost.
  - You are about to drop the column `region` on the `wines` table. All the data in the column will be lost.
  - You are about to drop the column `sweetness` on the `wines` table. All the data in the column will be lost.
  - You are about to drop the column `tannin` on the `wines` table. All the data in the column will be lost.
  - You are about to drop the column `taste_profile` on the `wines` table. All the data in the column will be lost.
  - You are about to drop the column `tasting_notes` on the `wines` table. All the data in the column will be lost.
  - You are about to drop the column `variety` on the `wines` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "company_wines" DROP COLUMN "from_the_team",
DROP COLUMN "why_we_love_it";

-- AlterTable
ALTER TABLE "wines" DROP COLUMN "acidity",
DROP COLUMN "body",
DROP COLUMN "country",
DROP COLUMN "dryness_label",
DROP COLUMN "pairs_well_with",
DROP COLUMN "provenance",
DROP COLUMN "region",
DROP COLUMN "sweetness",
DROP COLUMN "tannin",
DROP COLUMN "taste_profile",
DROP COLUMN "tasting_notes",
DROP COLUMN "variety",
ADD COLUMN     "extra_data" JSONB;
