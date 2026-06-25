import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { PrismaClient } from "@prisma/client";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  InlineGrid,
  Badge,
  DataTable,
  EmptyState,
  Banner,
  Divider,
} from "@shopify/polaris";

const prisma = new PrismaClient();

export const loader = async ({ request }) => {
  await authenticate.admin(request);

  const latestTraining = await prisma.trainingLog.findFirst({
    where: { status: "success" },
    orderBy: { createdAt: "desc" },
  });

  const mappingCount = await prisma.recommendation.count();

  const recentLogs = await prisma.trainingLog.findMany({
    orderBy: { createdAt: "desc" },
    take: 5,
  });

  const clickCount = await prisma.recommendationEvent.count({
    where: { eventType: "click" },
  });

  const addToCartCount = await prisma.recommendationEvent.count({
    where: { eventType: "add_to_cart" },
  });

  // Full training overdue check
  const lastFullTraining = await prisma.trainingLog.findFirst({
    where: { triggeredBy: "csv_upload", status: "success" },
    orderBy: { createdAt: "desc" },
  });

  let fullTrainingAlert = null;
  if (!lastFullTraining) {
    fullTrainingAlert = "error";
  } else {
    const monthsSince =
      (Date.now() - new Date(lastFullTraining.createdAt).getTime()) /
      (1000 * 60 * 60 * 24 * 30);
    if (monthsSince >= 13) fullTrainingAlert = "error";
    else if (monthsSince >= 11) fullTrainingAlert = "warning";
  }

  // Training activity
  const lastManualTraining = await prisma.trainingLog.findFirst({
    where: { triggeredBy: "manual", status: "success" },
    orderBy: { createdAt: "desc" },
  });

  const lastAutoTraining = await prisma.trainingLog.findFirst({
    where: { triggeredBy: "cron", status: "success" },
    orderBy: { createdAt: "desc" },
  });

  const totalManualTrainings = await prisma.trainingLog.count({
    where: { triggeredBy: "manual", status: "success" },
  });

  const totalAutoTrainings = await prisma.trainingLog.count({
    where: { triggeredBy: "cron", status: "success" },
  });

  // Metafield sync activity
  const lastManualSync = await prisma.syncLog.findFirst({
    where: { triggeredBy: "manual", status: "success" },
    orderBy: { createdAt: "desc" },
  });

  const lastAutoSync = await prisma.syncLog.findFirst({
    where: { triggeredBy: "cron", status: "success" },
    orderBy: { createdAt: "desc" },
  });

  const totalManualSyncs = await prisma.syncLog.count({
    where: { triggeredBy: "manual", status: "success" },
  });

  const totalAutoSyncs = await prisma.syncLog.count({
    where: { triggeredBy: "cron", status: "success" },
  });

  // Queue stats
  const queuePending = await prisma.metafieldSyncQueue.count({
    where: { status: "pending" },
  });

  return {
    latestTraining: latestTraining
      ? { ...latestTraining, createdAt: latestTraining.createdAt.toISOString() }
      : null,
    mappingCount,
    clickCount,
    addToCartCount,
    recentLogs: recentLogs.map((log) => ({
      ...log,
      createdAt: log.createdAt.toISOString(),
    })),
    fullTrainingAlert,
    lastFullTraining: lastFullTraining
      ? { createdAt: lastFullTraining.createdAt.toISOString() }
      : null,
    lastManualTraining: lastManualTraining
      ? { createdAt: lastManualTraining.createdAt.toISOString(), ordersCount: lastManualTraining.ordersCount }
      : null,
    lastAutoTraining: lastAutoTraining
      ? { createdAt: lastAutoTraining.createdAt.toISOString(), ordersCount: lastAutoTraining.ordersCount }
      : null,
    totalManualTrainings,
    totalAutoTrainings,
    lastManualSync: lastManualSync
      ? { createdAt: lastManualSync.createdAt.toISOString(), productsCount: lastManualSync.productsCount }
      : null,
    lastAutoSync: lastAutoSync
      ? { createdAt: lastAutoSync.createdAt.toISOString(), productsCount: lastAutoSync.productsCount }
      : null,
    totalManualSyncs,
    totalAutoSyncs,
    queuePending,
  };
};

