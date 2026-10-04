// Build the Fleet's daily rollups from the command line (or a nightly job): every major skill's
// failures, timing, usage and work chains, one small file per UTC day in FLEET_DIR (default .fleet/).
//
//   npm run fleet                 # the last 30 complete days that are missing or stale, plus today
//   npm run fleet -- --days 7     # a shorter window
//   npm run fleet -- --day 2026-10-02 --force   # rebuild one day
//
// Days are built one at a time, each a few sequential Trino queries (~1 min per day), so a run
// never takes more than one slot on the shared cluster. Final days are never re-queried.
import { buildDay, readDay, periodDays, isFinal, fleetDir, dayNeedsWork } from '../server/fleet.js';
import { backoffRemaining } from '../server/limits.js';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? dflt : args[i + 1];
};
const force = args.includes('--force');
const days = opt('day') ? [opt('day')] : [...periodDays({ days: Number(opt('days', 30)) }), ...(args.includes('--no-today') ? [] : periodDays({ today: true }))];

console.log(`fleet: ${days.length} day(s) → ${fleetDir()}`);
let built = 0;
let busyDays = 0;
for (const day of [...days].reverse()) {
  // The shared cluster is timing out: wait it out rather than add load; give up after 3 busy days.
  const wait = backoffRemaining('trino');
  if (wait > 0) {
    console.log(`  Trino is busy — waiting ${Math.round(wait / 1000) + 30}s before the next day`);
    await new Promise((r) => setTimeout(r, wait + 30000));
  }
  const have = await readDay(day);
  if (!force && have && !dayNeedsWork(have) && (have.final || (!isFinal(day) && Date.now() - have.builtAt < 30 * 60000))) {
    console.log(`  ${day}  ok (${have.final ? 'final' : 'fresh'})`);
    continue;
  }
  const t = Date.now();
  try {
    const d = await buildDay(day, { force });
    built++;
    busyDays = d.busy ? busyDays + 1 : 0;
    // The limiter only backs off on timeouts; after a busy day, pause before the next one either way.
    if (d.busy) {
      console.log('  Trino or its gateway is busy — pausing 2 min before the next day');
      await new Promise((r) => setTimeout(r, 120000));
    }
    const errs = Object.keys(d.errors);
    console.log(`  ${day}  ${d.patchedAt ? 'patched' : 'built'} in ${Math.round((Date.now() - t) / 1000)}s — ${d.usage.length} usage, ${d.timing.length} timing, ${d.failures.length} failure, ${d.chains.length} chain, ${(d.outcomes || []).length} outcome rows${errs.length ? `; FAILED: ${errs.join(', ')} (${Object.values(d.errors)[0]})` : ''}`);
  } catch (err) {
    console.log(`  ${day}  failed: ${err.message}`);
  }
  if (busyDays >= 3) {
    console.log('fleet: Trino kept timing out on 3 days in a row — stopping; run it again later (finished days are kept)');
    break;
  }
}
console.log(`fleet: ${built} day(s) built`);
process.exit(0);
