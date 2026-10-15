#!/usr/bin/env bash
# Initialises the 2:2:1 replica set, admin user, roles, indexes. Run once after `docker compose up -d`.
set -euo pipefail

ADMIN_USER="admin"
ADMIN_PASS="eoffice123"

if ! grep -q "host.docker.internal" /etc/hosts; then
  echo "NOTE: add this line to /etc/hosts so the host can resolve replica set members:"
  echo "  127.0.0.1 host.docker.internal"
  echo "Run: echo '127.0.0.1 host.docker.internal' | sudo tee -a /etc/hosts"
fi

echo "Waiting for mongod on dc1-a..."
until docker exec eoffice-dc1-a mongosh --port 27101 --quiet --eval "db.runCommand({ping:1}).ok" >/dev/null 2>&1; do
  sleep 2
done

echo "Initiating replica set rs0 (2:2:1 across DC1/DC2/DR)..."
docker exec eoffice-dc1-a mongosh --port 27101 --quiet --eval '
try {
  rs.initiate({
    _id: "rs0",
    members: [
      { _id: 0, host: "host.docker.internal:27101", priority: 5, tags: { region: "DC1", dc: "primary-dc" } },
      { _id: 1, host: "host.docker.internal:27102", priority: 4, tags: { region: "DC1", dc: "primary-dc" } },
      { _id: 2, host: "host.docker.internal:27201", priority: 3, tags: { region: "DC2", dc: "secondary-dc" } },
      { _id: 3, host: "host.docker.internal:27202", priority: 2, tags: { region: "DC2", dc: "secondary-dc" } },
      { _id: 4, host: "host.docker.internal:27301", priority: 1, tags: { region: "DR",  dc: "dr-site" } }
    ]
  });
} catch (e) { if (!/already initialized/.test(e.message)) throw e; }
'

echo "Waiting for PRIMARY..."
until docker exec eoffice-dc1-a mongosh --port 27101 --quiet --eval 'rs.isMaster().ismaster' 2>/dev/null | grep -q true; do
  sleep 2
done

echo "Creating admin user (localhost exception)..."
docker exec eoffice-dc1-a mongosh --port 27101 --quiet --eval "
try {
  db.getSiblingDB('admin').createUser({ user: '$ADMIN_USER', pwd: '$ADMIN_PASS', roles: ['root'] });
} catch (e) { if (!/already exists/.test(e.message)) throw e; }
" || true

echo "Creating audit role, audit user, collections, indexes..."
docker exec eoffice-dc1-a mongosh --port 27101 -u "$ADMIN_USER" -p "$ADMIN_PASS" --authenticationDatabase admin --quiet --eval '
const poc = db.getSiblingDB("poc");
const admin = db.getSiblingDB("admin");

// Append-only role: insert + find only, no update/remove => immutability demo
try {
  admin.createRole({
    role: "auditAppendOnly",
    privileges: [{ resource: { db: "poc", collection: "audit_log" }, actions: ["insert", "find"] }],
    roles: []
  });
} catch (e) { if (!/already exists/.test(e.message)) throw e; }

try {
  admin.createUser({ user: "audituser", pwd: "audit123", roles: [{ role: "auditAppendOnly", db: "admin" }] });
} catch (e) { if (!/already exists/.test(e.message)) throw e; }

poc.createCollection("correspondence");
poc.createCollection("audit_log");
poc.createCollection("zeroloss");

// pre/post images for the audit change-stream demo
poc.runCommand({ collMod: "correspondence", changeStreamPreAndPostImages: { enabled: true } });

poc.correspondence.createIndex({ fileNo: 1 });
poc.correspondence.createIndex({ directorate: 1, status: 1, createdAt: -1 });
poc.correspondence.createIndex({ subject: "text", body: "text" });
poc.zeroloss.createIndex({ seq: 1 }, { unique: true });
print("Init complete.");
'

echo ""
echo "Replica set ready. Connection string:"
echo "  mongodb://$ADMIN_USER:$ADMIN_PASS@host.docker.internal:27101,host.docker.internal:27102,host.docker.internal:27201,host.docker.internal:27202,host.docker.internal:27301/?replicaSet=rs0&authSource=admin"
