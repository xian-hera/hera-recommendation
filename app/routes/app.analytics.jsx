import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { PrismaClient } from "@prisma/client";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  EmptyState,
  InlineGrid,
  InlineStack,
  Badge,
  Link,
} from "@shopify/polaris";

const prisma = new PrismaClient();

function getShopDomain(shop) {
  return shop?.replace(".myshopify.com", "") || "";
}

export const loader = async ({ request }) => {
  await authenticate.admin(request);

  const session = await prisma.session.findFirst({
    where: { isOnline: false },
    orderBy: { expires: "desc" },
  });
  const shopDomain = getShopDomain(session?.shop);

  const topRecommendations = await prisma.recommendation.findMany({
    orderBy: { updatedAt: "desc" },
    take: 500,
  });

  const skuMappings = await prisma.skuToHandle.findMany({
    where: { productId: { not: null } },
  });
  const skuMap = Object.fromEntries(
    skuMappings.map((m) => [m.sku, {
      handle: m.handle,
      title: m.title,
      productId: m.productId,
    }])
  );

  const bundleSuggestions = [];
  const seen = new Set();

  const sorted = topRecommendations
    .map((rec) => {
      const topConfidence = rec.confidence?.[0] ?? 0;
      return { rec, topConfidence };
    })
    .sort((a, b) => b.topConfidence - a.topConfidence);

  for (const { rec } of sorted) {
    if (bundleSuggestions.length >= 10) break;

    const sourceInfo = skuMap[rec.productId];
    if (!sourceInfo) continue;

    const ids = rec.recommendedIds;
    const confidences = rec.confidence;
    if (!ids || ids.length === 0) continue;

    // Take top 3 recommended products, excluding same product as source
    const topRecs = [];
    for (let i = 0; i < Math.min(ids.length, 10); i++) {
      const info = skuMap[ids[i]];
      if (!info) continue;

      // Skip if same product as source (catches different variants of same product)
      if (info.productId === sourceInfo.productId) continue;

      topRecs.push({
        sku: ids[i],
        confidence: confidences[i] || 0,
        ...info,
      });

      if (topRecs.length >= 3) break;
    }

    if (topRecs.length === 0) continue;

    // Deduplicate by product ID within the bundle
    const uniqueProductIds = new Set([sourceInfo.productId]);
    const deduplicatedRecs = topRecs.filter((r) => {
      if (uniqueProductIds.has(r.productId)) return false;
      uniqueProductIds.add(r.productId);
      return true;
    });

    if (deduplicatedRecs.length === 0) continue;

    // Build bundle key using product IDs (not SKUs) to catch variant duplicates
    const allProductIds = [sourceInfo.productId, ...deduplicatedRecs.map((r) => r.productId)].sort();
    const bundleKey = allProductIds.join("|");
    if (seen.has(bundleKey)) continue;
    seen.add(bundleKey);

    const avgConfidence =
      deduplicatedRecs.reduce((sum, r) => sum + r.confidence, 0) / deduplicatedRecs.length;

    bundleSuggestions.push({
      source: {
        sku: rec.productId,
        title: sourceInfo.title || rec.productId,
        productId: sourceInfo.productId,
      },
      recommendations: deduplicatedRecs.map((r) => ({
        sku: r.sku,
        title: r.title || r.sku,
        productId: r.productId,
        confidence: r.confidence,
      })),
      avgConfidence: (avgConfidence * 100).toFixed(1),
    });
  }

  return {
    shopDomain,
    bundleSuggestions,
  };
};

export default function Analytics() {
  const { shopDomain, bundleSuggestions } = useLoaderData();

  function adminProductUrl(productId) {
    const numericId = productId?.split("/").pop();
    return `https://admin.shopify.com/store/${shopDomain}/products/${numericId}`;
  }

  return (
    <Page title="Analytics">
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <BlockStack gap="100">
                <Text variant="headingMd">Bundle Suggestions</Text>
                <Text tone="subdued">
                  Top 10 product groups frequently purchased together, based on training data.
                  Click any product title to open it in Shopify Admin.
                </Text>
              </BlockStack>

              {bundleSuggestions.length === 0 ? (
                <EmptyState heading="No training data yet" image="">
                  <p>Run your first training to see bundle suggestions.</p>
                </EmptyState>
              ) : (
                <InlineGrid columns={2} gap="400">
                  {bundleSuggestions.map((bundle, i) => (
                    <Card key={i} background="bg-surface-secondary">
                      <BlockStack gap="300">
                        <InlineStack align="space-between">
                          <Text variant="headingSm">Bundle {i + 1}</Text>
                          <Badge tone="success">{bundle.avgConfidence}% match</Badge>
                        </InlineStack>

                        <BlockStack gap="200">
                          <InlineStack gap="200" align="start">
                            <Text tone="subdued" variant="bodySm">Source</Text>
                            <Link
                              url={adminProductUrl(bundle.source.productId)}
                              target="_blank"
                              removeUnderline
                            >
                              <Text variant="bodySm" fontWeight="semibold">
                                {bundle.source.title}
                              </Text>
                            </Link>
                          </InlineStack>

                          {bundle.recommendations.map((rec, j) => (
                            <InlineStack key={j} gap="200" align="start">
                              <Text tone="subdued" variant="bodySm">
                                +{(rec.confidence * 100).toFixed(1)}%
                              </Text>
                              <Link
                                url={adminProductUrl(rec.productId)}
                                target="_blank"
                                removeUnderline
                              >
                                <Text variant="bodySm">
                                  {rec.title}
                                </Text>
                              </Link>
                            </InlineStack>
                          ))}
                        </BlockStack>
                      </BlockStack>
                    </Card>
                  ))}
                </InlineGrid>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}