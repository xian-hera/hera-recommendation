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
  TextField,
  Select,
  Banner,
  Divider,
  Checkbox,
} from "@shopify/polaris";
import { useState } from "react";

const prisma = new PrismaClient();

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  const rows = await prisma.setting.findMany();
  // Normalize all values to strings for consistent comparison
  const settings = Object.fromEntries(
    rows.map((r) => [
      r.key,
      typeof r.value === "string" ? r.value : JSON.stringify(r.value),
    ])
  );
  return { settings };
};

export const action = async ({ request }) => {
  await authenticate.admin(request);
  const formData = await request.formData();

  const updates = [
    ["recommendation_count", formData.get("recommendation_count")],
    ["min_confidence", formData.get("min_confidence")],
    ["browse_weight", formData.get("browse_weight")],
    ["purchase_weight", formData.get("purchase_weight")],
    ["training_date_range", formData.get("training_date_range")],
    ["history_weight", formData.get("history_weight")],
    ["new_data_weight", formData.get("new_data_weight")],
    ["auto_training_enabled", formData.get("auto_training_enabled") === "true" ? "true" : "false"],
    ["auto_training_interval_days", formData.get("auto_training_interval_days")],
    ["auto_training_hour_et", formData.get("auto_training_hour_et")],
    ["auto_sync_enabled", formData.get("auto_sync_enabled") === "true" ? "true" : "false"],
    ["auto_sync_interval_hours", formData.get("auto_sync_interval_hours")],
  ];

  try {
    for (const [key, value] of updates) {
      if (value === null) continue;
      await prisma.setting.upsert({
        where: { key },
        update: { value, updatedAt: new Date() },
        create: { key, value },
      });
    }
    return { success: true, message: "Settings saved." };
  } catch (err) {
    return { success: false, message: err.message };
  }
};

