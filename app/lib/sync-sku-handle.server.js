/**
 * Sync SKU to product handle mapping from Shopify Admin API
 * Called during incremental training to keep mapping up to date
 * Also stores product ID for faster metafield writes
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export async function syncSkuToHandle(admin) {
  console.log("Syncing SKU to handle mapping...");

  let cursor = null;
  let hasNextPage = true;
  let synced = 0;

  while (hasNextPage) {
    const query = `
      query getProducts($cursor: String) {
        products(first: 250, after: $cursor) {
          pageInfo {
            hasNextPage
            endCursor
          }
          edges {
            node {
              id
              handle
              title
              variants(first: 100) {
                edges {
                  node {
                    sku
                  }
                }
              }
            }
          }
        }
      }
    `;

    const response = await admin.graphql(query, {
      variables: { cursor },
    });

    const data = await response.json();
    const products = data.data?.products;
    if (!products) break;

    for (const edge of products.edges) {
      const { id, handle, title, variants } = edge.node;
      for (const variantEdge of variants.edges) {
        const sku = variantEdge.node.sku?.trim();
        if (!sku) continue;

        await prisma.skuToHandle.upsert({
          where: { sku },
          update: { handle, title, productId: id },
          create: { sku, handle, title, productId: id },
        });
        synced++;
      }
    }

    hasNextPage = products.pageInfo.hasNextPage;
    cursor = products.pageInfo.endCursor;
    console.log(`Synced ${synced} SKU mappings so far...`);
  }

  console.log(`SKU to handle sync complete: ${synced} records.`);
  return synced;
}