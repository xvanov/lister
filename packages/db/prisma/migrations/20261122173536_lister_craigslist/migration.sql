-- AlterTable
ALTER TABLE "listing" ADD COLUMN     "platformOptions" JSONB,
ADD COLUMN     "postedAt" TIMESTAMP(3),
ADD COLUMN     "renewedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "seller_account" ADD COLUMN     "settings" JSONB;
