/*
  Warnings:

  - You are about to drop the column `is_wine` on the `company_wines` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "company_wines" DROP COLUMN "is_wine";

-- AlterTable
ALTER TABLE "wines" ADD COLUMN     "is_wine" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "section" TEXT,
ADD COLUMN     "section_source" TEXT NOT NULL DEFAULT 'heuristic';

-- CreateIndex
CREATE INDEX "idx_wines_section" ON "wines"("section");
