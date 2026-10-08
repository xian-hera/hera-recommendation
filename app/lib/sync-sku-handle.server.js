/**
 * Sync SKU to product handle mapping from Shopify Admin API
 * Called during incremental training to keep mapping up to date
 * Also stores product ID for faster metafield writes
 *
 * 2026-09-28: this used to upsert one variant at a time in a fully
 * sequential loop — at Hera's real catalog size (10,000+ SKUs) that's
 * 10,000+ one-at-a-time DB round trips, run on EVERY training call (cron or
 * manual), before training even looks at a single order. That's the
 * dominant cost behind /api/cron/train hanging for 10+ minutes with zero
 * response and then crashing the whole web service (Render: "Exited with
 * status 134") — see concurrency.server.ts's header for the full story. Now
 * bounded-concurrent instead of one-at-a-time; same upserts, same data,
 * just several in flight at once instead of strictly one.
 */

import prisma from "../db.server.js";
import { mapWithConcurrencyLimit, DEFAULT_CONCURRENCY } from "./concurrency.server.js";

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

    // Flatten this page's (product, variant) pairs into one list of
    // upsert jobs, then run them with bounded concurrency instead of one
    // sequential loop per page — see this file's header note.
    const variantJobs = [];
    for (const edge of products.edges) {
      const { id, handle, title, variants } = edge.node;
      for (const variantEdge of variants.edges) {
        const sku = variantEdge.node.sku?.trim();
        if (!sku) continue;
        variantJobs.push({ sku, handle, title, productId: id });
      }
    }

    await mapWithConcurrencyLimit(variantJobs, DEFAULT_CONCURRENCY, async (job) => {
      await prisma.skuToHandle.upsert({
        where: { sku: job.sku },
        update: { handle: job.handle, title: job.title, productId: job.productId },
        create: job,
      });
      synced++;
    });

    hasNextPage = products.pageInfo.hasNextPage;
    cursor = products.pageInfo.endCursor;
    console.log(`Synced ${synced} SKU mappings so far...`);
  }

  console.log(`SKU to handle sync complete: ${synced} records.`);
  return synced;
}
