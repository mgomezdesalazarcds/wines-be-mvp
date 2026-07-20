-- CreateTable
CREATE TABLE "companies" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "logo_url" TEXT,
    "slug" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "companies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wines" (
    "id" TEXT NOT NULL,
    "item_name" TEXT NOT NULL,
    "variety" TEXT,
    "region" TEXT,
    "country" TEXT,
    "tasting_notes" TEXT,
    "taste_profile" TEXT[],
    "pairs_well_with" TEXT[],
    "body" INTEGER,
    "acidity" INTEGER,
    "tannin" INTEGER,
    "sweetness" INTEGER,
    "dryness_label" TEXT,
    "provenance" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_wines" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "wine_id" TEXT NOT NULL,
    "lookup_code" TEXT NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "size" TEXT,
    "stock_count" INTEGER,
    "availability" TEXT,
    "is_wine" BOOLEAN NOT NULL DEFAULT false,
    "staff_pick" BOOLEAN NOT NULL DEFAULT false,
    "image_url" TEXT,
    "why_we_love_it" TEXT,
    "from_the_team" TEXT,
    "extra_data" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "company_wines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "companies_slug_key" ON "companies"("slug");

-- CreateIndex
CREATE INDEX "idx_wines_name" ON "wines"("item_name");

-- CreateIndex
CREATE INDEX "idx_company_wines_staff" ON "company_wines"("company_id", "staff_pick");

-- CreateIndex
CREATE UNIQUE INDEX "company_wines_company_id_lookup_code_key" ON "company_wines"("company_id", "lookup_code");

-- AddForeignKey
ALTER TABLE "company_wines" ADD CONSTRAINT "company_wines_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_wines" ADD CONSTRAINT "company_wines_wine_id_fkey" FOREIGN KEY ("wine_id") REFERENCES "wines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
