// Steady-state concurrency test.
//
// Holds a fixed arrival rate for a fixed duration and reports how Cube behaves
// under it. This is the script to use when you have a target -- "we need to
// serve 50 queries/second at p95 under 2 seconds" -- and want a pass/fail.
//
//   RPS=25 DURATION=2m k6 run steady-load.js
//   RPS=25 DURATION=2m QUERY=drilldown k6 run steady-load.js
//
// It uses a constant-ARRIVAL-rate executor, not a fixed VU count. That matters:
// arrival rate keeps offering the same load even as responses slow down, so a
// degrading system shows up as growing latency and dropped iterations. A fixed
// VU count would quietly reduce the offered load instead, hiding the problem.

import { check } from 'k6';
import { assertReachable, loadQuery } from './lib/cube.js';
import { buildQuery } from './queries.js';

const RPS = Number(__ENV.RPS || 10);
const DURATION = __ENV.DURATION || '1m';
const QUERY = __ENV.QUERY || 'aggregate';

// Each in-flight query occupies a VU while it waits, so the VU pool has to
// cover RPS * average_seconds_per_query. These defaults assume queries average
// well under 10s; if k6 warns about insufficient VUs, raise MAX_VUS.
const PRE_ALLOCATED_VUS = Number(__ENV.PRE_ALLOCATED_VUS || Math.max(20, RPS * 5));
const MAX_VUS = Number(__ENV.MAX_VUS || Math.max(100, RPS * 20));

// Pass/fail targets. Override to match your own SLO.
const P95_MS = Number(__ENV.P95_MS || 3000);
const MAX_ERROR_RATE = Number(__ENV.MAX_ERROR_RATE || 0.01);

export const options = {
  scenarios: {
    steady: {
      executor: 'constant-arrival-rate',
      rate: RPS,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: PRE_ALLOCATED_VUS,
      maxVUs: MAX_VUS,
      // Let queries already in flight finish rather than counting them as errors.
      gracefulStop: '120s',
    },
  },
  thresholds: {
    cube_query_duration: [`p(95)<${P95_MS}`],
    cube_success: [`rate>${1 - MAX_ERROR_RATE}`],
  },
  // We parse response bodies, so they can't be discarded.
  discardResponseBodies: false,
};

export function setup() {
  console.log(`Query shape: ${QUERY}`);
  console.log(`Offered load: ${RPS} req/s for ${DURATION} (VU pool ${PRE_ALLOCATED_VUS}-${MAX_VUS})`);
  console.log(`Thresholds: p95 < ${P95_MS}ms, error rate < ${MAX_ERROR_RATE * 100}%`);
  assertReachable();
}

export default function () {
  const result = loadQuery(QUERY, buildQuery(QUERY));
  check(result, {
    'query returned a result set': (r) => r.ok,
  });
}
