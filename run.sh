#!/usr/bin/env bash
# Thin wrapper: k6 reads configuration from the process environment and does not
# read .env files itself, so this loads .env for you.
#
#   ./run.sh smoke.js
#   RPS=50 DURATION=3m ./run.sh steady-load.js
#   ./run.sh --out csv=results/ramp.csv concurrency-ramp.js
#
# Variables already set in your shell take precedence over .env, so the inline
# form above works as you'd expect.
set -euo pipefail

cd "$(dirname "$0")"

if [ -f .env ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line#"${line%%[![:space:]]*}"}"   # strip leading whitespace
    case "$line" in ''|'#'*) continue ;; esac
    line="${line#export }"
    key="${line%%=*}"
    [ "$key" = "$line" ] && continue          # no '=' on this line, skip it
    # Only set it if the shell hasn't already provided one.
    if [ -z "${!key+x}" ]; then
      export "${key}=${line#*=}"
    fi
  done < .env
fi

if ! command -v k6 >/dev/null 2>&1; then
  echo "k6 is not installed. Install it with:" >&2
  echo "  brew install k6                                          # macOS" >&2
  echo "  https://grafana.com/docs/k6/latest/set-up/install-k6/     # everything else" >&2
  exit 127
fi

mkdir -p results

exec k6 run \
  --summary-time-unit ms \
  --summary-trend-stats "avg,min,med,p(90),p(95),p(99),max" \
  "$@"
