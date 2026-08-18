// Smoke test -- run this first, every time.
//
// One VU, one pass over every query shape. It costs seconds and catches the
// things that otherwise waste a full load run: wrong deployment URL, expired
// token, a member name that doesn't exist in the data model, a query that
// errors under some random filter value.
//
//   k6 run smoke.js
//
// Exit code is non-zero unless every query returned a real result set.

import { check } from 'k6';
import { assertReachable, loadQuery, RENEW_QUERY, API_URL } from './lib/cube.js';
import { buildQuery, queryNames } from './queries.js';

export const options = {
  vus: 1,
  iterations: 1,
  // Any failure at all fails the run.
  thresholds: {
    cube_success: ['rate==1'],
  },
};

export function setup() {
  console.log(`Cache bypass (renewQuery): ${RENEW_QUERY ? 'ON' : 'off'}`);
  assertReachable();
}

export default function () {
  for (const name of queryNames) {
    const query = buildQuery(name);
    const result = loadQuery(name, query);

    check(result, {
      [`${name}: returned a result set`]: (r) => r.ok,
      [`${name}: returned at least one row`]: (r) => !r.ok || r.rows > 0,
    });

    if (result.ok) {
      console.log(
        `  ${name.padEnd(12)} ${String(result.durationMs).padStart(6)}ms  ` +
          `${String(result.rows).padStart(5)} rows  ${result.polls} continue-wait poll(s)`
      );
    } else {
      console.error(`  ${name.padEnd(12)} FAILED  ${result.error}`);
      console.error(`  query was: ${JSON.stringify(query)}`);
    }
  }
}

export function teardown() {
  console.log(
    `\nSmoke test done against ${API_URL}.\n` +
      'Zero rows on a query usually means the date range falls outside your data,\n' +
      'not that the API is broken -- check LOOKBACK_MIN_DAYS / LOOKBACK_MAX_DAYS.'
  );
}
