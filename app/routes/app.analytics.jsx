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

// Get shop domain for admin links
function getShopDomain(shop) {
  return shop?.replace(".myshopify.com", "") || "";
}

export const loader = async ({ request }) => {
  await authenticate.admin(request);

  // Get session for shop domain
  const session = await prisma.session.findFirst({
    where: { isOnline: false },
    orderBy: { expires: "desc" },
  });
  const shopDomain = getShopDomain(session?.shop);

  // Load top recommendations by confidence
  const topRecommendations = await prisma.recommendation.findMany({
    orderBy: { updatedAt: "desc" },
    take: 500,
  });

  // Load SKU to handle + title + productId mapping
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

  // Build bundle suggestions
  // Each bundle = source product + top 1-3 recommended products
  // Score = average confidence of the group
  const bundleSuggestions = [];
  const seen = new Set();

  // Sort all recommendations by their top confidence score
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

    // Take top 3 recommended products that have valid mappings
    const topRecs = [];
    for (let i = 0; i < Math.min(ids.length, 5); i++) {
      const info = skuMap[ids[i]];
      if (info) {
        topRecs.push({
          sku: ids[i],
          confidence: confidences[i] || 0,
          ...info,
        });
      }
      if (topRecs.length >= 3) break;
    }

    if (topRecs.length === 0) continue;

    // Build bundle key to avoid duplicates
    const allSkus = [rec.productId, ...topRecs.map((r) => r.sku)].sort();
    const bundleKey = allSkus.join("|");
    if (seen.has(bundleKey)) continue;
    seen.add(bundleKey);

    const avgConfidence =
      topRecs.reduce((sum, r) => sum + r.confidence, 0) / topRecs.length;

    bundleSuggestions.push({
      source: {
        sku: rec.productId,
        title: sourceInfo.title || rec.productId,
        productId: sourceInfo.productId,
      },
      recommendations: topRecs.map((r) => ({
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
        {/* Bundle suggestions */}
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
                          {/* Source product */}
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

                          {/* Recommended products */}
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