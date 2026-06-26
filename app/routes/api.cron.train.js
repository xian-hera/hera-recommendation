/**
 * Cron job endpoint for automated incremental training
 * Called daily by Render Cron Job
 * Checks settings to decide whether to actually run
 * Protected by CRON_SECRET token
 */

import { PrismaClient } from "@prisma/client";
import { unauthenticated } from "../shopify.server.js";

const prisma = new PrismaClient();

// Convert ET hour to UTC hour (ET = UTC-5 standard, UTC-4 daylight)
function getEtOffsetHours() {
  const now = new Date();
  const jan = new Date(now.getFullYear(), 0, 1);
  const jul = new Date(now.getFullYear(), 6, 1);
  const stdOffset = Math.max(jan.getTimezoneOffset(), jul.getTimezoneOffset());
  const isDST = now.getTimezoneOffset() < stdOffset;
  return isDST ? 4 : 5; // ET is UTC-4 in DST, UTC-5 in standard
}

export const action = async ({ request }) => {
  const authHeader = request.headers.get("Authorization");
  const token = authHeader?.replace("Bearer ", "");

  // eslint-disable-next-line no-undef
  if (!token || token !== process.env.CRON_SECRET) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startTime = Date.now();

  try {
    // Load settings
    const settingsRows = await prisma.setting.findMany();
    const settings = Object.fromEntries(settingsRows.map((s) => [s.key, s.value]));

    // Check if auto training is enabled
    if (settings["auto_training_enabled"] !== "true") {
      return Response.json({
        success: true,
        skipped: true,
        message: "Auto training is disabled.",
      });
    }

    // Check if current ET hour matches configured hour
    const configuredHourEt = Number(settings["auto_training_hour_et"] ?? 2);
    const nowUtc = new Date();
    const etOffset = getEtOffsetHours();
    const currentHourEt = (nowUtc.getUTCHours() - etOffset + 24) % 24;

    if (currentHourEt !== configuredHourEt) {
      return Response.json({
        success: true,
        skipped: true,
        message: `Skipped. Current ET hour is ${currentHourEt}, configured to run at ${configuredHourEt}:00 ET.`,
      });
    }

    // Check if enough days have passed since last training
    const intervalDays = Number(settings["auto_training_interval_days"] ?? 7);
    const lastCronTraining = await prisma.trainingLog.findFirst({
      where: { triggeredBy: "cron", status: "success" },
      orderBy: { createdAt: "desc" },
    });

    if (lastCronTraining) {
      const daysSinceLast =
        (Date.now() - new Date(lastCronTraining.createdAt).getTime()) /
        (1000 * 60 * 60 * 24);

      if (daysSinceLast < intervalDays) {
        return Response.json({
          success: true,
          skipped: true,
          message: `Skipped. Last training was ${daysSinceLast.toFixed(1)} days ago. Interval is ${intervalDays} days.`,
        });
      }
    }

    // Get Shopify session
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

    const { admin } = await unauthenticated.admin(session.shop);

    // Run incremental training — triggered by cron
    const { runIncrementalTraining } = await import("../lib/train-incremental.server.js");
    const result = await runIncrementalTraining(admin, null, false, "cron");

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