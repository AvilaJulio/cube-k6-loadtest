# Cube concurrency testing with k6

A small set of [k6](https://grafana.com/docs/k6/latest/) scripts for load-testing
the Cube REST API against a Cube Cloud deployment, plus the helpers needed to
build realistic query payloads.

There is no Docker, no server to run, and no `npm install`. k6 is a single
binary; these scripts call your deployment's `/cubejs-api/v1/load` endpoint
directly.

## Why not just point a generic load tool at `/v1/load`?

Because Cube answers a query that is still executing with **HTTP 200** and a body
of `{"error": "Continue wait"}`. A test that asserts `status === 200` therefore
records an unfinished query as a fast success. Here is the same run measured both
ways:

```
http_req_duration ....: avg=1.01ms      <- what a naive test reports
cube_query_duration ..: avg=2006.33ms   <- what the user actually waits
```

`lib/cube.js` polls until a real result set comes back, exactly as the official
Cube clients do, and reports the full wall time. That is the main reason this
repo exists rather than a one-line k6 script.

## Setup

1. **Install k6**

   ```bash
   brew install k6      # macOS
   ```
   Other platforms: <https://grafana.com/docs/k6/latest/set-up/install-k6/>

2. **Configure your deployment**

   ```bash
   cp .env.example .env
   ```

   Set `CUBE_API_URL` to your deployment (either
   `https://your-deployment.cubecloudapp.dev` or the full
   `.../cubejs-api/v1` path) and `CUBE_API_TOKEN` to an API token. For a first
   run, the quickest token is the one the Playground already uses: open your
   deployment's Playground, run any query, and copy the `Authorization` header
   from the browser's network tab. For repeated use, sign a JWT with your
   deployment's API secret.

   `.env` is gitignored. Do not commit a token.

3. **Point the queries at your data model** — edit `queries.js`. It has one
   `MODEL` block at the top listing the cube and member names to use; replace
   them with your own. This is the only file you need to change.

4. **Smoke test before anything else**

   ```bash
   ./run.sh smoke.js
   ```

   One VU, one pass over every query shape. It costs a few seconds and catches
   the wrong-URL, expired-token, and misspelled-member mistakes that otherwise
   waste a full load run.

## The scripts

| Script | Use it when | Example |
|---|---|---|
| `smoke.js` | Always, first. Validates config and every query shape. | `./run.sh smoke.js` |
| `steady-load.js` | You have a target and want pass/fail. | `RPS=25 DURATION=5m ./run.sh steady-load.js` |
| `concurrency-ramp.js` | You don't know the ceiling yet and want to find it. | `START_RPS=5 MAX_RPS=100 STEP_RPS=5 ./run.sh concurrency-ramp.js` |
| `mixed-workload.js` | You want the most realistic picture. | `RPS=30 DURATION=10m ./run.sh mixed-workload.js` |

`run.sh` loads `.env` (k6 does not read `.env` files itself) and sets sensible
summary flags. Variables set inline on the command line win over `.env`. You can
always call `k6 run` directly if you prefer.

### `steady-load.js`

Holds a fixed **arrival rate** — not a fixed number of virtual users — for a
fixed duration. That distinction matters: an arrival-rate executor keeps offering
the same load even as responses slow down, so a saturating deployment shows up
as rising latency and dropped iterations. A fixed VU count would quietly *reduce*
the offered load as things slow, hiding the problem.

Fails the run (non-zero exit, so it works in CI) if p95 exceeds `P95_MS` or the
error rate exceeds `MAX_ERROR_RATE`.

### `concurrency-ramp.js`

Steps the arrival rate up in equal stages so you can read the knee off the
latency curve. By default it aborts once the success rate drops below 95%, so you
don't sit through twenty more minutes of an already-saturated deployment — the
stage where it aborts is your answer. Set `ABORT_ON_DEGRADE=false` to run every
stage regardless.

### `mixed-workload.js`

Runs all three query shapes concurrently at independent rates, split by the
weights in `queries.js`. This catches interference that single-shape tests miss:
one expensive raw-data query per second can be enough to slow the cheap
aggregate queries that share the same API instances and warehouse connections.
Watch the cheap shape's p95 — `cube_query_duration{query:aggregate}` — while the
expensive shape is running.

## Reading the output

| Metric | Meaning |
|---|---|
| `cube_query_duration` | **The headline number.** Wall time to a real result set, including every Continue-wait poll. |
| `cube_first_response` | Just the first HTTP round trip. The gap between this and `cube_query_duration` is time spent queued or executing. |
| `cube_poll_count` | Continue-wait polls per query. `0` means Cube answered immediately — a cache or fast pre-aggregation hit. A rising average during a ramp is your earliest saturation signal. |
| `cube_success` | Fraction of queries that returned a real result set. |
| `cube_errors` | Failures, tagged by `reason`: `auth`, `client`, `server`, `network`, `timeout`. |
| `cube_rows` | Rows returned. Guards against a "fast" run that is silently returning nothing. |
| `http_req_duration` | Per-HTTP-request timing. Useful, but **not** your query latency — see above. |

Every metric is tagged with the query shape, so
`cube_query_duration{query:drilldown}` gives you per-shape percentiles.

Save results for later comparison:

```bash
./run.sh --out csv=results/run.csv --summary-export results/summary.json steady-load.js
```

### Tracing one slow query

Each request carries an `x-request-id` like `k6-drilldown-vu12-it843-a3f9c1`.
Cube logs it, so you can take a slow request from your k6 output, search your
deployment's request log for that ID, and see the generated SQL and which
pre-aggregation (if any) served it.

## Getting numbers that mean something

A few things will quietly make your results wrong:

- **Cube's result cache.** Sending the identical query 10,000 times measures the
  cache, not your stack. The builders in `queries.js` randomize date ranges and
  filter values for this reason. Keep the variation representative of real
  traffic — randomizing a customer key uniformly over 1..10,000 spreads load far
  more evenly than production usually does, which flatters the results. Set
  `RENEW_QUERY=true` to bypass the cache entirely and measure worst case.
- **Cold pre-aggregations.** Warm them before the run, or you are benchmarking a
  build, not a query. Check the Pre-Aggregations page in Cube Cloud first.
- **Date ranges outside the pre-aggregation build range.** These silently fall
  through to the warehouse and will look inexplicably slow. Keep
  `LOOKBACK_MAX_DAYS` inside your build range, or widen it deliberately to
  measure that fall-through.
- **Where you run k6 from.** A laptop on Wi-Fi cannot reliably offer 100 req/s;
  you will measure your own uplink. Run from a cloud instance in the same region
  as the deployment for anything above a modest rate.
- **VU pool size.** Each in-flight query occupies a VU while it waits, so the
  pool must cover `RPS × average_seconds_per_query`. If k6 warns about
  insufficient VUs, raise `MAX_VUS` — otherwise the offered rate silently drops
  below what you asked for.
- **What you're actually scaling.** Cube Cloud API instance count and warehouse
  concurrency both bound your results. If a ramp plateaus, check whether you have
  hit an API instance limit or a warehouse queue before concluding anything about
  Cube.

## Adding a query shape

Add an entry to `queries.js`:

```js
export const queries = {
  // ...
  myShape: {
    weight: 10,                       // relative share in mixed-workload.js
    build() {
      return {
        measures: ['Orders.count'],
        timeDimensions: [{
          dimension: 'Orders.createdAt',
          granularity: 'week',
          dateRange: randomTrailingWindow(7, 30),
        }],
        limit: 100,
      };
    },
  },
};
```

`smoke.js`, `steady-load.js` (via `QUERY=myShape`) and `concurrency-ramp.js` pick
it up automatically. `mixed-workload.js` declares its scenarios explicitly, so
add a matching exported function and scenario entry there.

Randomization helpers live in `lib/random.js`: `randomInt`, `pickOne`,
`pickSome`, `randomDateRange`, `randomTrailingWindow`.

## Not covered here

These scripts test the **REST API** (`/v1/load`). The **SQL API** speaks the
Postgres wire protocol, which plain k6 cannot; testing it needs a custom k6 build
with [`xk6-sql`](https://github.com/grafana/xk6-sql) and its Postgres driver, or
a different tool such as `pgbench`. Ask if you want that added.

## Files

```
lib/cube.js       Cube REST client: Continue-wait polling, metrics, connectivity check
lib/random.js     Randomization helpers for query payloads
queries.js        >> THE FILE YOU EDIT << query shapes and your model's member names
smoke.js          1 VU sanity check
steady-load.js    Fixed arrival rate, pass/fail thresholds
concurrency-ramp.js  Stepped ramp to find the ceiling
mixed-workload.js Concurrent shapes at weighted rates
run.sh            Loads .env, then k6 run
.env.example      Configuration reference
```
