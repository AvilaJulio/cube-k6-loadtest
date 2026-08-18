// Query definitions.
//
// ---------------------------------------------------------------------------
// THIS IS THE FILE YOU EDIT.
// ---------------------------------------------------------------------------
// Everything else in this repo is generic. Point MODEL at your own cube and
// members below, adjust the three builders to look like the queries your
// application actually issues, and the scripts work unchanged.
//
// The three shapes below are deliberately different, because they exercise
// different parts of Cube and will give you very different numbers:
//
//   aggregate  -- low cardinality, coarse granularity. Should be served by a
//                 pre-aggregation. This is your "dashboard tile" workload and
//                 the one that should scale to high concurrency.
//   drilldown  -- high cardinality with a selective filter. May or may not hit
//                 a pre-aggregation depending on how yours are defined. This is
//                 where concurrency problems usually first show up.
//   rawPage    -- no measures, wide row set. Always goes to the warehouse.
//                 Expensive and effectively unbounded by pre-aggregations;
//                 include it only if your users really do this.

import { pickOne, randomInt, randomTrailingWindow } from './lib/random.js';

// --- Your data model ---------------------------------------------------------

const MODEL = {
  cube: 'Orders',

  // Measures
  count: 'Orders.count',
  amount: 'Orders.totalAmount',

  // Low-cardinality dimension, good for grouping
  status: 'Orders.status',

  // High-cardinality dimension, good for selective filtering
  entityKey: 'Orders.customerKey',

  // Extra dimensions for the raw-page shape
  rawDimensions: ['Orders.id', 'Orders.status', 'Orders.customerKey'],

  // Time dimension used by every shape
  time: 'Orders.createdAt',
};

// Filter values to sample from. In a real test, make this look like your
// production key distribution -- a uniform random draw over 1..10000 spreads
// load far more evenly than real traffic usually does, which can make results
// look better than they will be in production.
const ENTITY_KEY_MAX = Number(__ENV.ENTITY_KEY_MAX || 10000);

// How far back queries reach. Keep this aligned with your pre-aggregation
// build range: querying outside it silently falls through to the warehouse.
const LOOKBACK_MIN_DAYS = Number(__ENV.LOOKBACK_MIN_DAYS || 7);
const LOOKBACK_MAX_DAYS = Number(__ENV.LOOKBACK_MAX_DAYS || 90);

// --- Query builders ----------------------------------------------------------

export const queries = {
  aggregate: {
    // Relative share of traffic in mixed-workload.js
    weight: Number(__ENV.WEIGHT_AGGREGATE || 70),
    build() {
      return {
        measures: [MODEL.count, MODEL.amount],
        dimensions: [MODEL.status],
        timeDimensions: [
          {
            dimension: MODEL.time,
            granularity: 'month',
            dateRange: randomTrailingWindow(LOOKBACK_MIN_DAYS, LOOKBACK_MAX_DAYS),
          },
        ],
        order: { [MODEL.time]: 'asc' },
        limit: 100,
      };
    },
  },

  drilldown: {
    weight: Number(__ENV.WEIGHT_DRILLDOWN || 25),
    build() {
      return {
        measures: [MODEL.count, MODEL.amount],
        dimensions: [MODEL.entityKey],
        timeDimensions: [
          {
            dimension: MODEL.time,
            granularity: 'day',
            dateRange: randomTrailingWindow(LOOKBACK_MIN_DAYS, LOOKBACK_MAX_DAYS),
          },
        ],
        filters: [
          {
            member: MODEL.entityKey,
            operator: 'equals',
            values: [String(randomInt(1, ENTITY_KEY_MAX))],
          },
        ],
        order: { [MODEL.count]: 'desc' },
        limit: 500,
      };
    },
  },

  rawPage: {
    weight: Number(__ENV.WEIGHT_RAWPAGE || 5),
    build() {
      return {
        dimensions: MODEL.rawDimensions,
        timeDimensions: [
          {
            dimension: MODEL.time,
            dateRange: randomTrailingWindow(1, LOOKBACK_MIN_DAYS),
          },
        ],
        filters: [
          {
            member: MODEL.status,
            operator: 'equals',
            values: [pickOne(['completed', 'processing', 'shipped'])],
          },
        ],
        order: { [MODEL.time]: 'desc' },
        limit: 1000,
      };
    },
  },
};

export const queryNames = Object.keys(queries);

// Builds the named query, or throws with the list of valid names -- a typo in
// QUERY=... should fail immediately rather than halfway into a run.
export function buildQuery(name) {
  const entry = queries[name];
  if (!entry) {
    throw new Error(`Unknown query "${name}". Available: ${queryNames.join(', ')}`);
  }
  return entry.build();
}

// Weighted pick, for driving a realistic mix from a single scenario.
export function pickWeightedName() {
  const total = queryNames.reduce((sum, n) => sum + queries[n].weight, 0);
  let roll = Math.random() * total;
  for (const name of queryNames) {
    roll -= queries[name].weight;
    if (roll <= 0) return name;
  }
  return queryNames[queryNames.length - 1];
}
