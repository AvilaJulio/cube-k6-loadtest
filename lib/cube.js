// Cube REST API client for k6.
//
// The one thing this file exists for: Cube's /v1/load endpoint answers with
// HTTP 200 and a body of {"error": "Continue wait"} while your query is still
// executing. A load test that only asserts `status === 200` will therefore
// report a query that has not finished as a fast success -- understating
// latency and overstating throughput, often by a lot.
//
// loadQuery() polls until a real result arrives (exactly as the official Cube
// clients do) and reports the full wall time.

import http from 'k6/http';
import exec from 'k6/execution';
import { sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

// ---------------------------------------------------------------------------
// Configuration (all via environment variables -- see .env.example)
// ---------------------------------------------------------------------------

function normalizeApiUrl(raw) {
  if (!raw) {
    throw new Error(
      'CUBE_API_URL is not set. Point it at your Cube Cloud deployment, e.g.\n' +
        '  export CUBE_API_URL=https://your-deployment.cubecloudapp.dev'
    );
  }
  const trimmed = String(raw).replace(/\/+$/, '');
  // Accept either the bare host or a full .../cubejs-api/v1 URL.
  return /\/cubejs-api\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/cubejs-api/v1`;
}

export const API_URL = normalizeApiUrl(__ENV.CUBE_API_URL);
export const API_TOKEN = __ENV.CUBE_API_TOKEN || '';

// Total budget for one logical query, across every Continue-wait poll.
export const QUERY_TIMEOUT_MS = Number(__ENV.QUERY_TIMEOUT_MS || 120000);

// Gap between Continue-wait polls. Cube's own JS client waits ~1s, so leaving
// this at 1000 keeps cube_poll_count comparable to real client behaviour.
export const POLL_INTERVAL_MS = Number(__ENV.POLL_INTERVAL_MS || 1000);

// RENEW_QUERY=true adds renewQuery to every request, bypassing Cube's result
// cache and forcing a fresh pre-aggregation/warehouse read. Use it to measure
// worst-case cost; leave it off to measure what your users actually experience.
export const RENEW_QUERY = String(__ENV.RENEW_QUERY || '') === 'true';

// How many failing responses each VU dumps to the log. Uncapped logging at
// high RPS drowns the terminal and skews the run.
const MAX_ERROR_LOGS_PER_VU = Number(__ENV.MAX_ERROR_LOGS_PER_VU || 3);
let errorsLogged = 0;

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

// End-to-end wall time to an actual result set, including all Continue waits.
// This is the number that corresponds to what a user perceives.
export const cubeQueryDuration = new Trend('cube_query_duration', true);
// Duration of just the first HTTP round trip. Compare against
// cube_query_duration to see how much time is spent queued/executing.
export const cubeFirstResponse = new Trend('cube_first_response', true);
// How many Continue-wait polls each query needed. 0 means Cube answered
// immediately (cache or a very fast pre-aggregation hit).
export const cubePollCount = new Trend('cube_poll_count');
// Fraction of queries that returned a real result set.
export const cubeSuccess = new Rate('cube_success');
// Failures broken out by kind via the `reason` tag.
export const cubeErrors = new Counter('cube_errors');
// Row counts, to catch a "fast" run that is silently returning nothing.
export const cubeRows = new Trend('cube_rows');

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

// Cube echoes x-request-id into its own logs. Emitting a recognizable one per
// iteration lets you paste an ID straight into Cube Cloud's request log to see
// the generated SQL and pre-aggregation decision for a specific slow request.
function newRequestId(name) {
  const vu = exec.vu.idInTest;
  const iter = exec.scenario.iterationInTest;
  const rand = Math.floor(Math.random() * 0xffffff).toString(16);
  return `k6-${name}-vu${vu}-it${iter}-${rand}`;
}

function parseBody(res) {
  try {
    return res.json();
  } catch (e) {
    return null;
  }
}

function isContinueWait(error) {
  return typeof error === 'string' && error.toLowerCase().indexOf('continue wait') !== -1;
}

// /v1/load returns {data: [...]} for a single query and {results: [{data}, ...]}
// for a multi-query request. Count rows from whichever shape came back.
function countRows(parsed) {
  if (parsed && Array.isArray(parsed.data)) return parsed.data.length;
  if (parsed && Array.isArray(parsed.results)) {
    return parsed.results.reduce(
      (sum, r) => sum + (r && Array.isArray(r.data) ? r.data.length : 0),
      0
    );
  }
  return 0;
}

function describeFailure(res, parsed) {
  const body = parsed && parsed.error ? JSON.stringify(parsed.error) : String(res.body).slice(0, 400);
  return `HTTP ${res.status}: ${body}`;
}

function logFailure(name, requestId, message) {
  if (errorsLogged >= MAX_ERROR_LOGS_PER_VU) return;
  errorsLogged += 1;
  console.error(`[${name}] ${requestId} ${message}`);
  if (errorsLogged === MAX_ERROR_LOGS_PER_VU) {
    console.error(`[${name}] further errors from this VU suppressed`);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run one Cube query to completion.
 *
 * @param {string} name  Label for this query shape; becomes the `query` metric
 *                       tag, so you get per-shape percentiles in the summary.
 * @param {object} query A Cube query object (measures/dimensions/filters/...).
 * @param {object} [options] { tags: {...}, requestId: '...' }
 * @returns {{ok: boolean, rows: number, durationMs: number, polls: number,
 *            status: number, error: ?string, requestId: string}}
 */
export function loadQuery(name, query, options = {}) {
  const requestId = options.requestId || newRequestId(name);
  const payload = JSON.stringify({
    query: RENEW_QUERY ? Object.assign({}, query, { renewQuery: true }) : query,
  });

  const tags = Object.assign({ query: name }, options.tags || {});
  const params = {
    headers: {
      'Content-Type': 'application/json',
      Authorization: API_TOKEN,
      'x-request-id': requestId,
    },
    // Tagging the HTTP request too, so built-in http_req_* metrics break down
    // by query shape as well.
    tags: tags,
    timeout: `${QUERY_TIMEOUT_MS}ms`,
  };

  const startedAt = Date.now();
  let polls = 0;
  let firstResponse = null;

  for (;;) {
    const res = http.post(`${API_URL}/load`, payload, params);
    if (firstResponse === null) {
      firstResponse = res.timings.duration;
      cubeFirstResponse.add(firstResponse, tags);
    }

    const parsed = parseBody(res);
    const elapsed = Date.now() - startedAt;

    // Success: 200 with a result set and no error member.
    if (res.status === 200 && parsed && !parsed.error) {
      const rows = countRows(parsed);
      cubeQueryDuration.add(elapsed, tags);
      cubePollCount.add(polls, tags);
      cubeRows.add(rows, tags);
      cubeSuccess.add(true, tags);
      return { ok: true, rows, durationMs: elapsed, polls, status: res.status, error: null, requestId };
    }

    // Still executing: Cube says 200 + "Continue wait". Poll again.
    if (res.status === 200 && parsed && isContinueWait(parsed.error)) {
      polls += 1;
      if (elapsed + POLL_INTERVAL_MS >= QUERY_TIMEOUT_MS) {
        cubeQueryDuration.add(elapsed, tags);
        cubePollCount.add(polls, tags);
        cubeSuccess.add(false, tags);
        cubeErrors.add(1, Object.assign({}, tags, { reason: 'timeout' }));
        const message = `gave up after ${elapsed}ms and ${polls} Continue-wait polls`;
        logFailure(name, requestId, message);
        return { ok: false, rows: 0, durationMs: elapsed, polls, status: res.status, error: message, requestId };
      }
      sleep(POLL_INTERVAL_MS / 1000);
      continue;
    }

    // Anything else is a real failure: auth, bad query, 5xx, network error.
    const reason =
      res.status === 0 ? 'network'
        : res.status === 401 || res.status === 403 ? 'auth'
        : res.status >= 500 ? 'server'
        : res.status >= 400 ? 'client'
        : 'cube_error';

    cubeQueryDuration.add(elapsed, tags);
    cubePollCount.add(polls, tags);
    cubeSuccess.add(false, tags);
    cubeErrors.add(1, Object.assign({}, tags, { reason }));

    const message = describeFailure(res, parsed);
    logFailure(name, requestId, message);
    return { ok: false, rows: 0, durationMs: elapsed, polls, status: res.status, error: message, requestId };
  }
}

/**
 * One-off metadata call. Handy in setup() to fail fast on a bad URL or token
 * before spending a full load run discovering it.
 */
export function fetchMeta() {
  const res = http.get(`${API_URL}/meta`, {
    headers: { Authorization: API_TOKEN },
    tags: { query: 'meta' },
    timeout: '30s',
  });
  return { status: res.status, body: parseBody(res), raw: String(res.body).slice(0, 400) };
}

/**
 * Verify connectivity and credentials. Call from setup(); it throws with an
 * actionable message rather than letting the run produce 100% errors.
 */
export function assertReachable() {
  const meta = fetchMeta();
  if (meta.status === 200) {
    const cubes = meta.body && Array.isArray(meta.body.cubes) ? meta.body.cubes.length : 0;
    console.log(`Connected to ${API_URL} (${cubes} cubes/views visible)`);
    return meta.body;
  }
  if (meta.status === 401 || meta.status === 403) {
    throw new Error(
      `Auth rejected by ${API_URL} (HTTP ${meta.status}). Check CUBE_API_TOKEN -- ` +
        'grab a fresh one from your deployment\'s Playground, or sign a JWT with your API secret.'
    );
  }
  throw new Error(`Could not reach ${API_URL}/meta (HTTP ${meta.status}): ${meta.raw}`);
}
