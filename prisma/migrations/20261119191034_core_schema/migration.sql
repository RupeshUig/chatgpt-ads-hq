-- CreateEnum
CREATE TYPE "Plan" AS ENUM ('FREE', 'PRO', 'SCALE');

-- CreateEnum
CREATE TYPE "AdsConnectionStatus" AS ENUM ('PENDING', 'CONNECTED', 'ERROR', 'DISCONNECTED');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('SYNCED', 'REJECTED', 'EXCLUDED', 'PENDING');

-- CreateEnum
CREATE TYPE "InsightLevel" AS ENUM ('ACCOUNT', 'CAMPAIGN', 'AD_GROUP', 'AD', 'PRODUCT');

-- CreateEnum
CREATE TYPE "RuleStatus" AS ENUM ('ACTIVE', 'PAUSED', 'DISABLED');

-- CreateEnum
CREATE TYPE "AlertSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- CreateTable
CREATE TABLE "Shop" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "plan" "Plan" NOT NULL DEFAULT 'FREE',
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uninstalledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Shop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdsConnection" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "adAccountId" TEXT,
    "encryptedApiKey" TEXT NOT NULL,
    "keyLast4" TEXT NOT NULL,
    "status" "AdsConnectionStatus" NOT NULL DEFAULT 'PENDING',
    "lastCheckedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdsConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "shopifyProductId" TEXT NOT NULL,
    "shopifyVariantId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "priceMinor" INTEGER NOT NULL,
    "costMinor" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "syncStatus" "SyncStatus" NOT NULL DEFAULT 'PENDING',
    "rejectReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyInsight" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "level" "InsightLevel" NOT NULL,
    "entityId" TEXT NOT NULL,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "spendMinor" INTEGER NOT NULL DEFAULT 0,
    "conversions" INTEGER NOT NULL DEFAULT 0,
    "conversionValueMinor" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DailyInsight_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Rule" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ruleType" TEXT NOT NULL,
    "status" "RuleStatus" NOT NULL DEFAULT 'ACTIVE',
    "conditions" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Alert" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "severity" "AlertSeverity" NOT NULL DEFAULT 'INFO',
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Alert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Shop_shopDomain_key" ON "Shop"("shopDomain");

-- CreateIndex
CREATE INDEX "Shop_shopDomain_idx" ON "Shop"("shopDomain");

-- CreateIndex
CREATE UNIQUE INDEX "AdsConnection_shopId_key" ON "AdsConnection"("shopId");

-- CreateIndex
CREATE INDEX "AdsConnection_shopId_idx" ON "AdsConnection"("shopId");

-- CreateIndex
CREATE INDEX "Product_shopId_idx" ON "Product"("shopId");

-- CreateIndex
CREATE INDEX "Product_shopId_syncStatus_idx" ON "Product"("shopId", "syncStatus");

-- CreateIndex
CREATE UNIQUE INDEX "Product_shopId_shopifyVariantId_key" ON "Product"("shopId", "shopifyVariantId");

-- CreateIndex
CREATE INDEX "DailyInsight_shopId_date_idx" ON "DailyInsight"("shopId", "date");

-- CreateIndex
CREATE INDEX "DailyInsight_shopId_level_idx" ON "DailyInsight"("shopId", "level");

-- CreateIndex
CREATE UNIQUE INDEX "DailyInsight_shopId_date_level_entityId_key" ON "DailyInsight"("shopId", "date", "level", "entityId");

-- CreateIndex
CREATE INDEX "Rule_shopId_idx" ON "Rule"("shopId");

-- CreateIndex
CREATE INDEX "Alert_shopId_isRead_idx" ON "Alert"("shopId", "isRead");

-- CreateIndex
CREATE INDEX "Alert_shopId_createdAt_idx" ON "Alert"("shopId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_shopId_createdAt_idx" ON "AuditLog"("shopId", "createdAt");

-- AddForeignKey
ALTER TABLE "AdsConnection" ADD CONSTRAINT "AdsConnection_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyInsight" ADD CONSTRAINT "DailyInsight_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Rule" ADD CONSTRAINT "Rule_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
