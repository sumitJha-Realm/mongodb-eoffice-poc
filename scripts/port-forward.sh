#!/usr/bin/env bash
# Makes the replica set reachable from the host exactly as the driver expects.
# Tools connect with replicaSet=..., so the driver re-resolves members by their
# in-cluster FQDN — each pod needs its own loopback IP on the real port 27017
# plus a matching /etc/hosts entry.
set -euo pipefail
NS=mongodb
PODS=(eoffice-rs-0 eoffice-rs-1 eoffice-rs-2)
IPS=(127.0.0.1 127.0.0.2 127.0.0.3)
DOMAIN="eoffice-rs-svc.${NS}.svc.cluster.local"

pkill -f "kubectl.*port-forward.*eoffice-rs" 2>/dev/null || true
sleep 1

for i in "${!PODS[@]}"; do
  host="${PODS[$i]}.${DOMAIN}"
  grep -q " $host\$" /etc/hosts || echo "${IPS[$i]} $host" | sudo tee -a /etc/hosts >/dev/null
  kubectl -n "$NS" port-forward --address "${IPS[$i]}" "pod/${PODS[$i]}" 27017:27017 >/dev/null 2>&1 &
done

sleep 4
echo "Forwarded:"
for i in "${!PODS[@]}"; do echo "  ${IPS[$i]}:27017 -> ${PODS[$i]}"; done
echo "URI: mongodb://admin:eoffice123@${PODS[0]}.${DOMAIN}:27017,${PODS[1]}.${DOMAIN}:27017,${PODS[2]}.${DOMAIN}:27017/?replicaSet=eoffice-rs&authSource=admin"
