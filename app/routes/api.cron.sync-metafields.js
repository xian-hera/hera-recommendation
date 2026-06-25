/**
 * Metafield sync cron endpoint
 * Called by Render Cron Job every 5 minutes
 * Processes up to 100 pending items from metafield_sync_queue per run
 * Protected by CRON_SECRET token
 */

import { PrismaClient } from "@prisma/client";
import { unauthenticated } from "../shopify.server.js";

const prisma = new PrismaClient();

const BATCH_SIZE = 100;
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
  // Determine if triggered by cron or manual
  const triggeredBy = request.headers.get("X-Triggered-By") || "cron";

  try {
    const session = await prisma.session.findFirst({
      where: { isOnline: false },
      orderBy: { expires: "desc" },
    });

    if (!session) {
      return Response.json({ error: "No valid session found." }, { status: 500 });
    }

    const { admin } = await unauthenticated.admin(session.shop);

    const pending = await prisma.metafieldSyncQueue.findMany({
      where: { status: "pending" },
      orderBy: { createdAt: "asc" },
      take: BATCH_SIZE,
    });

    if (pending.length === 0) {
      return Response.json({
        success: true,
        message: "No pending items.",
        duration: Date.now() - startTime,
      });
    }

    console.log(`Processing ${pending.length} pending metafield sync items...`);

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

      await sleep(1000);
    }

    const remaining = await prisma.metafieldSyncQueue.count({
      where: { status: "pending" },
    });

    const duration = Date.now() - startTime;

    // Write sync log
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
      message: `Processed ${synced} items. ${remaining} remaining in queue.`,
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