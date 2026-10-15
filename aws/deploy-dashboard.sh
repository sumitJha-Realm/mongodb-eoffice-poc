#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source aws/instance.env

SSH=(ssh -i "$PEM" -o StrictHostKeyChecking=accept-new "ec2-user@$EC2_IP")
rsync -az -e "ssh -i $PEM -o StrictHostKeyChecking=accept-new" \
  app/server.js app/workflow.js "ec2-user@$EC2_IP:~/mongodb-eoffice-poc/app/"
rsync -az -e "ssh -i $PEM -o StrictHostKeyChecking=accept-new" \
  app/public/ "ec2-user@$EC2_IP:~/mongodb-eoffice-poc/app/public/"
rsync -az -e "ssh -i $PEM -o StrictHostKeyChecking=accept-new" \
  aws/eoffice-dashboard.service aws/eoffice-dashboard.nginx.conf \
  "ec2-user@$EC2_IP:~/mongodb-eoffice-poc/aws/"
rsync -az -e "ssh -i $PEM -o StrictHostKeyChecking=accept-new" \
  scripts/install-dashboard.sh "ec2-user@$EC2_IP:~/mongodb-eoffice-poc/scripts/"

"${SSH[@]}" 'cd ~/mongodb-eoffice-poc && chmod +x scripts/install-dashboard.sh && ./scripts/install-dashboard.sh'

if command -v aws >/dev/null 2>&1; then
  MYIP="$(curl -fsS https://checkip.amazonaws.com)/32"
  if SG_IDS="$(aws ec2 describe-instances --instance-ids "$EC2_ID" --query 'Reservations[0].Instances[0].SecurityGroups[].GroupId' --output text 2>/dev/null)"; then
    for SG in $SG_IDS; do
      aws ec2 authorize-security-group-ingress --group-id "$SG" --protocol tcp --port 80 --cidr "$MYIP" 2>/dev/null || true
    done
  else
    echo "WARNING: could not update EC2 security group; refresh AWS credentials and allow TCP/80 from $MYIP"
  fi
fi

echo "Open http://$EC2_IP/"