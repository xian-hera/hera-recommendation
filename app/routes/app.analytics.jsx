import { useLoaderData, useFetcher } from "react-router";
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
  TextField,
  Button,
  Banner,
  Divider,
  Select,
} from "@shopify/polaris";
import { useState } from "react";

const prisma = new PrismaClient();

function getShopDomain(shop) {
  return shop?.replace(".myshopify.com", "") || "";
}

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

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

    const topRecs = [];
    for (let i = 0; i < Math.min(ids.length, 10); i++) {
      const info = skuMap[ids[i]];
      if (!info) continue;
      if (info.productId === sourceInfo.productId) continue;
      topRecs.push({
        sku: ids[i],
        confidence: confidences[i] || 0,
        ...info,
      });
      if (topRecs.length >= 3) break;
    }

    if (topRecs.length === 0) continue;

    const uniqueProductIds = new Set([sourceInfo.productId]);
    const deduplicatedRecs = topRecs.filter((r) => {
      if (uniqueProductIds.has(r.productId)) return false;
      uniqueProductIds.add(r.productId);
      return true;
    });

    if (deduplicatedRecs.length === 0) continue;

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

  // Fetch locations
  const locationsResponse = await admin.graphql(`
    query {
      locations(first: 50) {
        nodes {
          id
          name
        }
      }
    }
  `);
  const locationsData = await locationsResponse.json();
  const locations = locationsData.data?.locations?.nodes || [];

  return { shopDomain, bundleSuggestions, locations };
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  const formData = await request.formData();
  const intent = formData.get("intent");

  // SKU lookup
  if (intent === "sku_lookup") {
    const sku = formData.get("sku")?.trim();

    if (!sku) return { intent, error: "Please enter a SKU." };

    const rec = await prisma.recommendation.findUnique({
      where: { productId: sku },
    });

    if (!rec) return { intent, error: `No recommendation data found for SKU: ${sku}` };

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

    const sourceInfo = skuMap[sku];
    const results = [];

    for (let i = 0; i < Math.min(rec.recommendedIds.length, 20); i++) {
      const info = skuMap[rec.recommendedIds[i]];
      if (!info) continue;
      if (sourceInfo && info.productId === sourceInfo.productId) continue;
      if (results.some((r) => r.productId === info.productId)) continue;

      results.push({
        sku: rec.recommendedIds[i],
        title: info.title || rec.recommendedIds[i],
        productId: info.productId,
        handle: info.handle,
        confidence: rec.confidence[i] || 0,
      });

      if (results.length >= 5) break;
    }

    return {
      intent,
      sku,
      sourceTitle: sourceInfo?.title || sku,
      sourceProductId: sourceInfo?.productId || null,
      results,
    };
  }

  // Check stock
  if (intent === "check_stock") {
    const locationId = formData.get("locationId");
    const productIdsRaw = formData.get("productIds");

    if (!locationId || !productIdsRaw) {
      return { intent, error: "Missing location or product IDs." };
    }

    const productIds = JSON.parse(productIdsRaw);

    // Refresh locations list while we're at it
    const locationsResponse = await admin.graphql(`
      query {
        locations(first: 50) {
          nodes { id name }
        }
      }
    `);
    const locationsData = await locationsResponse.json();
    const locations = locationsData.data?.locations?.nodes || [];

    // Extract numeric location ID for query filter
    const numericLocationId = locationId.split("/").pop();

    // Query inventory in batches of 10 products
    const inventoryMap = {};
    const batchSize = 10;

    for (let i = 0; i < productIds.length; i += batchSize) {
      const batch = productIds.slice(i, i + batchSize);
      const idsGql = batch.map((id) => `"${id}"`).join(", ");

      const response = await admin.graphql(`
        query {
          nodes(ids: [${idsGql}]) {
            ... on Product {
              id
              variants(first: 100) {
                nodes {
                  inventoryItem {
                    inventoryLevels(first: 1, query: "location_id:${numericLocationId}") {
                      nodes {
                        quantities(names: ["available"]) {
                          name
                          quantity
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      `);

      const data = await response.json();
      const nodes = data.data?.nodes || [];

      for (const product of nodes) {
        if (!product?.id) continue;
        let total = 0;
        let found = false;
        for (const variant of product.variants?.nodes || []) {
          const levels = variant.inventoryItem?.inventoryLevels?.nodes || [];
          for (const level of levels) {
            const availableQty = level.quantities?.find((q) => q.name === "available");
            if (availableQty !== undefined) {
              total += availableQty.quantity ?? 0;
              found = true;
            }
          }
        }
        inventoryMap[product.id] = found ? total : null;
      }
    }

    return { intent, inventoryMap, locations };
  }

  return { intent, error: "Unknown intent." };
};

