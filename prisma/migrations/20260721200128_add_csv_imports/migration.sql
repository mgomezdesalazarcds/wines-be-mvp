-- CreateTable
CREATE TABLE "csv_imports" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "total_rows" INTEGER NOT NULL,
    "created_count" INTEGER NOT NULL,
    "reused_count" INTEGER NOT NULL,
    "updated_count" INTEGER NOT NULL,
    "skipped_count" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "csv_imports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "csv_imports_company_id_idx" ON "csv_imports"("company_id");
