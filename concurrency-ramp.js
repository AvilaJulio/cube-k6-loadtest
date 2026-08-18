// Concurrency ramp -- find the point where the deployment stops keeping up.
//
// Steps the arrival rate up in equal stages and lets you read the "knee" off
// the per-stage latency curve. Use this when you do NOT yet know what your
// deployment can take, and want a number to design around.
//
//   START_RPS=5 MAX_RPS=100 STEP_RPS=5 STAGE_DURATION=1m k6 run concurrency-ramp.js
//
// With ABORT_ON_DEGRADE=true (the default) the run stops early once the success
// rate drops below MIN_SUCCESS_RATE, so you don't sit through 20 more minutes
// of a deployment that is already saturated. The stage where it aborted is your
// answer.
//
// Read the results with:
//   k6 run --out csv=results/ramp.csv concurrency-ramp.js
// then plot cube_query_duration over time; or watch the live p95 in the
// terminal and note the RPS at which it starts climbing.

import { check } from 'k6';
import { assertReachable, loadQuery } from './lib/cube.js';
import { buildQuery } from './queries.js';

const START_RPS = Number(__ENV.START_RPS || 5);
const MAX_RPS = Number(__ENV.MAX_RPS || 50);
const STEP_RPS = Number(__ENV.STEP_RPS || 5);
const STAGE_DURATION = __ENV.STAGE_DURATION || '1m';
const QUERY = __ENV.QUERY || 'aggregate';

const MIN_SUCCESS_RATE = Number(__ENV.MIN_SUCCESS_RATE || 0.95);
const ABORT_ON_DEGRADE = String(__ENV.ABORT_ON_DEGRADE || 'true') === 'true';

// Each stage holds one rate for STAGE_DURATION, so every step gets an equal
// sample. ramping-arrival-rate interpolates between stages, so we emit a pair
// per step: reach the rate, then hold it.
function buildStages() {
  const stages = [];
  for (let rate = START_RPS; rate <= MAX_RPS; rate += STEP_RPS) {
    stages.push({ target: rate, duration: '10s' });        // ramp to this step
    stages.push({ target: rate, duration: STAGE_DURATION }); // hold it
  }
  return stages;
}

const stages = buildStages();

export const options = {
  scenarios: {
    ramp: {
      executor: 'ramping-arrival-rate',
      startRate: START_RPS,
      timeUnit: '1s',
      stages: stages,
      preAllocatedVUs: Number(__ENV.PRE_ALLOCATED_VUS || Math.max(50, MAX_RPS * 5)),
      maxVUs: Number(__ENV.MAX_VUS || Math.max(200, MAX_RPS * 20)),
      gracefulStop: '120s',
    },
  },
  thresholds: {
    cube_success: [
      {
        threshold: `rate>${MIN_SUCCESS_RATE}`,
        abortOnFail: ABORT_ON_DEGRADE,
        // Don't judge the run on the first few seconds of cold cache.
        delayAbortEval: '30s',
      },
    ],
  },
  discardResponseBodies: false,
};

export function setup() {
  const steps = stages.length / 2;
  console.log(`Query shape: ${QUERY}`);
  console.log(`Ramping ${START_RPS} -> ${MAX_RPS} req/s in ${STEP_RPS} req/s steps`);
  console.log(`${steps} steps x ${STAGE_DURATION} hold each`);
  console.log(
    ABORT_ON_DEGRADE
      ? `Will abort when success rate falls below ${MIN_SUCCESS_RATE * 100}%`
      : 'Will run every stage regardless of degradation'
  );
  assertReachable();
}

export default function () {
  const result = loadQuery(QUERY, buildQuery(QUERY));
  check(result, {
    'query returned a result set': (r) => r.ok,
  });
}
