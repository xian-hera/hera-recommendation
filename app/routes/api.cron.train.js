/**
 * Cron job endpoint for automated incremental training
 * Called weekly by Render Cron Job
 * Protected by CRON_SECRET token
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export const action = async ({ request }) => {
  // Verify secret token
  const authHeader = request.headers.get("Authorization");
  const token = authHeader?.replace("Bearer ", "");

  // eslint-disable-next-line no-undef
  if (!token || token !== process.env.CRON_SECRET) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startTime = Date.now();

  try {
    // Get Shopify session for the store
    const session = await prisma.session.findFirst({
      where: { isOnline: false },
      orderBy: { expires: "desc" },
    });

    if (!session) {
      return Response.json(
        { error: "No valid session found. Please reinstall the app." },
        { status: 500 }
      );
    }

    // Import Shopify API
    const { shopifyApp } = await import("../shopify.server.js");
    const { admin } = await shopifyApp.unauthenticated.admin(session.shop);

    // Run incremental training with 7-day lookback
    const sinceDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const { runIncrementalTraining } = await import("../lib/train-incremental.server.js");
    const result = await runIncrementalTraining(admin, sinceDate, false);

    return Response.json({
      ...result,
      duration: Date.now() - startTime,
    });
  } catch (err) {
    console.error("Cron training failed:", err);
    return Response.json(
      { error: err.message, duration: Date.now() - startTime },
      { status: 500 }
    );
  }
};