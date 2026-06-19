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

  // Check if full training is overdue
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