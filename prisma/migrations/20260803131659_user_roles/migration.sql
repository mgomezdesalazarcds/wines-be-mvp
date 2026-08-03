-- CreateEnum
CREATE TYPE "Role" AS ENUM ('SUPER_ADMIN', 'ADMIN');

-- AlterTable: add role with a temporary default, backfill from the old
-- boolean, then drop the boolean. Existing super admins keep their status
-- instead of silently becoming company admins.
ALTER TABLE "users" ADD COLUMN "role" "Role" NOT NULL DEFAULT 'ADMIN';

UPDATE "users" SET "role" = 'SUPER_ADMIN' WHERE "is_super_admin" = true;

ALTER TABLE "users" DROP COLUMN "is_super_admin";
