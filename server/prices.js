import { sql } from './admin.js';
import { cached } from './cache.js';
import { config } from './config.js';
import { fromSnapshot } from './context.js';
import { snapPrices } from './snapshot.js';

// What a generation costs, from the product's own numbers (two small Trino queries a day):
//   media jobs (video, music, voice…)  the ListCosts price list the agent reads: per Genix graph
//                                      (the graph id every job reports), a unit (SECOND or
//                                      GENERATION) and usdPerUnit. A call costs usdPerUnit × the
//                                      seconds it asked for, or × 1.
//   image tools                        the credits log (prod.wixel.credits_log): Wix's actual cost
//                                      per call for each image model, averaged over 7 days.
// List prices, not invoices: a failed call is counted as free.
const DAY = 86400000;
const ENTRIES = 'domain_events.www_wixel_agent.v1_session_entry_crud';

export function prices() {
  // A read-only copy shows the prices the daily build saved.
  if (fromSnapshot(config)) return snapPrices();
  return cached('meta', 'prices-v1', DAY, async () => {
    const [list] = await sql(`SELECT max_by(element_at(tool_result.result, 'output'), created_date) AS out
      FROM ${ENTRIES}
      WHERE entry_type = 'TOOL_RESULT' AND tool_result.tool_name = 'invoke_rpc' AND created_date >= current_timestamp - INTERVAL '3' HOUR
        AND element_at(tool_result.result, 'output') LIKE '{"availableCredits"%'`).catch(() => []);
    const graphs = {};
    try {
      for (const c of JSON.parse(list?.out || '{}').costs || []) {
        if (c.resourceId) graphs[c.resourceId] = { name: c.modelName, unit: c.unit, usdPerUnit: Number(c.usdPerUnit) };
      }
    } catch {}
    const rows = await sql(`SELECT action, count(*) AS n, avg(wix_cost_usd) AS usd
      FROM prod.wixel.credits_log
      WHERE transaction_date >= current_date - INTERVAL '7' DAY
      GROUP BY 1 HAVING count(*) >= 3 ORDER BY 2 DESC LIMIT 300`).catch(() => []);
    const images = {};
    for (const r of rows) {
      // "AI image editing (gpt-image-2.5-flare via Wix AI Gateway)", "AI image editing (bytedance/seedream/v5/pro/edit)"
      const m = /^AI image (?:editing|generation|upscaling|vectorization) \(([^)]+?)(?: via [^)]+)?\)$/i.exec(r.action || '');
      if (m && !(m[1] in images)) images[m[1]] = { usd: Number(r.usd), n: Number(r.n) };
    }
    return { value: { graphs, images, at: Date.now() }, ttlMs: Object.keys(graphs).length ? DAY : 3600000 };
  });
}
