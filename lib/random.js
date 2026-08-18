// Randomization helpers for building query payloads.
//
// Why randomize at all? Cube keeps an in-memory result cache, so a load test
// that sends the exact same query 10,000 times measures the cache, not your
// stack. Varying date ranges and filter values forces real work. Keep the
// variation representative of your actual traffic -- if your users only ever
// look at the last 7 days, don't randomize across 5 years.

export function randomInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

export function pad(n, width) {
  const s = String(n);
  return s.length >= width ? s : '0'.repeat(width - s.length) + s;
}

export function pickOne(items) {
  return items[Math.floor(Math.random() * items.length)];
}

// Picks `count` distinct-ish items. Cheap sample, not a shuffle.
export function pickSome(items, count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const candidate = pickOne(items);
    if (out.indexOf(candidate) === -1) out.push(candidate);
  }
  return out;
}

export function isoDate(year, month, day) {
  return `${year}-${pad(month, 2)}-${pad(day, 2)}`;
}

// A random [start, end] pair suitable for a Cube `dateRange`.
// `spanDays` controls how wide the window is; wider windows scan more data.
export function randomDateRange({ minYear, maxYear, spanDays = 30 }) {
  const year = randomInt(minYear, maxYear);
  const month = randomInt(1, 12);
  const day = randomInt(1, 28);

  const start = new Date(Date.UTC(year, month - 1, day));
  const end = new Date(start.getTime() + spanDays * 86400000);

  return [
    isoDate(start.getUTCFullYear(), start.getUTCMonth() + 1, start.getUTCDate()),
    isoDate(end.getUTCFullYear(), end.getUTCMonth() + 1, end.getUTCDate()),
  ];
}

// A trailing window ending today, e.g. randomTrailingWindow(1, 90).
export function randomTrailingWindow(minDays, maxDays) {
  const days = randomInt(minDays, maxDays);
  const end = new Date();
  const start = new Date(end.getTime() - days * 86400000);
  return [
    isoDate(start.getUTCFullYear(), start.getUTCMonth() + 1, start.getUTCDate()),
    isoDate(end.getUTCFullYear(), end.getUTCMonth() + 1, end.getUTCDate()),
  ];
}
