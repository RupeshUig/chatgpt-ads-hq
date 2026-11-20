-- AlterTable
ALTER TABLE "AdsConnection" ADD COLUMN     "conversionKeyLast4" TEXT,
ADD COLUMN     "encryptedConversionKey" TEXT,
ADD COLUMN     "pixelId" TEXT;

-- CreateTable
CREATE TABLE "ConversionSendLog" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventName" TEXT NOT NULL DEFAULT 'order_created',
    "status" TEXT NOT NULL,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "hasClickId" BOOLEAN NOT NULL DEFAULT false,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversionSendLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ConversionSendLog_shopId_eventId_idx" ON "ConversionSendLog"("shopId", "eventId");

-- CreateIndex
CREATE INDEX "ConversionSendLog_shopId_status_idx" ON "ConversionSendLog"("shopId", "status");

-- CreateIndex
CREATE INDEX "ConversionSendLog_shopId_sentAt_idx" ON "ConversionSendLog"("shopId", "sentAt");

-- AddForeignKey
ALTER TABLE "ConversionSendLog" ADD CONSTRAINT "ConversionSendLog_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
