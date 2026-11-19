-- AlterTable
ALTER TABLE "AdsConnection" ADD COLUMN     "encryptedSftpPassword" TEXT,
ADD COLUMN     "encryptedSftpPrivateKey" TEXT,
ADD COLUMN     "feedAccessMessage" TEXT,
ADD COLUMN     "feedAccessStatus" TEXT NOT NULL DEFAULT 'UNKNOWN',
ADD COLUMN     "feedId" TEXT,
ADD COLUMN     "lastFeedUploadAt" TIMESTAMP(3),
ADD COLUMN     "lastFeedUploadStatus" TEXT,
ADD COLUMN     "sftpHost" TEXT,
ADD COLUMN     "sftpPort" INTEGER DEFAULT 22,
ADD COLUMN     "sftpUsername" TEXT;

-- CreateTable
CREATE TABLE "FeedDelta" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "shopifyProductId" TEXT NOT NULL,
    "shopifyVariantId" TEXT NOT NULL,
    "priceMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "availability" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FeedDelta_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FeedDelta_shopId_status_idx" ON "FeedDelta"("shopId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "FeedDelta_shopId_shopifyVariantId_key" ON "FeedDelta"("shopId", "shopifyVariantId");

-- AddForeignKey
ALTER TABLE "FeedDelta" ADD CONSTRAINT "FeedDelta_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
