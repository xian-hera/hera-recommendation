import { useLoaderData, useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import { PrismaClient } from "@prisma/client";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  Button,
  Badge,
  DataTable,
  EmptyState,
  Banner,
  InlineStack,
  TextField,
  Divider,
  Box,
} from "@shopify/polaris";
import { useState } from "react";

const prisma = new PrismaClient();

export const loader = async ({ request }) => {
  await authenticate.admin(request);

  const recentLogs = await prisma.trainingLog.findMany({
    orderBy: { createdAt: "desc" },
    take: 10,
  });

  const latestTraining = await prisma.trainingLog.findFirst({
    where: { status: "success" },
    orderBy: { createdAt: "desc" },
  });

  const lastAutomaticTraining = await prisma.trainingLog.findFirst({
    where: { triggeredBy: "cron", status: "success" },
    orderBy: { createdAt: "desc" },
  });

  const mappingCount = await prisma.recommendation.count();

  // Queue stats
  const queuePending = await prisma.metafieldSyncQueue.count({
    where: { status: "pending" },
  });
  const queueFailed = await prisma.metafieldSyncQueue.count({
    where: { status: "failed" },
  });

  // Last sync log
  const lastSyncLog = await prisma.syncLog.findFirst({
    where: { status: "success" },
    orderBy: { createdAt: "desc" },
  });

  // eslint-disable-next-line no-undef
  const appUrl = process.env.SHOPIFY_APP_URL || "";

  return {
    recentLogs: recentLogs.map((log) => ({
      ...log,
      createdAt: log.createdAt.toISOString(),
    })),
    latestTraining: latestTraining
      ? { ...latestTraining, createdAt: latestTraining.createdAt.toISOString() }
      : null,
    lastAutomaticTraining: lastAutomaticTraining
      ? { createdAt: lastAutomaticTraining.createdAt.toISOString() }
      : null,
    lastSyncLog: lastSyncLog
      ? { ...lastSyncLog, createdAt: lastSyncLog.createdAt.toISOString() }
      : null,
    mappingCount,
    queuePending,
    queueFailed,
    appUrl,
  };
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "trigger_incremental") {
    const sinceDateOverride = formData.get("since_date") || null;
    const { runIncrementalTraining } = await import("../lib/train-incremental.server.js");
    const result = await runIncrementalTraining(admin, sinceDateOverride, false);
    return result;
  }

  if (intent === "sync_only") {
    const { runIncrementalTraining } = await import("../lib/train-incremental.server.js");
    const result = await runIncrementalTraining(admin, null, true);
    return result;
  }

  if (intent === "trigger_metafield_sync") {
    // eslint-disable-next-line no-undef
    const appUrl = process.env.SHOPIFY_APP_URL || "";
    // eslint-disable-next-line no-undef
    const cronSecret = process.env.CRON_SECRET || "";
    console.log("DEBUG appUrl:", appUrl, "| cronSecret length:", cronSecret?.length);
    const res = await fetch(`${appUrl}/api/cron/sync-metafields`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${cronSecret}`,
        "X-Triggered-By": "manual",
      },
    });
    const data = await res.json();
    return {
      success: res.ok,
      message: data.message || data.error || "Unknown error",
    };
  }

  return { success: false, message: "Unknown intent." };
};

export default function Training() {
  const {
    recentLogs,
    latestTraining,
    mappingCount,
    lastAutomaticTraining,
    lastSyncLog,
    queuePending,
    queueFailed,
    appUrl,
  } = useLoaderData();
  const fetcher = useFetcher();
  const [sinceDate, setSinceDate] = useState("");

  const isTriggering = fetcher.state !== "idle";
  const result = fetcher.data;

  const trainingCronUrl = `${appUrl}/api/cron/train`;
  const trainingCronCommand = `curl -X POST ${trainingCronUrl} -H "Authorization: Bearer $CRON_SECRET"`;
  const syncCronUrl = `${appUrl}/api/cron/sync-metafields`;
  const syncCronCommand = `curl -X POST ${syncCronUrl} -H "Authorization: Bearer $CRON_SECRET"`;

  const rows = recentLogs.map((log) => [
    new Date(log.createdAt).toLocaleString(),
    log.triggeredBy,
    log.ordersCount.toLocaleString(),
    <Badge
      tone={
        log.status === "success"
          ? "success"
          : log.status === "pending"
          ? "attention"
          : "critical"
      }
    >
      {log.status === "success"
        ? "Success"
        : log.status === "pending"
        ? "Pending"
        : "Failed"}
    </Badge>,
    log.durationMs ? `${(log.durationMs / 1000).toFixed(1)}s` : "-",
    log.errorMsg || "-",
  ]);

  return (
    <Page title="Training">
      <Layout>
        {/* Model status */}
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text variant="headingMd">Model Status</Text>
              <InlineStack gap="600">
                <BlockStack gap="100">
                  <Text tone="subdued">Last trained</Text>
                  <Text variant="bodyLg">
                    {latestTraining
                      ? new Date(latestTraining.createdAt).toLocaleString()
                      : "Never"}
                  </Text>
                </BlockStack>
                <BlockStack gap="100">
                  <Text tone="subdued">Products covered</Text>
                  <Text variant="bodyLg">{mappingCount.toLocaleString()}</Text>
                </BlockStack>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Incremental training */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <BlockStack gap="100">
                <Text variant="headingMd">Incremental Training</Text>
                <Text tone="subdued">
                  Fetch paid and fulfilled orders from Shopify and update the
                  recommendation model using weighted merge (history 80% / new 20%).
                  After training, changed products are queued for metafield sync.
                </Text>
              </BlockStack>

              {result && (
                <Banner tone={result.success ? "success" : "critical"}>
                  {result.message}
                </Banner>
              )}

              <fetcher.Form method="post">
                <BlockStack gap="400">
                  <TextField
                    label="Start date (optional)"
                    type="date"
                    name="since_date"
                    value={sinceDate}
                    onChange={setSinceDate}
                    helpText="Leave blank to auto-detect from last training. Set a specific date to avoid overlapping with local training data."
                  />
                  <input type="hidden" name="intent" value="trigger_incremental" />
                  <Button
                    variant="primary"
                    submit
                    loading={isTriggering}
                    disabled={isTriggering}
                  >
                    Run Incremental Training
                  </Button>
                </BlockStack>
              </fetcher.Form>

              <Divider />

              <BlockStack gap="100">
                <Text variant="headingMd">Sync SKU → Handle Only</Text>
                <Text tone="subdued">
                  Sync product handle mapping without running training.
                </Text>
              </BlockStack>

              <fetcher.Form method="post">
                <input type="hidden" name="intent" value="sync_only" />
                <Button submit loading={isTriggering} disabled={isTriggering}>
                  Sync SKU to Handle
                </Button>
              </fetcher.Form>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Metafield sync queue */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <BlockStack gap="100">
                <Text variant="headingMd">Metafield Sync Queue</Text>
                <Text tone="subdued">
                  Processes up to 100 products per run. Trigger manually or let
                  the cron job handle it automatically every 5 minutes.
                </Text>
              </BlockStack>

              <InlineStack gap="600">
                <BlockStack gap="100">
                  <Text tone="subdued">Pending</Text>
                  <Text variant="bodyLg">{queuePending.toLocaleString()}</Text>
                </BlockStack>
                <BlockStack gap="100">
                  <Text tone="subdued">Failed</Text>
                  <Text variant="bodyLg">
                    {queueFailed > 0 ? (
                      <Badge tone="critical">{queueFailed.toLocaleString()}</Badge>
                    ) : (
                      "0"
                    )}
                  </Text>
                </BlockStack>
                <BlockStack gap="100">
                  <Text tone="subdued">Last sync</Text>
                  <Text variant="bodyLg">
                    {lastSyncLog
                      ? new Date(lastSyncLog.createdAt).toLocaleString()
                      : "Never"}
                  </Text>
                </BlockStack>
              </InlineStack>

              <fetcher.Form method="post">
                <input type="hidden" name="intent" value="trigger_metafield_sync" />
                <Button submit loading={isTriggering} disabled={isTriggering}>
                  Run Metafield Sync Now
                </Button>
              </fetcher.Form>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Automatic training cron */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <BlockStack gap="100">
                <Text variant="headingMd">Automatic Training (Cron Job)</Text>
                <Text tone="subdued">
                  Set up a weekly cron job on Render to automatically run
                  incremental training. The job fetches the last 7 days of
                  paid and fulfilled orders.
                </Text>
              </BlockStack>

              <InlineStack gap="600">
                <BlockStack gap="100">
                  <Text tone="subdued">Last automatic training</Text>
                  <Text variant="bodyLg">
                    {lastAutomaticTraining
                      ? new Date(lastAutomaticTraining.createdAt).toLocaleString()
                      : "Never"}
                  </Text>
                </BlockStack>
              </InlineStack>

              <Divider />

              <BlockStack gap="200">
                <Text variant="headingMd">Training Cron Setup</Text>
                <Text tone="subdued">
                  Schedule: <code>0 2 * * 1</code> (every Monday at 2am)
                </Text>
                <Box background="bg-surface-secondary" padding="300" borderRadius="200">
                  <Text as="p" tone="subdued">
                    <code>{trainingCronCommand}</code>
                  </Text>
                </Box>
              </BlockStack>

              <Divider />

              <BlockStack gap="200">
                <Text variant="headingMd">Metafield Sync Cron Setup</Text>
                <Text tone="subdued">
                  Schedule: <code>*/5 * * * *</code> (every 5 minutes)
                </Text>
                <Box background="bg-surface-secondary" padding="300" borderRadius="200">
                  <Text as="p" tone="subdued">
                    <code>{syncCronCommand}</code>
                  </Text>
                </Box>
              </BlockStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Training logs */}
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text variant="headingMd">Training Logs</Text>
              {recentLogs.length === 0 ? (
                <EmptyState heading="No training logs yet" image="">
                  <p>Run your first training to see logs here.</p>
                </EmptyState>
              ) : (
                <DataTable
                  columnContentTypes={[
                    "text",
                    "text",
                    "numeric",
                    "text",
                    "text",
                    "text",
                  ]}
                  headings={[
                    "Date",
                    "Triggered by",
                    "Orders",
                    "Status",
                    "Duration",
                    "Error",
                  ]}
                  rows={rows}
                />
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}