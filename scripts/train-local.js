/**
 * Local initialization training script
 * Usage: node scripts/train-local.js --file orders1.csv --file orders2.csv
 */

import fs from "fs";
import path from "path";
import { parse } from "csv-parse/sync";
import pg from "pg";
import { buildRecommendations } from "../app/lib/apriori.server.js";
import * as dotenv from "dotenv";

dotenv.config();

const { Pool } = pg;

// Load exclude SKUs list
function loadExcludeSkus() {
  const filePath = path.resolve("scripts/exclude-skus.json");
  if (!fs.existsSync(filePath)) {
    console.log("No exclude-skus.json found, skipping exclusion filter.");
    return new Set();
  }
  const skus = JSON.parse(fs.readFileSync(filePath, "utf8"));
  console.log(`Loaded ${skus.length} excluded SKUs.`);
  return new Set(skus);
}

// Parse CLI args
function getArgs() {
  const args = process.argv.slice(2);
  const files = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--file" && args[i + 1]) {
      files.push(args[i + 1]);
      i++;
    }
  }
  if (files.length === 0) {
    console.error("Usage: node scripts/train-local.js --file orders.csv");
    process.exit(1);
  }
  return { files };
}

// Parse CSV, return baskets array
function parseCSV(filePath, excludeSkus) {
  console.log(`Reading file: ${filePath}`);
  const content = fs.readFileSync(path.resolve(filePath), "utf8");
  const records = parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true, // handle UTF-8 BOM from Shopify exports
  });

  const orderMap = new Map();
  let skippedEmpty = 0;
  let skippedExcluded = 0;

  for (const row of records) {
    const orderId = row["Name"];
    const sku = row["Lineitem sku"]?.trim();

    if (!orderId || !sku || sku === "") {
      skippedEmpty++;
      continue;
    }

    if (excludeSkus.has(sku)) {
      skippedExcluded++;
      continue;
    }

    if (!orderMap.has(orderId)) {
      orderMap.set(orderId, new Set());
    }
    orderMap.get(orderId).add(sku);
  }

  console.log(
    `Orders: ${orderMap.size} | Skipped empty: ${skippedEmpty} | Skipped excluded: ${skippedExcluded}`
  );
  return [...orderMap.values()].map((set) => [...set]);
}

// Save recommendations to database
async function saveToDatabase(pool, recommendations) {
  console.log(`Writing ${recommendations.size} records to database...`);
  const startTime = Date.now();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query("TRUNCATE TABLE recommendations");

    let count = 0;
    for (const [productId, recs] of recommendations.entries()) {
      const recommendedIds = recs.map((r) => r.id);
      const confidence = recs.map((r) => r.confidence);
      const coOccurrenceCount = recs.map((r) => r.coOccurrenceCount);

      await client.query(
        `INSERT INTO recommendations (product_id, recommended_ids, confidence, co_occurrence_count, updated_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [productId, JSON.stringify(recommendedIds), confidence, coOccurrenceCount]
      );
      count++;

      if (count % 1000 === 0) {
        console.log(`Progress: ${count} / ${recommendations.size}`);
      }
    }

    await client.query("COMMIT");
    const duration = Date.now() - startTime;
    console.log(`Write complete in ${duration}ms`);
    return { count, duration };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// Save training log
async function saveTrainingLog(pool, { ordersCount, status, durationMs, errorMsg }) {
  await pool.query(
    `INSERT INTO training_logs (triggered_by, orders_count, status, duration_ms, error_msg, created_at)
     VALUES ($1, $2, $3, $4, $5, NOW())`,
    ["csv_upload", ordersCount, status, durationMs, errorMsg || null]
  );
}

// Main
async function main() {
  const { files } = getArgs();
  const excludeSkus = loadExcludeSkus();
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  const startTime = Date.now();

  try {
    // Parse and merge all CSV files
    let allBaskets = [];
    for (const file of files) {
      const baskets = parseCSV(file, excludeSkus);
      allBaskets = allBaskets.concat(baskets);
    }
    console.log(`Total orders after merge: ${allBaskets.length}`);

    // Run Apriori
    const recommendations = buildRecommendations(allBaskets, {
      minSupport: 5,
      minConfidence: 0.01,
      topN: 10,
    });

    // Write to database
    const { count } = await saveToDatabase(pool, recommendations);

    // Log success
    await saveTrainingLog(pool, {
      ordersCount: allBaskets.length,
      status: "success",
      durationMs: Date.now() - startTime,
    });

    console.log(`\n✅ Training complete!`);
    console.log(`   Orders processed: ${allBaskets.length}`);
    console.log(`   Recommendation mappings: ${count}`);
    console.log(`   Total time: ${Date.now() - startTime}ms`);
  } catch (err) {
    console.error("Training failed:", err);
    await saveTrainingLog(pool, {
      ordersCount: 0,
      status: "failed",
      durationMs: Date.now() - startTime,
      errorMsg: err.message,
    });
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();