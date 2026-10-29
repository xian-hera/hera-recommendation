/**
 * Apriori association rule algorithm (pairwise "bought A → also bought B")
 * Input: baskets array [ [sku1, sku2], [sku1, sku3], ... ]
 * Output: recommendation map { sku1: [{id, confidence, coOccurrenceCount}], ... }
 *
 * 2026-10-29: rewritten for memory. The previous version counted pairs in a
 * single Map keyed by the string `${skuA}||${skuB}`. On 2026-10-27/28/29 the
 * cron run fed it ~232k orders / ~12.7k SKUs and the web service died at
 * ~224 MB heap with "JavaScript heap out of memory" (Render: Exited with
 * status 134) right after "Valid orders (2+ valid SKUs): 231896" — i.e. in
 * that pair-counting loop. Millions of long string keys (plus the
 * key.split() garbage afterwards) was the bulk of it.
 *
 * Now every SKU is mapped to a small integer, baskets are packed into flat
 * Int32Arrays, and co-occurrences are counted ONE SOURCE SKU AT A TIME via
 * an inverted index (SKU → baskets containing it) into a single reusable
 * counter array. Peak memory is proportional to the total number of basket
 * items (a few MB for 230k orders), not to the number of distinct pairs
 * (tens of millions), and no pair table is ever built. Same rules, same
 * output shape; total work is the same as before.
 */

/**
 * Build recommendation map from baskets
 * @param {string[][]} baskets
 * @param {object} options
 * @param {number} options.minSupport - minimum number of orders a SKU must appear in, default 5
 * @param {number} options.minConfidence - minimum confidence score, default 0.01
 * @param {number} options.topN - max recommendations per product, default 10
 * @param {Set<string>|null} options.allowedSkus - if given, SKUs outside this set are ignored entirely
 * @returns {Map<string, {id: string, confidence: number, coOccurrenceCount: number}[]>}
 */
export function buildRecommendations(baskets, options = {}) {
  const {
    minSupport = 5,
    minConfidence = 0.01,
    topN = 10,
    allowedSkus = null,
  } = options;

  console.log(`Starting training with ${baskets.length} orders`);

  // 1) Intern SKUs → integer ids; de-duplicate within each basket; count
  //    item frequency (number of orders containing the SKU).
  const skuToIdx = new Map();
  const idxToSku = [];
  let freq = new Int32Array(1024);
  const packed = []; // de-duplicated int baskets with >= 2 items
  let packedTotal = 0;

  for (const basket of baskets) {
    const seen = new Set();
    for (const raw of basket) {
      if (allowedSkus && !allowedSkus.has(raw)) continue;
      let idx = skuToIdx.get(raw);
      if (idx === undefined) {
        idx = idxToSku.length;
        skuToIdx.set(raw, idx);
        idxToSku.push(raw);
        if (idx >= freq.length) {
          const grown = new Int32Array(freq.length * 2);
          grown.set(freq);
          freq = grown;
        }
      }
      seen.add(idx);
    }
    for (const idx of seen) freq[idx]++;
    if (seen.size >= 2) {
      packed.push(Int32Array.from(seen));
      packedTotal += seen.size;
    }
  }
  const nItems = idxToSku.length;
  console.log(`Unique SKUs: ${nItems}`);

  // 2) Drop low-support items.
  const valid = new Uint8Array(nItems);
  let validCount = 0;
  for (let i = 0; i < nItems; i++) {
    if (freq[i] >= minSupport) {
      valid[i] = 1;
      validCount++;
    }
  }
  console.log(`Valid SKUs (support >= ${minSupport}): ${validCount}`);

  // 3) Flat CSR layout of baskets restricted to valid items (>= 2 left).
  const basketItems = new Int32Array(packedTotal);
  const basketStart = new Int32Array(packed.length + 1);
  let nb = 0;
  let pos = 0;
  for (let p = 0; p < packed.length; p++) {
    const b = packed[p];
    const begin = pos;
    for (let k = 0; k < b.length; k++) if (valid[b[k]]) basketItems[pos++] = b[k];
    if (pos - begin >= 2) {
      basketStart[++nb] = pos;
    } else {
      pos = begin; // fewer than 2 valid items: discard
    }
    packed[p] = null;
  }
  packed.length = 0;
  console.log(`Valid orders (2+ valid SKUs): ${nb}`);

  // 4) Inverted index: item → list of basket numbers containing it.
  const itemStart = new Int32Array(nItems + 1);
  for (let i = 0; i < pos; i++) itemStart[basketItems[i] + 1]++;
  for (let i = 0; i < nItems; i++) itemStart[i + 1] += itemStart[i];
  const itemBaskets = new Int32Array(pos);
  const fill = itemStart.slice(0, nItems);
  for (let bi = 0; bi < nb; bi++) {
    for (let k = basketStart[bi]; k < basketStart[bi + 1]; k++) {
      itemBaskets[fill[basketItems[k]]++] = bi;
    }
  }

  // 5) For each source item A: count co-occurring items B across A's
  //    baskets in a reusable dense counter, then keep top N by confidence.
  const counter = new Int32Array(nItems);
  const touched = new Int32Array(nItems);
  const recommendations = new Map();

  for (let a = 0; a < nItems; a++) {
    const from = itemStart[a];
    const to = itemStart[a + 1];
    if (from === to) continue;

    let nTouched = 0;
    for (let t = from; t < to; t++) {
      const bi = itemBaskets[t];
      for (let k = basketStart[bi]; k < basketStart[bi + 1]; k++) {
        const b = basketItems[k];
        if (b === a) continue;
        if (counter[b] === 0) touched[nTouched++] = b;
        counter[b]++;
      }
    }

    const freqA = freq[a];
    const recs = [];
    for (let t = 0; t < nTouched; t++) {
      const b = touched[t];
      const pairCount = counter[b];
      counter[b] = 0; // reset for next source item
      const confidence = pairCount / freqA;
      if (confidence < minConfidence) continue;
      recs.push({ id: idxToSku[b], confidence, coOccurrenceCount: pairCount });
    }
    if (recs.length === 0) continue;
    recs.sort((x, y) => y.confidence - x.confidence);
    recommendations.set(idxToSku[a], recs.length > topN ? recs.slice(0, topN) : recs);
  }

  console.log(`Recommendation mappings generated: ${recommendations.size}`);
  return recommendations;
}
