#!/usr/bin/env bash
# HA failover demo (RFP Appx L #2 / Appx D 4.x):
#  1. starts a background write loop (w:majority, retryable writes)
#  2. deletes the current PRIMARY pod
#  3. measures election + write-stall window, verifies zero acked-write loss
set -euo pipefail
cd "$(dirname "$0")/.."
# read from .env directly: the URI contains '&' so it cannot be shell-sourced unquoted
URI="${MONGO_URL:-$(sed -n 's/^MONGO_URL=//p' .env | tail -1)}"
[ -n "$URI" ] || { echo "MONGO_URL not found in .env"; exit 1; }

echo "==> Topology before failover:"
mongosh "$URI" --quiet --eval 'rs.status().members.forEach(m => print("   ", m.name.split(".")[0], m.stateStr))'

PRIMARY=$(mongosh "$URI" --quiet --eval 'print(rs.hello().primary.split(".")[0])')
echo "Current PRIMARY: $PRIMARY"

echo "==> Starting continuous w:majority write probe (45s)..."
( cd tools && node failover-probe.js ) > /tmp/failover-probe.out 2>&1 &
WRITER=$!

sleep 8
echo "==> $(date +%T) Killing PRIMARY pod: $PRIMARY"
kubectl -n mongodb delete pod "$PRIMARY" --wait=false
echo "    kill issued, election in progress..."

wait "$WRITER" || true
echo
echo "==> Probe result:"
cat /tmp/failover-probe.out
echo
echo "==> Topology after failover:"
mongosh "$URI" --quiet --eval 'rs.status().members.forEach(m => print("   ", m.name.split(".")[0], m.stateStr))'
echo
echo "The StatefulSet restarts the killed pod automatically; watch it rejoin with:"
echo "   kubectl -n mongodb get pods -w"
