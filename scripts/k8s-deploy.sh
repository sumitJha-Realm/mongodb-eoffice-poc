#!/usr/bin/env bash
# Deploys MCK operator + Enterprise 9.0 replica set + MongoDB Search on the k3s cluster.
set -euo pipefail
cd "$(dirname "$0")/.."

kubectl create namespace mongodb --dry-run=client -o yaml | kubectl apply -f -

echo "==> Installing MongoDB Controllers for Kubernetes (MCK) operator — latest chart"
helm upgrade --install mongodb-kubernetes mongodb/mongodb-kubernetes \
  --namespace mongodb \
  --set operator.watchNamespace=mongodb

echo "==> Waiting for operator"
kubectl -n mongodb rollout status deploy/mongodb-kubernetes-operator --timeout=300s

echo "==> Deploying Ops Manager 9.0 (+3-member AppDB) — first boot takes ~15-20 min"
kubectl apply -f k8s/ops-manager.yaml
until [ "$(kubectl -n mongodb get om ops-manager -o jsonpath='{.status.opsManager.phase}' 2>/dev/null)" = "Running" ]; do
  echo "  OM: $(kubectl -n mongodb get om ops-manager -o jsonpath='{.status.opsManager.phase}' 2>/dev/null)  AppDB: $(kubectl -n mongodb get om ops-manager -o jsonpath='{.status.applicationDatabase.phase}' 2>/dev/null)"
  sleep 20
done
EC2_IP=$(curl -s --connect-timeout 2 http://169.254.169.254/latest/meta-data/public-ipv4 || echo "<EC2_IP>")
echo
echo "Ops Manager UI: http://${EC2_IP}:30080  (login: admin@eoffice.poc / Eoffice-123!)"
echo "Create an Org + Org-Owner API key, put orgId/keys into k8s/om-project.yaml, then re-run this script."

if grep -q "<YOUR_ORG_ID>" k8s/om-project.yaml; then
  echo "!! k8s/om-project.yaml still has placeholders — fill them in and re-run. Stopping here."
  exit 0
fi

echo "==> Applying project credentials, replica set, search"
kubectl apply -f k8s/om-project.yaml
kubectl apply -f k8s/replicaset.yaml

echo "==> Waiting for replica set to reach Running (this pulls 9.0.4-ent images; can take ~10 min)"
until [ "$(kubectl -n mongodb get mdb eoffice-rs -o jsonpath='{.status.phase}' 2>/dev/null)" = "Running" ]; do
  kubectl -n mongodb get mdb eoffice-rs -o jsonpath='{.status.phase}{"\n"}' 2>/dev/null || true
  sleep 15
done
kubectl -n mongodb get pods -o wide

echo
echo "==> Connection string (inside cluster):"
echo "mongodb://admin:eoffice123@eoffice-rs-0.eoffice-rs-svc.mongodb.svc.cluster.local:27017,eoffice-rs-1.eoffice-rs-svc.mongodb.svc.cluster.local:27017,eoffice-rs-2.eoffice-rs-svc.mongodb.svc.cluster.local:27017/?replicaSet=eoffice-rs&authSource=admin"
echo
echo "For host access run: ./scripts/port-forward.sh"
