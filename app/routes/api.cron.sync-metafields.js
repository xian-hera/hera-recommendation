/**
 * Metafield sync cron endpoint
 * Called by Render Cron Job every 6 hours
 * Checks settings to decide whether to actually run
 * Processes ALL pending items from metafield_sync_queue per run
 * At 1 batch/sec (25 metafields/batch), 10000 items ≈ 7 minutes
 * Protected by CRON_SECRET token
 */

import { PrismaClient } from "@prisma/client";
import { unauthenticated } from "../shopify.server.js";

const prisma = new PrismaClient();
const METAFIELD_BATCH = 25;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function setMetafieldsBatch(admin, items) {
  const metafields = items.map((item) => ({
    ownerId: item.productId,
    namespace: "custom",
    key: "hera_recommendations",
    type: "json",
    value: JSON.stringify(item.handles),
  }));

  const response = await admin.graphql(`
    mutation setMetafields($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id }
        userErrors { field message }
      }
    }
  `, { variables: { metafields } });

  const data = await response.json();
  const errors = data.data?.metafieldsSet?.userErrors || [];
  if (errors.length > 0) {
    throw new Error(errors.map((e) => e.message).join(", "));
  }
  return data.data?.metafieldsSet?.metafields?.length || 0;
}

export const action = async ({ request }) => {
  const authHeader = request.headers.get("Authorization");
  const token = authHeader?.replace("Bearer ", "");

  // eslint-disable-next-line no-undef
  if (!token || token !== process.env.CRON_SECRET) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startTime = Date.now();
  const triggeredBy = request.headers.get("X-Triggered-By") || "cron";

  try {
    // Load settings
    const settingsRows = await prisma.setting.findMany();
    const settings = Object.fromEntries(settingsRows.map((s) => [s.key, s.value]));

    // If triggered by cron (not manual), check interval setting
    if (triggeredBy === "cron") {
      if (settings["auto_sync_enabled"] !== "true") {
        return Response.json({
          success: true,
          skipped: true,
          message: "Auto metafield sync is disabled.",
        });
      }

      const intervalHours = Number(settings["auto_sync_interval_hours"] ?? 6);
      const lastCronSync = await prisma.syncLog.findFirst({
        where: { triggeredBy: "cron", status: "success" },
        orderBy: { createdAt: "desc" },
      });

      if (lastCronSync) {
        const hoursSinceLast =
          (Date.now() - new Date(lastCronSync.createdAt).getTime()) /
          (1000 * 60 * 60);

        if (hoursSinceLast < intervalHours) {
          return Response.json({
            success: true,
            skipped: true,
            message: `Skipped. Last sync was ${hoursSinceLast.toFixed(1)} hours ago. Interval is ${intervalHours} hours.`,
          });
        }
      }
    }

    // Check pending count
    const pendingCount = await prisma.metafieldSyncQueue.count({
      where: { status: "pending" },
    });

    if (pendingCount === 0) {
      return Response.json({
        success: true,
        message: "No pending items.",
        duration: Date.now() - startTime,
      });
    }

    console.log(`Processing all ${pendingCount} pending metafield sync items...`);

    // Get Shopify session
    const session = await prisma.session.findFirst({
      where: { isOnline: false },
      orderBy: { expires: "desc" },
    });

    if (!session) {
      return Response.json({ error: "No valid session found." }, { status: 500 });
    }

    const { admin } = await unauthenticated.admin(session.shop);

    // Fetch ALL pending items
    const pending = await prisma.metafieldSyncQueue.findMany({
      where: { status: "pending" },
      orderBy: { createdAt: "asc" },
    });

    let synced = 0;
    let failed = 0;

    for (let i = 0; i < pending.length; i += METAFIELD_BATCH) {
      const batch = pending.slice(i, i + METAFIELD_BATCH);

      try {
        await setMetafieldsBatch(admin, batch.map((item) => ({
          productId: item.productId,
          handles: item.handles,
        })));

        await prisma.metafieldSyncQueue.updateMany({
          where: { id: { in: batch.map((item) => item.id) } },
          data: { status: "done" },
        });

        synced += batch.length;
      } catch (err) {
        console.error(`Batch failed:`, err.message);

        for (const item of batch) {
          await prisma.metafieldSyncQueue.update({
            where: { id: item.id },
            data: {
              status: item.attempts >= 3 ? "failed" : "pending",
              attempts: item.attempts + 1,
              errorMsg: err.message,
            },
          });
        }
        failed += batch.length;
      }

      // 1 second between batches to respect Shopify rate limits
      await sleep(1000);

      if (synced % 500 === 0 && synced > 0) {
        console.log(`Progress: ${synced} / ${pending.length}`);
      }
    }

    const remaining = await prisma.metafieldSyncQueue.count({
      where: { status: "pending" },
    });

    const duration = Date.now() - startTime;

    await prisma.syncLog.create({
      data: {
        triggeredBy,
        productsCount: synced,
        status: failed > 0 && synced === 0 ? "failed" : "success",
        durationMs: duration,
        errorMsg: failed > 0 ? `${failed} items failed` : null,
      },
    });

    return Response.json({
      success: true,
      synced,
      failed,
      remaining,
      duration,
      message: `Processed ${synced} / ${pending.length} items in ${Math.round(duration / 1000)}s. ${remaining} remaining.`,
    });
  } catch (err) {
    console.error("Metafield sync cron failed:", err);

    await prisma.syncLog.create({
      data: {
        triggeredBy,
        productsCount: 0,
        status: "failed",
        durationMs: Date.now() - startTime,
        errorMsg: err.message,
      },
    });

    return Response.json({ error: err.message }, { status: 500 });
  }
};