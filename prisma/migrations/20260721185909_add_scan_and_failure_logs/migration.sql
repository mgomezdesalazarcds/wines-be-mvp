-- DropIndex
DROP INDEX "idx_wines_item_name_trgm";

-- CreateTable
CREATE TABLE "scan_logs" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "extracted_text" TEXT,
    "matched_lookup_code" TEXT,
    "confidence" DOUBLE PRECISION,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scan_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "failure_logs" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "context" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "failure_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "scan_logs_company_id_idx" ON "scan_logs"("company_id");

-- CreateIndex
CREATE INDEX "failure_logs_company_id_source_idx" ON "failure_logs"("company_id", "source");
