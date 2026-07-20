/*
  Warnings:

  - You are about to drop the column `size` on the `company_wines` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "company_wines" DROP COLUMN "size";

-- AlterTable
ALTER TABLE "wines" ADD COLUMN     "size" TEXT;
