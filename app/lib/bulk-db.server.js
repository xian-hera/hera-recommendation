/**
 * Bulk Postgres writes (multi-row INSERT ... ON CONFLICT DO UPDATE).
 *
 * Added 2026-10-29. Training used to write one row per Prisma call
 * (upsert per order / per SKU / per recommendation, 8 in flight at a time).
 * With ~232k orders that alone took over an hour of the 2:00 ET cron run
 * before the process ran out of memory. Each helper here writes a whole
 * chunk in ONE statement, passing the rows as a single JSON parameter that
 * Postgres expands with jsonb_to_recordset — no dynamic SQL, fully
 * parameterised.
 *
 * Timestamps are written as UTC (NOW() AT TIME ZONE 'UTC'), matching how
 * Prisma stores DateTime columns.
 */

import prisma from "../db.server.js";

const CHUNK = 1000;

function dedupeBy(rows, key) {
  const m = new Map();
  for (const r of rows) m.set(r[key], r); // last one wins
  return [...m.values()];
}

async function inChunks(rows, fn) {
  let n = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    await fn(JSON.stringify(chunk));
    n += chunk.length;
  }
  return n;
}

/** rows: [{ sku, handle, title, productId }] */
export async function upsertSkuMappings(rows) {
  if (rows.length === 0) return 0;
  return inChunks(dedupeBy(rows, "sku"), (json) => prisma.$executeRaw`
    INSERT INTO sku_to_handle (sku, handle, title, product_id, updated_at)
    SELECT r.sku, r.handle, r.title, r."productId", NOW() AT TIME ZONE 'UTC'
    FROM jsonb_to_recordset(${json}::jsonb)
      AS r(sku text, handle text, title text, "productId" text)
    ON CONFLICT (sku) DO UPDATE SET
      handle     = EXCLUDED.handle,
      title      = EXCLUDED.title,
      product_id = EXCLUDED.product_id,
      updated_at = EXCLUDED.updated_at
  `);
}

/** rows: [{ orderId, customerId, skus: string[], createdAt: Date }] */
export async function upsertOrders(rows) {
  if (rows.length === 0) return 0;
  const mapped = rows.map((o) => ({
    orderId: o.orderId,
    customerId: o.customerId,
    skus: o.skus,
    createdAt: o.createdAt.toISOString(),
  }));
  return inChunks(dedupeBy(mapped, "orderId"), (json) => prisma.$executeRaw`
    INSERT INTO orders (order_id, customer_id, product_ids, created_at)
    SELECT r."orderId", r."customerId", r.skus,
           (r."createdAt"::timestamptz AT TIME ZONE 'UTC')
    FROM jsonb_to_recordset(${json}::jsonb)
      AS r("orderId" text, "customerId" text, skus jsonb, "createdAt" text)
    ON CONFLICT (order_id) DO UPDATE SET
      customer_id = EXCLUDED.customer_id,
      product_ids = EXCLUDED.product_ids
  `);
}

/** rows: [{ productId, recommendedIds: string[], confidence: number[], coOccurrenceCount: number[] }] */
export async function upsertRecommendations(rows) {
  if (rows.length === 0) return 0;
  return inChunks(dedupeBy(rows, "productId"), (json) => prisma.$executeRaw`
    INSERT INTO recommendations (product_id, recommended_ids, confidence, co_occurrence_count, updated_at)
    SELECT
      r."productId",
      r."recommendedIds",
      ARRAY(SELECT e::float8 FROM jsonb_array_elements_text(r.confidence) WITH ORDINALITY AS t(e, i) ORDER BY i),
      ARRAY(SELECT e::int    FROM jsonb_array_elements_text(r."coOccurrenceCount") WITH ORDINALITY AS t(e, i) ORDER BY i),
      NOW() AT TIME ZONE 'UTC'
    FROM jsonb_to_recordset(${json}::jsonb)
      AS r("productId" text, "recommendedIds" jsonb, confidence jsonb, "coOccurrenceCount" jsonb)
    ON CONFLICT (product_id) DO UPDATE SET
      recommended_ids     = EXCLUDED.recommended_ids,
      confidence          = EXCLUDED.confidence,
      co_occurrence_count = EXCLUDED.co_occurrence_count,
      updated_at          = EXCLUDED.updated_at
  `);
}