export default function Analytics() {
  const { shopDomain, bundleSuggestions, locations: initialLocations } = useLoaderData();
  const skuFetcher = useFetcher();
  const stockFetcher = useFetcher();

  const [skuInput, setSkuInput] = useState("");
  const [selectedLocation, setSelectedLocation] = useState(
    initialLocations[0]?.id || ""
  );
  const [locations, setLocations] = useState(initialLocations);
  const [inventoryMap, setInventoryMap] = useState({});

  const isSearching = skuFetcher.state !== "idle";
  const isCheckingStock = stockFetcher.state !== "idle";
  const searchResult = skuFetcher.data?.intent === "sku_lookup" ? skuFetcher.data : null;

  // Update locations and inventory when stock check completes
  const stockData = stockFetcher.data;
  if (
    stockData?.intent === "check_stock" &&
    stockData?.inventoryMap &&
    stockData.inventoryMap !== inventoryMap
  ) {
    setInventoryMap(stockData.inventoryMap);
    if (stockData.locations?.length > 0) {
      setLocations(stockData.locations);
    }
  }

  function adminProductUrl(productId) {
    const numericId = productId?.split("/").pop();
    return `https://admin.shopify.com/store/${shopDomain}/products/${numericId}`;
  }

  function handleCheckStock() {
    const allProductIds = new Set();
    for (const bundle of bundleSuggestions) {
      if (bundle.source.productId) allProductIds.add(bundle.source.productId);
      for (const rec of bundle.recommendations) {
        if (rec.productId) allProductIds.add(rec.productId);
      }
    }

    const formData = new FormData();
    formData.append("intent", "check_stock");
    formData.append("locationId", selectedLocation);
    formData.append("productIds", JSON.stringify([...allProductIds]));
    stockFetcher.submit(formData, { method: "post" });
  }

  function stockDisplay(productId) {
    if (Object.keys(inventoryMap).length === 0) return null;
    const qty = inventoryMap[productId];
    if (qty === undefined) return "(X)";
    if (qty === null) return "(X)";
    return `(${qty})`;
  }

  const locationOptions = locations.map((loc) => ({
    label: loc.name,
    value: loc.id,
  }));

  return (
    <Page title="Analytics">
      <Layout>

        {/* SKU lookup */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <BlockStack gap="100">
                <Text variant="headingMd">Product Recommendation Lookup</Text>
                <Text tone="subdued">
                  Enter a SKU to see the top 5 products most frequently purchased with it.
                </Text>
              </BlockStack>

              <skuFetcher.Form method="post">
                <input type="hidden" name="intent" value="sku_lookup" />
                <InlineStack gap="300" align="start">
                  <div style={{ flex: 1 }}>
                    <TextField
                      label="SKU"
                      labelHidden
                      name="sku"
                      value={skuInput}
                      onChange={setSkuInput}
                      placeholder="e.g. 817513015472"
                      autoComplete="off"
                    />
                  </div>
                  <Button
                    variant="primary"
                    submit
                    loading={isSearching}
                    disabled={isSearching || !skuInput.trim()}
                  >
                    Look up
                  </Button>
                </InlineStack>
              </skuFetcher.Form>

              {searchResult && (
                <>
                  <Divider />
                  {searchResult.error ? (
                    <Banner tone="critical">{searchResult.error}</Banner>
                  ) : (
                    <BlockStack gap="300">
                      <InlineStack gap="200" align="start">
                        <Text tone="subdued">Source product:</Text>
                        <Link
                          url={adminProductUrl(searchResult.sourceProductId)}
                          target="_blank"
                          removeUnderline
                        >
                          <Text fontWeight="semibold">{searchResult.sourceTitle}</Text>
                        </Link>
                        <Text tone="subdued">({searchResult.sku})</Text>
                      </InlineStack>

                      {searchResult.results.length === 0 ? (
                        <Text tone="subdued">No recommendations found for this SKU.</Text>
                      ) : (
                        <BlockStack gap="200">
                          {searchResult.results.map((r, i) => (
                            <InlineStack key={i} gap="400" align="start">
                              <Badge tone="success">
                                {(r.confidence * 100).toFixed(1)}% match
                              </Badge>
                              <Link
                                url={adminProductUrl(r.productId)}
                                target="_blank"
                                removeUnderline
                              >
                                <Text>{r.title}</Text>
                              </Link>
                              <Text tone="subdued" variant="bodySm">{r.sku}</Text>
                            </InlineStack>
                          ))}
                        </BlockStack>
                      )}
                    </BlockStack>
                  )}
                </>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Bundle suggestions */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <BlockStack gap="100">
                  <Text variant="headingMd">Bundle Suggestions</Text>
                  <Text tone="subdued">
                    Top 10 product groups frequently purchased together, based on training data.
                  </Text>
                </BlockStack>

                <InlineStack gap="200" blockAlign="center">
                  {locationOptions.length > 0 && (
                    <div style={{ minWidth: "180px" }}>
                      <Select
                        label="Location"
                        labelHidden
                        options={locationOptions}
                        value={selectedLocation}
                        onChange={setSelectedLocation}
                      />
                    </div>
                  )}
                  <Button
                    onClick={handleCheckStock}
                    loading={isCheckingStock}
                    disabled={isCheckingStock || !selectedLocation}
                  >
                    Check Stock
                  </Button>
                </InlineStack>
              </InlineStack>

              {stockData?.intent === "check_stock" && stockData?.error && (
                <Banner tone="critical">{stockData.error}</Banner>
              )}

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
                          <InlineStack gap="200" align="start" wrap={false}>
                            <Text tone="subdued" variant="bodySm" as="span">Source</Text>
                            <Link
                              url={adminProductUrl(bundle.source.productId)}
                              target="_blank"
                              removeUnderline
                            >
                              <Text variant="bodySm" fontWeight="semibold" as="span">
                                {bundle.source.title}
                              </Text>
                            </Link>
                            {stockDisplay(bundle.source.productId) && (
                              <Text variant="bodySm" tone="subdued" as="span">
                                {stockDisplay(bundle.source.productId)}
                              </Text>
                            )}
                          </InlineStack>

                          {bundle.recommendations.map((rec, j) => (
                            <InlineStack key={j} gap="200" align="start" wrap={false}>
                              <Text tone="subdued" variant="bodySm" as="span">
                                +{(rec.confidence * 100).toFixed(1)}%
                              </Text>
                              <Link
                                url={adminProductUrl(rec.productId)}
                                target="_blank"
                                removeUnderline
                              >
                                <Text variant="bodySm" as="span">
                                  {rec.title}
                                </Text>
                              </Link>
                              {stockDisplay(rec.productId) && (
                                <Text variant="bodySm" tone="subdued" as="span">
                                  {stockDisplay(rec.productId)}
                                </Text>
                              )}
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