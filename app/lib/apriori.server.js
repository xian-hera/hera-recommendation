/**
 * Apriori association rule algorithm
 * Input: baskets array [ [sku1, sku2], [sku1, sku3], ... ]
 * Output: recommendation map { sku1: [{id, confidence, coOccurrenceCount}], ... }
 */

// Count item frequency across all baskets
function countItemFrequency(baskets) {
  const freq = new Map();
  for (const basket of baskets) {
    for (const item of basket) {
      freq.set(item, (freq.get(item) || 0) + 1);
    }
  }
  return freq;
}

// Count co-occurrence frequency for all item pairs
function countPairFrequency(baskets) {
  const pairs = new Map();
  for (const basket of baskets) {
    const items = [...new Set(basket)]; // deduplicate within basket
    for (let i = 0; i < items.length; i++) {
      for (let j = 0; j < items.length; j++) {
        if (i === j) continue;
        const key = `${items[i]}||${items[j]}`;
        pairs.set(key, (pairs.get(key) || 0) + 1);
      }
    }
  }
  return pairs;
}

/**
 * Build recommendation map from baskets
 * @param {string[][]} baskets
 * @param {object} options
 * @param {number} options.minSupport - minimum number of orders a SKU must appear in, default 5
 * @param {number} options.minConfidence - minimum confidence score, default 0.01
 * @param {number} options.topN - max recommendations per product, default 10
 * @returns {Map<string, {id: string, confidence: number, coOccurrenceCount: number}[]>}
 */
export function buildRecommendations(baskets, options = {}) {
  const {
    minSupport = 5,
    minConfidence = 0.01,
    topN = 10,
  } = options;

  console.log(`Starting training with ${baskets.length} orders`);

  const itemFreq = countItemFrequency(baskets);
  console.log(`Unique SKUs: ${itemFreq.size}`);

  // Filter out low-frequency items
  const validItems = new Set(
    [...itemFreq.entries()]
      .filter(([, count]) => count >= minSupport)
      .map(([item]) => item)
  );
  console.log(`Valid SKUs (support >= ${minSupport}): ${validItems.size}`);

  // Filter baskets to only include valid items
  const filteredBaskets = baskets
    .map((basket) => basket.filter((item) => validItems.has(item)))
    .filter((basket) => basket.length >= 2);
  console.log(`Valid orders (2+ valid SKUs): ${filteredBaskets.length}`);

  const pairFreq = countPairFrequency(filteredBaskets);

  // Build recommendation map
  const recommendations = new Map();

  for (const [key, pairCount] of pairFreq.entries()) {
    const [itemA, itemB] = key.split("||");
    const confidence = pairCount / itemFreq.get(itemA);

    if (confidence < minConfidence) continue;

    if (!recommendations.has(itemA)) {
      recommendations.set(itemA, []);
    }
    recommendations.get(itemA).push({
      id: itemB,
      confidence,
      coOccurrenceCount: pairCount,
    });
  }

  // Sort by confidence, keep top N
  for (const [item, recs] of recommendations.entries()) {
    recommendations.set(
      item,
      recs.sort((a, b) => b.confidence - a.confidence).slice(0, topN)
    );
  }

  console.log(`Recommendation mappings generated: ${recommendations.size}`);
  return recommendations;
}