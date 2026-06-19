import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { PrismaClient } from "@prisma/client";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  DataTable,
  EmptyState,
  InlineGrid,
} from "@shopify/polaris";

const prisma = new PrismaClient();

export const loader = async ({ request }) => {
  await authenticate.admin(request);

  // Overall event counts
  const clickCount = await prisma.recommendationEvent.count({
    where: { eventType: "click" },
  });
  const impressionCount = await prisma.recommendationEvent.count({
    where: { eventType: "impression" },
  });
  const addToCartCount = await prisma.recommendationEvent.count({
    where: { eventType: "add_to_cart" },
  });

  const ctr = impressionCount > 0
    ? ((clickCount / impressionCount) * 100).toFixed(2)
    : "0.00";

  // Top recommendation pairs (A → B clicked most)
  const topPairs = await prisma.recommendationEvent.groupBy({
    by: ["sourceProduct", "recommendedProduct"],
    where: { eventType: "click" },
    _count: { id: true },
    orderBy: { _count: { id: "desc" } },
    take: 10,
  });

  // Bundle suggestions — top co-purchased product groups
  // Find products with highest confidence recommendations
  const topRecommendations = await prisma.recommendation.findMany({
    orderBy: { updatedAt: "desc" },
    take: 100,
  });

  // Build bundle suggestions from recommendations
  const bundleSuggestions = [];
  const seen = new Set();

  for (const rec of topRecommendations) {
    const ids = rec.recommendedIds;
    const confidences = rec.confidence;

    if (!ids || ids.length === 0) continue;

    // Take top 3 recommended products for this source
    const top = ids.slice(0, 3);
    const avgConfidence = confidences
      .slice(0, 3)
      .reduce((a, b) => a + b, 0) / Math.min(3, confidences.length);

    const bundleKey = [rec.productId, ...top].sort().join("|");
    if (seen.has(bundleKey)) continue;
    seen.add(bundleKey);

    bundleSuggestions.push({
      products: [rec.productId, ...top],
      coPurchaseRate: (avgConfidence * 100).toFixed(1),
    });
  }

  // Sort by co-purchase rate, take top 20
  bundleSuggestions.sort((a, b) => b.coPurchaseRate - a.coPurchaseRate);
  const topBundles = bundleSuggestions.slice(0, 20);

  return {
    clickCount,
    impressionCount,
    addToCartCount,
    ctr,
    topPairs,
    topBundles,
  };
};

export default function Analytics() {
  const {
    clickCount,
    impressionCount,
    addToCartCount,
    ctr,
    topPairs,
    topBundles,
  } = useLoaderData();

  const pairRows = topPairs.map((pair) => [
    pair.sourceProduct,
    pair.recommendedProduct,
    pair._count.id.toLocaleString(),
  ]);

  const bundleRows = topBundles.map((bundle, i) => [
    i + 1,
    bundle.products.join(" + "),
    `${bundle.coPurchaseRate}%`,
  ]);

  return (
    <Page title="Analytics">
      <Layout>
        {/* Overview stats */}
        <Layout.Section>
          <InlineGrid columns={4} gap="400">
            <Card>
              <BlockStack gap="100">
                <Text tone="subdued">Impressions</Text>
                <Text variant="heading2xl">{impressionCount.toLocaleString()}</Text>
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="100">
                <Text tone="subdued">Clicks</Text>
                <Text variant="heading2xl">{clickCount.toLocaleString()}</Text>
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="100">
                <Text tone="subdued">Add to cart</Text>
                <Text variant="heading2xl">{addToCartCount.toLocaleString()}</Text>
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="100">
                <Text tone="subdued">Click-through rate</Text>
                <Text variant="heading2xl">{ctr}%</Text>
              </BlockStack>
            </Card>
          </InlineGrid>
        </Layout.Section>

        {/* Top recommendation pairs */}
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text variant="headingMd">Top Recommendation Pairs</Text>
              <Text tone="subdued">Most clicked A → B recommendation pairs.</Text>
              {topPairs.length === 0 ? (
                <EmptyState heading="No click data yet" image="">
                  <p>Data will appear once customers start interacting with recommendations.</p>
                </EmptyState>
              ) : (
                <DataTable
                  columnContentTypes={["text", "text", "numeric"]}
                  headings={["Source product", "Recommended product", "Clicks"]}
                  rows={pairRows}
                />
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Bundle suggestions */}
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text variant="headingMd">Bundle Suggestions</Text>
              <Text tone="subdued">
                Product groups frequently purchased together, based on training data.
              </Text>
              {topBundles.length === 0 ? (
                <EmptyState heading="No training data yet" image="">
                  <p>Run your first training to see bundle suggestions.</p>
                </EmptyState>
              ) : (
                <DataTable
                  columnContentTypes={["numeric", "text", "text"]}
                  headings={["#", "Products", "Co-purchase rate"]}
                  rows={bundleRows}
                />
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}