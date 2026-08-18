// Mixed workload -- the most realistic of the four.
//
// Runs all three query shapes concurrently at independent rates, the way a real
// dashboard does. This surfaces interference that single-shape tests miss: one
// expensive raw-data query per second can be enough to slow down the cheap
// aggregate queries sharing the same API instances and warehouse connections.
//
//   RPS=30 DURATION=5m k6 run mixed-workload.js
//
// Total offered load is RPS, split by the weights in queries.js
// (default 70/25/5). Each shape gets its own scenario so the summary reports
// separate percentiles per shape -- look for the cheap shape's p95 degrading
// when the expensive one is running.
//
// If you add or rename shapes in queries.js, add a matching exported function
// and scenario entry here.

import { check } from 'k6';
import { assertReachable, loadQuery } from './lib/cube.js';
import { buildQuery, queries } from './queries.js';

const RPS = Number(__ENV.RPS || 10);
const DURATION = __ENV.DURATION || '2m';

const totalWeight = Object.keys(queries).reduce((sum, n) => sum + queries[n].weight, 0);

// Splits the total offered rate by weight. k6 requires rate to be a positive
// integer-ish value, so a shape whose share rounds to zero gets 1 -- better a
// slightly hot low-weight shape than one that silently never runs.
function rateFor(name) {
  return Math.max(1, Math.round((queries[name].weight / totalWeight) * RPS));
}

function scenarioFor(name, execName) {
  return {
    executor: 'constant-arrival-rate',
    rate: rateFor(name),
    timeUnit: '1s',
    duration: DURATION,
    preAllocatedVUs: Math.max(10, rateFor(name) * 5),
    maxVUs: Math.max(50, rateFor(name) * 20),
    exec: execName,
    gracefulStop: '120s',
  };
}

export const options = {
  scenarios: {
    aggregate: scenarioFor('aggregate', 'runAggregate'),
    drilldown: scenarioFor('drilldown', 'runDrilldown'),
    rawPage: scenarioFor('rawPage', 'runRawPage'),
  },
  thresholds: {
    // Per-shape targets. The cheap shape should stay fast even while the
    // expensive one is in flight -- that is the whole point of this script.
    'cube_query_duration{query:aggregate}': [`p(95)<${Number(__ENV.P95_AGGREGATE_MS || 2000)}`],
    'cube_query_duration{query:drilldown}': [`p(95)<${Number(__ENV.P95_DRILLDOWN_MS || 5000)}`],
    'cube_success{query:aggregate}': ['rate>0.99'],
    cube_success: ['rate>0.95'],
  },
  discardResponseBodies: false,
};

export function setup() {
  console.log(`Total offered load: ~${RPS} req/s for ${DURATION}, split by weight:`);
  for (const name of Object.keys(queries)) {
    console.log(`  ${name.padEnd(12)} weight ${String(queries[name].weight).padStart(3)}  ->  ${rateFor(name)} req/s`);
  }
  assertReachable();
}

function run(name) {
  const result = loadQuery(name, buildQuery(name));
  check(result, { [`${name}: returned a result set`]: (r) => r.ok }, { query: name });
}

export function runAggregate() {
  run('aggregate');
}

export function runDrilldown() {
  run('drilldown');
}

export function runRawPage() {
  run('rawPage');
}
