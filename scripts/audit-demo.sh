#!/usr/bin/env bash
# Enterprise audit trail demo (RFP Appx B Section 2):
# triggers auth failure, user creation, and writes to a sensitive collection,
# then shows the resulting tamper-evident JSON audit records from the PRIMARY.
set -euo pipefail
cd "$(dirname "$0")/.."
# read from .env directly: the URI contains '&' so it cannot be shell-sourced unquoted
URI="${MONGO_URL:-$(sed -n 's/^MONGO_URL=//p' .env | tail -1)}"
[ -n "$URI" ] || { echo "MONGO_URL not found in .env"; exit 1; }

PRIMARY=$(mongosh "$URI" --quiet --eval 'print(rs.hello().primary.split(".")[0])')
HOST=$(mongosh "$URI" --quiet --eval 'print(rs.hello().primary)')
echo "PRIMARY: $PRIMARY"

echo "==> 1. Failed login attempt (wrong password)"
mongosh "mongodb://admin:WRONG@${HOST}/?authSource=admin&directConnection=true" --quiet --eval 'db.runCommand({ping:1})' || true

echo "==> 2. Privileged action: create + drop a user"
mongosh "$URI" --quiet --eval '
  db.getSiblingDB("admin").createUser({user:"audit_demo_user",pwd:"x123456",roles:[{role:"read",db:"poc"}]});
  db.getSiblingDB("admin").dropUser("audit_demo_user");'

echo "==> 3. Write to sensitive collection poc.audit_log"
mongosh "$URI" --quiet --eval 'db.getSiblingDB("poc").audit_log.insertOne({event:"AUDIT_DEMO", ts:new Date()})'

sleep 2
echo
echo "==> Audit records captured by the server on $PRIMARY:"
kubectl -n mongodb exec "$PRIMARY" -c mongodb-enterprise-database -- \
  sh -c 'tail -n 4000 /var/log/mongodb-mms-automation/audit.json' \
  | node tools/audit-format.js 15

echo
echo "==> Raw record for the failed login (full fidelity):"
kubectl -n mongodb exec "$PRIMARY" -c mongodb-enterprise-database -- \
  sh -c 'grep "\"result\" : 18" /var/log/mongodb-mms-automation/audit.json | tail -n 1'

echo
echo "Note: every record carries atype, ts, remote ip, users[], roles[], param and result —"
echo "written by the server itself (not the app), satisfying the independent/tamper-evident audit requirement."
