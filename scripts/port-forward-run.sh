#!/usr/bin/env bash
# Foreground supervisor for the host->pod port-forwards (run by systemd).
# Tools connect with replicaSet=..., so the driver re-resolves members by their
# in-cluster FQDN: each pod needs its own loopback IP on the real port 27017
# plus a matching /etc/hosts entry.
set -uo pipefail
NS=mongodb
PODS=(eoffice-rs-0 eoffice-rs-1 eoffice-rs-2)
IPS=(127.0.0.1 127.0.0.2 127.0.0.3)
DOMAIN="eoffice-rs-svc.${NS}.svc.cluster.local"
KUBECTL="${KUBECTL_PATH:-kubectl}"

for i in "${!PODS[@]}"; do
  host="${PODS[$i]}.${DOMAIN}"
  grep -q " ${host}\$" /etc/hosts || echo "${IPS[$i]} ${host}" | sudo tee -a /etc/hosts >/dev/null
done

# Stale forwards from earlier shells can still hold the address, and their argv is
# not always greppable — free the sockets by pid instead of by command name.
free_addr() {
  local pids
  pids=$(ss -lntpH "src ${1}:27017" 2>/dev/null | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u)
  [ -n "$pids" ] && kill $pids 2>/dev/null
  return 0
}
for ip in "${IPS[@]}"; do free_addr "$ip"; done
sleep 2

declare -A PIDS=()
start() {
  local i=$1
  "$KUBECTL" -n "$NS" port-forward --address "${IPS[$i]}" "pod/${PODS[$i]}" 27017:27017 >/dev/null 2>&1 &
  PIDS[$i]=$!
  echo "forwarding ${IPS[$i]}:27017 -> ${PODS[$i]} (pid ${PIDS[$i]})"
}

trap 'for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null; done; exit 0' TERM INT

for i in "${!PODS[@]}"; do start "$i"; done

# port-forward dies whenever its pod restarts (election, upgrade) — respawn it
while true; do
  sleep 1
  for i in "${!PODS[@]}"; do
    kill -0 "${PIDS[$i]}" 2>/dev/null || { echo "respawning ${PODS[$i]}"; start "$i"; }
  done
done
