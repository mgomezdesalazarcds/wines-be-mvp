-- AlterTable
ALTER TABLE "company_wines" ADD COLUMN "is_holiday_pick" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "company_wines" ADD COLUMN "holiday_category" TEXT;

-- CreateIndex
CREATE INDEX "idx_company_wines_holiday" ON "company_wines"("company_id", "is_holiday_pick");