export default function Dashboard() {
  const {
    latestTraining,
    mappingCount,
    clickCount,
    addToCartCount,
    recentLogs,
    fullTrainingAlert,
    lastFullTraining,
    lastManualTraining,
    lastAutoTraining,
    totalManualTrainings,
    totalAutoTrainings,
    lastManualSync,
    lastAutoSync,
    totalManualSyncs,
    totalAutoSyncs,
    queuePending,
  } = useLoaderData();

  const rows = recentLogs.map((log) => [
    new Date(log.createdAt).toLocaleString(),
    log.triggeredBy,
    log.ordersCount.toLocaleString(),
    <Badge tone={log.status === "success" ? "success" : "critical"}>
      {log.status === "success" ? "Success" : "Failed"}
    </Badge>,
    log.durationMs ? `${(log.durationMs / 1000).toFixed(1)}s` : "-",
  ]);

  return (
    <Page title="Dashboard">
      <Layout>
        {fullTrainingAlert && (
          <Layout.Section>
            <Banner
              tone={fullTrainingAlert === "error" ? "critical" : "warning"}
              title={
                fullTrainingAlert === "error"
                  ? "Full training overdue"
                  : "Full training due soon"
              }
            >
              {fullTrainingAlert === "error"
                ? `It has been over 13 months since your last full training${
                    lastFullTraining
                      ? ` (${new Date(lastFullTraining.createdAt).toLocaleDateString()})`
                      : ""
                  }. Please run a full local training soon.`
                : `It has been over 11 months since your last full training (${new Date(
                    lastFullTraining.createdAt
                  ).toLocaleDateString()}). Consider scheduling a full local training.`}
            </Banner>
          </Layout.Section>
        )}

        {/* Model status */}
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text variant="headingMd">Model Status</Text>
              <InlineGrid columns={2} gap="400">
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
              </InlineGrid>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Recommendation performance */}
        <Layout.Section>
          <InlineGrid columns={2} gap="400">
            <Card>
              <BlockStack gap="100">
                <Text tone="subdued">Recommendation clicks</Text>
                <Text variant="heading2xl">{clickCount.toLocaleString()}</Text>
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="100">
                <Text tone="subdued">Add to cart from recommendations</Text>
                <Text variant="heading2xl">{addToCartCount.toLocaleString()}</Text>
              </BlockStack>
            </Card>
          </InlineGrid>
        </Layout.Section>

        {/* Training activity */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text variant="headingMd">Training Activity</Text>
              <Divider />
              <InlineGrid columns={2} gap="400">
                <BlockStack gap="200">
                  <Text variant="headingSm">Manual Incremental Training</Text>
                  <BlockStack gap="100">
                    <Text tone="subdued">Last run</Text>
                    <Text>
                      {lastManualTraining
                        ? new Date(lastManualTraining.createdAt).toLocaleString()
                        : "Never"}
                    </Text>
                  </BlockStack>
                  <BlockStack gap="100">
                    <Text tone="subdued">Last orders processed</Text>
                    <Text>
                      {lastManualTraining
                        ? lastManualTraining.ordersCount.toLocaleString()
                        : "-"}
                    </Text>
                  </BlockStack>
                  <BlockStack gap="100">
                    <Text tone="subdued">Total runs</Text>
                    <Text>{totalManualTrainings.toLocaleString()}</Text>
                  </BlockStack>
                </BlockStack>

                <BlockStack gap="200">
                  <Text variant="headingSm">Automatic Incremental Training</Text>
                  <BlockStack gap="100">
                    <Text tone="subdued">Last run</Text>
                    <Text>
                      {lastAutoTraining
                        ? new Date(lastAutoTraining.createdAt).toLocaleString()
                        : "Never"}
                    </Text>
                  </BlockStack>
                  <BlockStack gap="100">
                    <Text tone="subdued">Last orders processed</Text>
                    <Text>
                      {lastAutoTraining
                        ? lastAutoTraining.ordersCount.toLocaleString()
                        : "-"}
                    </Text>
                  </BlockStack>
                  <BlockStack gap="100">
                    <Text tone="subdued">Total runs</Text>
                    <Text>{totalAutoTrainings.toLocaleString()}</Text>
                  </BlockStack>
                </BlockStack>
              </InlineGrid>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Metafield sync activity */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text variant="headingMd">Metafield Sync Activity</Text>
              <Divider />
              <InlineGrid columns={2} gap="400">
                <BlockStack gap="200">
                  <Text variant="headingSm">Manual Sync</Text>
                  <BlockStack gap="100">
                    <Text tone="subdued">Last run</Text>
                    <Text>
                      {lastManualSync
                        ? new Date(lastManualSync.createdAt).toLocaleString()
                        : "Never"}
                    </Text>
                  </BlockStack>
                  <BlockStack gap="100">
                    <Text tone="subdued">Last products synced</Text>
                    <Text>
                      {lastManualSync
                        ? lastManualSync.productsCount.toLocaleString()
                        : "-"}
                    </Text>
                  </BlockStack>
                  <BlockStack gap="100">
                    <Text tone="subdued">Total runs</Text>
                    <Text>{totalManualSyncs.toLocaleString()}</Text>
                  </BlockStack>
                </BlockStack>

                <BlockStack gap="200">
                  <Text variant="headingSm">Automatic Sync (Cron)</Text>
                  <BlockStack gap="100">
                    <Text tone="subdued">Last run</Text>
                    <Text>
                      {lastAutoSync
                        ? new Date(lastAutoSync.createdAt).toLocaleString()
                        : "Never"}
                    </Text>
                  </BlockStack>
                  <BlockStack gap="100">
                    <Text tone="subdued">Last products synced</Text>
                    <Text>
                      {lastAutoSync
                        ? lastAutoSync.productsCount.toLocaleString()
                        : "-"}
                    </Text>
                  </BlockStack>
                  <BlockStack gap="100">
                    <Text tone="subdued">Total runs</Text>
                    <Text>{totalAutoSyncs.toLocaleString()}</Text>
                  </BlockStack>
                </BlockStack>
              </InlineGrid>

              <Divider />
              <BlockStack gap="100">
                <Text tone="subdued">Pending in queue</Text>
                <Text variant="bodyLg">
                  {queuePending > 0 ? (
                    <Badge tone="attention">{queuePending.toLocaleString()} pending</Badge>
                  ) : (
                    "Queue empty"
                  )}
                </Text>
              </BlockStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Recent training logs */}
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text variant="headingMd">Recent Training Logs</Text>
              {recentLogs.length === 0 ? (
                <EmptyState heading="No training logs yet" image="">
                  <p>Run your first training to see logs here.</p>
                </EmptyState>
              ) : (
                <DataTable
                  columnContentTypes={["text", "text", "numeric", "text", "text"]}
                  headings={["Date", "Triggered by", "Orders", "Status", "Duration"]}
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