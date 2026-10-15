#!/usr/bin/env bash
# Syncs the repo to the EC2 instance and runs the full one-shot pipeline there.
# Re-runnable: rsync is incremental, one-shot.sh is idempotent.
set -euo pipefail
cd "$(dirname "$0")/.."
source aws/instance.env

SSH="ssh -i $PEM -o StrictHostKeyChecking=accept-new ec2-user@$EC2_IP"

echo "==> Syncing repo to $EC2_IP"
rsync -az --delete -e "ssh -i $PEM -o StrictHostKeyChecking=accept-new" \
  --exclude node_modules --exclude .git --exclude 'aws/*.pem' \
  ./ "ec2-user@$EC2_IP:~/mongodb-eoffice-poc/"

echo "==> Writing KMS settings into remote .env"
$SSH "cd ~/mongodb-eoffice-poc && grep -q AWS_KMS_KEY_ARN .env 2>/dev/null || printf 'AWS_KMS_KEY_ARN=%s\nAWS_REGION=%s\n' '$AWS_KMS_KEY_ARN' '$AWS_REGION' >> .env"

echo "==> Running one-shot pipeline (logs stream here; safe to re-run)"
$SSH "cd ~/mongodb-eoffice-poc && chmod +x scripts/*.sh aws/*.sh && ./scripts/one-shot.sh"
