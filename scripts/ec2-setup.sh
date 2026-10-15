#!/usr/bin/env bash
# One-time bootstrap for a single EC2 host (Amazon Linux 2023 / Ubuntu 22.04+).
# Installs k3s (single-node Kubernetes), kubectl, helm, mongosh, node.
# Recommended: m6i.8xlarge (32 vCPU / 128 GB) + 1 TB gp3 @ 10000 IOPS / 700 MBps
# — runs Ops Manager 9.0 + AppDB + 3x mongod 9.0-ent + mongot with headroom (P99 < 10 ms).
set -euo pipefail

echo "==> Installing base packages"
if command -v dnf >/dev/null; then
  # AL2023 ships curl-minimal; installing 'curl' conflicts — skip it
  sudo dnf install -y git tar gzip openssl
else
  sudo apt-get update -y && sudo apt-get install -y git curl tar gzip openssl
fi

echo "==> Installing k3s (single-node cluster, traefik disabled)"
curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC="--disable traefik" sh -
mkdir -p ~/.kube
sudo cp /etc/rancher/k3s/k3s.yaml ~/.kube/config
sudo chown "$(id -u)":"$(id -g)" ~/.kube/config
export KUBECONFIG=~/.kube/config
grep -q KUBECONFIG ~/.bashrc || echo 'export KUBECONFIG=~/.kube/config' >> ~/.bashrc

echo "==> Installing helm"
curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash

echo "==> Installing mongosh + database tools"
if command -v dnf >/dev/null; then
  cat <<'EOF' | sudo tee /etc/yum.repos.d/mongodb-org-8.repo
[mongodb-org-8.0]
name=MongoDB Repository
baseurl=https://repo.mongodb.org/yum/amazon/2023/mongodb-org/8.0/x86_64/
gpgcheck=1
enabled=1
gpgkey=https://pgp.mongodb.com/server-8.0.asc
EOF
  sudo dnf install -y mongodb-mongosh mongodb-database-tools
else
  curl -fsSL https://pgp.mongodb.com/server-8.0.asc | sudo gpg --dearmor -o /usr/share/keyrings/mongodb.gpg
  echo "deb [signed-by=/usr/share/keyrings/mongodb.gpg] https://repo.mongodb.org/apt/ubuntu jammy/mongodb-org/8.0 multiverse" | sudo tee /etc/apt/sources.list.d/mongodb-org-8.0.list
  sudo apt-get update -y && sudo apt-get install -y mongodb-mongosh mongodb-database-tools
fi

echo "==> Installing Node.js 20 (for seeder / RAG tools / dashboard)"
curl -fsSL https://rpm.nodesource.com/setup_20.x 2>/dev/null | sudo bash - 2>/dev/null \
  || curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
if command -v dnf >/dev/null; then sudo dnf install -y nodejs; else sudo apt-get install -y nodejs; fi

echo "==> Adding MongoDB Kubernetes (MCK) helm repo"
helm repo add mongodb https://mongodb.github.io/helm-charts
helm repo update

echo
echo "Done. Next: ./scripts/k8s-deploy.sh"
kubectl get nodes