export default function Settings() {
  const { settings } = useLoaderData();
  const fetcher = useFetcher();

  const [recommendationCount, setRecommendationCount] = useState(
    String(settings["recommendation_count"] ?? "4")
  );
  const [minConfidence, setMinConfidence] = useState(
    String(settings["min_confidence"] ?? "0.01")
  );
  const [browseWeight, setBrowseWeight] = useState(
    String(settings["browse_weight"] ?? "0.4")
  );
  const [purchaseWeight, setPurchaseWeight] = useState(
    String(settings["purchase_weight"] ?? "0.6")
  );
  const [historyWeight, setHistoryWeight] = useState(
    String(settings["history_weight"] ?? "0.8")
  );
  const [newDataWeight, setNewDataWeight] = useState(
    String(settings["new_data_weight"] ?? "0.2")
  );
  const [trainingDateRange, setTrainingDateRange] = useState(
    String(settings["training_date_range"] ?? "all")
  );

  // Auto training settings
  const [autoTrainingEnabled, setAutoTrainingEnabled] = useState(
    settings["auto_training_enabled"] === "true"
  );
  const [autoTrainingIntervalDays, setAutoTrainingIntervalDays] = useState(
    String(settings["auto_training_interval_days"] ?? "7")
  );
  const [autoTrainingHourEt, setAutoTrainingHourEt] = useState(
    String(settings["auto_training_hour_et"] ?? "2")
  );

  // Auto sync settings
  const [autoSyncEnabled, setAutoSyncEnabled] = useState(
    settings["auto_sync_enabled"] === "true"
  );
  const [autoSyncIntervalHours, setAutoSyncIntervalHours] = useState(
    String(settings["auto_sync_interval_hours"] ?? "1")
  );

  const isSaving = fetcher.state !== "idle";
  const result = fetcher.data;

  return (
    <Page title="Settings">
      <Layout>
        {result && (
          <Layout.Section>
            <Banner tone={result.success ? "success" : "critical"}>
              {result.message}
            </Banner>
          </Layout.Section>
        )}

        <Layout.Section>
          <fetcher.Form method="post">
            <BlockStack gap="400">

              {/* Recommendation display */}
              <Card>
                <BlockStack gap="400">
                  <Text variant="headingMd">Recommendation Display</Text>
                  <TextField
                    label="Number of recommendations to show"
                    type="number"
                    name="recommendation_count"
                    value={recommendationCount}
                    onChange={setRecommendationCount}
                    min={1}
                    max={20}
                    helpText="Default: 4"
                  />
                  <TextField
                    label="Minimum confidence threshold"
                    type="number"
                    name="min_confidence"
                    value={minConfidence}
                    onChange={setMinConfidence}
                    min={0}
                    max={1}
                    step={0.01}
                    helpText="Recommendations below this confidence score are excluded. Default: 0.01"
                  />
                </BlockStack>
              </Card>

              <Divider />

              {/* Scoring weights */}
              <Card>
                <BlockStack gap="400">
                  <Text variant="headingMd">Scoring Weights</Text>
                  <Text tone="subdued">
                    Browse + Purchase should add up to 1.
                  </Text>
                  <TextField
                    label="Browse history weight"
                    type="number"
                    name="browse_weight"
                    value={browseWeight}
                    onChange={setBrowseWeight}
                    min={0}
                    max={1}
                    step={0.1}
                    helpText="Default: 0.4"
                  />
                  <TextField
                    label="Purchase history weight"
                    type="number"
                    name="purchase_weight"
                    value={purchaseWeight}
                    onChange={setPurchaseWeight}
                    min={0}
                    max={1}
                    step={0.1}
                    helpText="Default: 0.6"
                  />
                </BlockStack>
              </Card>

              <Divider />

              {/* Incremental training weights */}
              <Card>
                <BlockStack gap="400">
                  <Text variant="headingMd">Incremental Training Weights</Text>
                  <Text tone="subdued">
                    History + New data should add up to 1.
                  </Text>
                  <TextField
                    label="Historical data weight"
                    type="number"
                    name="history_weight"
                    value={historyWeight}
                    onChange={setHistoryWeight}
                    min={0}
                    max={1}
                    step={0.1}
                    helpText="Default: 0.8"
                  />
                  <TextField
                    label="New data weight"
                    type="number"
                    name="new_data_weight"
                    value={newDataWeight}
                    onChange={setNewDataWeight}
                    min={0}
                    max={1}
                    step={0.1}
                    helpText="Default: 0.2"
                  />
                </BlockStack>
              </Card>

              <Divider />

              {/* Training data range */}
              <Card>
                <BlockStack gap="400">
                  <Text variant="headingMd">Training Data Range</Text>
                  <Select
                    label="Use orders from"
                    name="training_date_range"
                    options={[
                      { label: "All time", value: "all" },
                      { label: "Last 12 months", value: "12m" },
                      { label: "Last 6 months", value: "6m" },
                      { label: "Last 3 months", value: "3m" },
                    ]}
                    value={trainingDateRange}
                    onChange={setTrainingDateRange}
                    helpText="Applies to incremental training on the server."
                  />
                </BlockStack>
              </Card>

              <Divider />

              {/* Auto training */}
              <Card>
                <BlockStack gap="400">
                  <Text variant="headingMd">Automatic Incremental Training</Text>
                  <Text tone="subdued">
                    Render Cron Job triggers daily. APP checks these settings to decide whether to actually run.
                  </Text>
                  <Checkbox
                    label="Enable automatic training"
                    checked={autoTrainingEnabled}
                    onChange={setAutoTrainingEnabled}
                  />
                  <input
                    type="hidden"
                    name="auto_training_enabled"
                    value={String(autoTrainingEnabled)}
                  />
                  <TextField
                    label="Run every X days"
                    type="number"
                    name="auto_training_interval_days"
                    value={autoTrainingIntervalDays}
                    onChange={setAutoTrainingIntervalDays}
                    min={1}
                    max={365}
                    helpText="Default: 7 (weekly). Training runs if this many days have passed since last run."
                    disabled={!autoTrainingEnabled}
                  />
                  <Select
                    label="Run at hour (Eastern Time)"
                    name="auto_training_hour_et"
                    options={Array.from({ length: 24 }, (_, i) => ({
                      label: `${String(i).padStart(2, "0")}:00 ET`,
                      value: String(i),
                    }))}
                    value={autoTrainingHourEt}
                    onChange={setAutoTrainingHourEt}
                    helpText="The Cron Job triggers daily. Training only runs at this hour."
                    disabled={!autoTrainingEnabled}
                  />
                </BlockStack>
              </Card>

              <Divider />

              {/* Auto metafield sync */}
              <Card>
                <BlockStack gap="400">
                  <Text variant="headingMd">Automatic Metafield Sync</Text>
                  <Text tone="subdued">
                    Render Cron Job triggers every 6 hours. APP checks these settings to decide whether to actually run.
                  </Text>
                  <Checkbox
                    label="Enable automatic metafield sync"
                    checked={autoSyncEnabled}
                    onChange={setAutoSyncEnabled}
                  />
                  <input
                    type="hidden"
                    name="auto_sync_enabled"
                    value={String(autoSyncEnabled)}
                  />
                  <Select
                    label="Run every X hours"
                    name="auto_sync_interval_hours"
                    options={[
                      { label: "Every 1 hour", value: "1" },
                      { label: "Every 2 hours", value: "2" },
                      { label: "Every 6 hours", value: "6" },
                      { label: "Every 12 hours", value: "12" },
                      { label: "Every 24 hours", value: "24" },
                    ]}
                    value={autoSyncIntervalHours}
                    onChange={setAutoSyncIntervalHours}
                    helpText="Sync only runs if pending items exist in the queue."
                    disabled={!autoSyncEnabled}
                  />
                </BlockStack>
              </Card>

              <Button variant="primary" submit loading={isSaving} disabled={isSaving}>
                Save Settings
              </Button>

            </BlockStack>
          </fetcher.Form>
        </Layout.Section>
      </Layout>
    </Page>
  );
}