-- CreateTable
CREATE TABLE "metafield_sync_queue" (
    "id" SERIAL NOT NULL,
    "product_id" TEXT NOT NULL,
    "handles" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error_msg" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "metafield_sync_queue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "metafield_sync_queue_status_idx" ON "metafield_sync_queue"("status");
