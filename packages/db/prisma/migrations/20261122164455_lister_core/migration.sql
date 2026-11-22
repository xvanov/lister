-- CreateEnum
CREATE TYPE "Platform" AS ENUM ('FACEBOOK', 'CRAIGSLIST');

-- CreateEnum
CREATE TYPE "SellerAccountStatus" AS ENUM ('NEEDS_LOGIN', 'READY', 'PAUSED');

-- CreateEnum
CREATE TYPE "ListingStatus" AS ENUM ('QUEUED', 'POSTING', 'LIVE', 'DRY_RUN_OK', 'FAILED', 'SOLD', 'REMOVED');

-- CreateTable
CREATE TABLE "seller_account" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "label" TEXT NOT NULL,
    "externalAccountId" TEXT NOT NULL,
    "status" "SellerAccountStatus" NOT NULL DEFAULT 'NEEDS_LOGIN',
    "liveMode" BOOLEAN NOT NULL DEFAULT false,
    "headless" BOOLEAN NOT NULL DEFAULT true,
    "profileName" TEXT,
    "lastCheckedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "seller_account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "listing" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "refSystem" TEXT NOT NULL,
    "refKind" TEXT NOT NULL,
    "refId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "priceCents" INTEGER NOT NULL,
    "category" TEXT NOT NULL,
    "condition" TEXT NOT NULL,
    "location" TEXT,
    "photoIds" TEXT[],
    "callbackUrl" TEXT,
    "apiClientName" TEXT,
    "status" "ListingStatus" NOT NULL DEFAULT 'QUEUED',
    "pendingAction" TEXT,
    "platformListingId" TEXT,
    "url" TEXT,
    "lastError" TEXT,
    "screenshotKeys" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "listing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_client" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "keyPrefix" TEXT NOT NULL,
    "scopes" TEXT[],
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_delivery" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "responseStatus" INTEGER,
    "lastError" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_delivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "seller_account_organizationId_createdAt_idx" ON "seller_account"("organizationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "seller_account_organizationId_platform_externalAccountId_key" ON "seller_account"("organizationId", "platform", "externalAccountId");

-- CreateIndex
CREATE INDEX "listing_organizationId_updatedAt_idx" ON "listing"("organizationId", "updatedAt");

-- CreateIndex
CREATE INDEX "listing_organizationId_refSystem_refKind_refId_idx" ON "listing"("organizationId", "refSystem", "refKind", "refId");

-- CreateIndex
CREATE UNIQUE INDEX "listing_accountId_refSystem_refKind_refId_key" ON "listing"("accountId", "refSystem", "refKind", "refId");

-- CreateIndex
CREATE UNIQUE INDEX "api_client_keyHash_key" ON "api_client"("keyHash");

-- CreateIndex
CREATE INDEX "api_client_organizationId_createdAt_idx" ON "api_client"("organizationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_delivery_eventId_key" ON "webhook_delivery"("eventId");

-- CreateIndex
CREATE INDEX "webhook_delivery_organizationId_createdAt_idx" ON "webhook_delivery"("organizationId", "createdAt");

-- AddForeignKey
ALTER TABLE "seller_account" ADD CONSTRAINT "seller_account_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listing" ADD CONSTRAINT "listing_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listing" ADD CONSTRAINT "listing_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "seller_account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_client" ADD CONSTRAINT "api_client_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_delivery" ADD CONSTRAINT "webhook_delivery_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_delivery" ADD CONSTRAINT "webhook_delivery_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "listing"("id") ON DELETE CASCADE ON UPDATE CASCADE;
