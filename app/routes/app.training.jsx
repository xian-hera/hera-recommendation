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
} from "@shopify/polaris";

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

  const mappingCount = await prisma.recommendation.count();

  return {
    recentLogs: recentLogs.map((log) => ({
      ...log,
      createdAt: log.createdAt.toISOString(),
    })),
    latestTraining: latestTraining
      ? {
          ...latestTraining,
          createdAt: latestTraining.createdAt.toISOString(),
        }
      : null,
    mappingCount,
  };
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "trigger_incremental") {
    const { runIncrementalTraining } = await import("../lib/train-incremental.server.js");
    const result = await runIncrementalTraining(admin);
    return result;
  }

  return { success: false, message: "Unknown intent." };
};

export default function Training() {
  const { recentLogs, latestTraining, mappingCount } = useLoaderData();
  const fetcher = useFetcher();

  const isTriggering = fetcher.state !== "idle";
  const result = fetcher.data;

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
                  Fetch new orders from Shopify and update the recommendation
                  model using weighted merge (history 80% / new 20%).
                </Text>
              </BlockStack>

              {result && (
                <Banner tone={result.success ? "success" : "critical"}>
                  {result.message}
                </Banner>
              )}

              <fetcher.Form method="post">
                <input type="hidden" name="intent" value="trigger_incremental" />
                <Button
                  variant="primary"
                  submit
                  loading={isTriggering}
                  disabled={isTriggering}
                >
                  Run Incremental Training
                </Button>
              </fetcher.Form>
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