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
} from "@shopify/polaris";
import { useState } from "react";

const prisma = new PrismaClient();

export const loader = async ({ request }) => {
  await authenticate.admin(request);

  const rows = await prisma.setting.findMany();
  const settings = Object.fromEntries(rows.map((r) => [r.key, r.value]));

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
    ["fallback_strategy", formData.get("fallback_strategy")],
    ["history_weight", formData.get("history_weight")],
    ["new_data_weight", formData.get("new_data_weight")],
  ];

  try {
    for (const [key, value] of updates) {
      await prisma.setting.upsert({
        where: { key },
        update: { value: value, updatedAt: new Date() },
        create: { key, value: value },
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
  const [fallbackStrategy, setFallbackStrategy] = useState(
    String(settings["fallback_strategy"] ?? "bestseller")
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
                  <Select
                    label="Fallback strategy (when not enough recommendations)"
                    name="fallback_strategy"
                    options={[
                      { label: "Show bestsellers", value: "bestseller" },
                      { label: "Show nothing", value: "none" },
                    ]}
                    value={fallbackStrategy}
                    onChange={setFallbackStrategy}
                  />
                </BlockStack>
              </Card>

              <Divider />

              {/* Scoring weights */}
              <Card>
                <BlockStack gap="400">
                  <Text variant="headingMd">Scoring Weights</Text>
                  <Text tone="subdued">
                    How much each signal contributes to the final recommendation score.
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
                    When merging new training results with historical data.
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