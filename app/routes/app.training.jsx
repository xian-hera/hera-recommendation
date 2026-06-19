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
    mappingCount,
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

  return { success: false, message: "Unknown intent." };
};

export default function Training() {
  const { recentLogs, latestTraining, mappingCount, lastAutomaticTraining, appUrl } =
    useLoaderData();
  const fetcher = useFetcher();
  const [sinceDate, setSinceDate] = useState("");

  const isTriggering = fetcher.state !== "idle";
  const result = fetcher.data;

  const cronUrl = `${appUrl}/api/cron/train`;
  const cronCommand = `curl -X POST ${cronUrl} -H "Authorization: Bearer $CRON_SECRET"`;

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
                  Sync product handle mapping without running training. Use this
                  after your first local training to populate the mapping table.
                </Text>
              </BlockStack>

              <fetcher.Form method="post">
                <input type="hidden" name="intent" value="sync_only" />
                <Button
                  submit
                  loading={isTriggering}
                  disabled={isTriggering}
                >
                  Sync SKU to Handle
                </Button>
              </fetcher.Form>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Automatic training (Cron Job) */}
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
                <Text variant="headingMd">Setup Instructions</Text>
                <Text tone="subdued">
                  1. Go to Render Dashboard → New → Cron Job
                </Text>
                <Text tone="subdued">
                  2. Connect the same GitHub repo
                </Text>
                <Text tone="subdued">
                  3. Set schedule: <code>0 2 * * 1</code> (every Monday at 2am)
                </Text>
                <Text tone="subdued">
                  4. Add environment variable: <code>CRON_SECRET</code> (same value as your web service)
                </Text>
                <Text tone="subdued">
                  5. Set command:
                </Text>
                <Box
                  background="bg-surface-secondary"
                  padding="300"
                  borderRadius="200"
                >
                  <Text as="p" tone="subdued">
                    <code>{cronCommand}</code>
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