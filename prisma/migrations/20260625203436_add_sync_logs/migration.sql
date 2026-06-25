-- CreateTable
CREATE TABLE "sync_logs" (
    "id" SERIAL NOT NULL,
    "triggered_by" TEXT NOT NULL,
    "products_count" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL,
    "duration_ms" INTEGER,
    "error_msg" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_logs_pkey" PRIMARY KEY ("id")
);
