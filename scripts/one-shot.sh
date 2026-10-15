#!/usr/bin/env bash
# Full idempotent pipeline on the EC2 host. Re-run end-to-end after any failure
# or on a brand-new instance: setup -> operator -> Ops Manager -> auto org/API key
# -> replica set + search -> seed 1M -> search indexes -> embeddings (bg) -> dashboard.
set -euo pipefail
cd "$(dirname "$0")/.."
export KUBECONFIG=~/.kube/config

step() { echo; echo "========== $* =========="; }

step "1. Host setup (k3s, helm, mongosh, node)"
command -v kubectl >/dev/null 2>&1 && kubectl get nodes >/dev/null 2>&1 || ./scripts/ec2-setup.sh

step "2. MCK operator"
kubectl create namespace mongodb --dry-run=client -o yaml | kubectl apply -f -
helm repo add mongodb https://mongodb.github.io/helm-charts >/dev/null 2>&1 || true
helm repo update >/dev/null
helm upgrade --install mongodb-kubernetes mongodb/mongodb-kubernetes \
  --namespace mongodb --set operator.watchNamespace=mongodb
kubectl -n mongodb rollout status deploy/mongodb-kubernetes-operator --timeout=300s

step "3. Ops Manager 9.0 (first boot ~15-20 min)"
kubectl apply -f k8s/ops-manager.yaml
until [ "$(kubectl -n mongodb get om ops-manager -o jsonpath='{.status.opsManager.phase}' 2>/dev/null)" = "Running" ]; do
  echo "  OM=$(kubectl -n mongodb get om ops-manager -o jsonpath='{.status.opsManager.phase}' 2>/dev/null) AppDB=$(kubectl -n mongodb get om ops-manager -o jsonpath='{.status.applicationDatabase.phase}' 2>/dev/null)"
  sleep 20
done

step "4. Org + project wiring (automated via MCK-generated admin API key)"
# MCK stores the global-owner programmatic key it created during OM bootstrap:
PUB=$(kubectl -n mongodb get secret mongodb-ops-manager-admin-key -o jsonpath='{.data.publicKey}' | base64 -d)
PRIV=$(kubectl -n mongodb get secret mongodb-ops-manager-admin-key -o jsonpath='{.data.privateKey}' | base64 -d)
OM_URL="http://ops-manager-svc.mongodb.svc.cluster.local:8080"
om_api() { kubectl -n mongodb exec ops-manager-0 -c mongodb-ops-manager -- \
  curl -s --digest -u "$PUB:$PRIV" -H "Content-Type: application/json" "$@"; }
ORG_ID=$(om_api "$OM_URL/api/public/v1.0/orgs" | python3 -c 'import sys,json;rs=json.load(sys.stdin).get("results",[]);print(next((o["id"] for o in rs if o["name"]=="eoffice"),""))')
if [ -z "$ORG_ID" ]; then
  ORG_ID=$(om_api -X POST -d '{"name":"eoffice"}' "$OM_URL/api/public/v1.0/orgs" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
  echo "  created org eoffice: $ORG_ID"
fi
kubectl -n mongodb create configmap eoffice-om-project \
  --from-literal=baseUrl="$OM_URL" --from-literal=orgId="$ORG_ID" --from-literal=projectName="eoffice-poc" \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl -n mongodb create secret generic eoffice-om-credentials \
  --from-literal=user="$PUB" --from-literal=publicApiKey="$PRIV" \
  --dry-run=client -o yaml | kubectl apply -f -

step "5. Replica set (9.0.4-ent) + MongoDB Search + users + auditing"
kubectl apply -f k8s/users.yaml
kubectl apply -f k8s/replicaset.yaml
until [ "$(kubectl -n mongodb get mdb eoffice-rs -o jsonpath='{.status.phase}' 2>/dev/null)" = "Running" ]; do
  echo "  rs=$(kubectl -n mongodb get mdb eoffice-rs -o jsonpath='{.status.phase}' 2>/dev/null)"
  sleep 15
done
kubectl -n mongodb get pods

step "6. Port-forward 27101-27103"
./scripts/port-forward.sh

step "7. Tools install + seed 1M docs (skips if already seeded)"
cd tools && npm install --silent
EXISTING=$(mongosh "mongodb://admin:eoffice123@localhost:27101,localhost:27102,localhost:27103/?replicaSet=eoffice-rs&authSource=admin" \
  --quiet --eval 'db.getSiblingDB("poc").correspondence.estimatedDocumentCount()')
if [ "${EXISTING:-0}" -lt 1000000 ]; then
  node seed.js $((1000000 - EXISTING))
else
  echo "  already seeded: $EXISTING docs"
fi

step "8. Search indexes (fts + vector)"
node create-search-indexes.js

step "9. Embeddings — all 1M via voyage-4-large (background, resumable)"
if ! pgrep -f "node embed.js" >/dev/null; then
  nohup node embed.js > ../embed.log 2>&1 &
  echo "  embedding started in background -> tail -f ~/mongodb-eoffice-poc/embed.log"
fi
cd ..

step "10. Dashboard on :80 (Nginx -> app :3001)"
cd app && npm install --silent && cd ..
./scripts/install-dashboard.sh

EC2_IP=$(curl -s --connect-timeout 2 http://169.254.169.254/latest/meta-data/public-ipv4 || hostname -I | awk '{print $1}')
echo
echo "================  DONE  ================"
echo "Ops Manager : http://$EC2_IP:30080   (admin@eoffice.poc / Eoffice-123!)"
echo "Dashboard   : http://$EC2_IP/"
echo "Embedding   : tail -f ~/mongodb-eoffice-poc/embed.log"
echo "Demos       : tools/search-demo.js | tools/ask.js | tools/qe-demo.js | scripts/failover-demo.sh | scripts/audit-demo.sh"
