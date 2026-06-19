-- CreateTable
CREATE TABLE "sku_to_handle" (
    "sku" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "title" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sku_to_handle_pkey" PRIMARY KEY ("sku")
);
