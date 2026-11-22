-- AlterTable
ALTER TABLE "media_asset" ALTER COLUMN "uploadedById" DROP NOT NULL;

-- AlterTable
ALTER TABLE "outbound_message" ADD COLUMN     "claimedAt" TIMESTAMP(3),
ADD COLUMN     "deliveryDetail" TEXT,
ADD COLUMN     "deliveryStatus" TEXT,
ADD COLUMN     "deliveryUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "idempotencyScope" TEXT;

-- CreateIndex
CREATE INDEX "outbound_message_channel_providerMessageId_idx" ON "outbound_message"("channel", "providerMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "outbound_message_idempotencyScope_idempotencyKey_key" ON "outbound_message"("idempotencyScope", "idempotencyKey");

