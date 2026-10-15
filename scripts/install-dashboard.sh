#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if command -v dnf >/dev/null 2>&1; then
  sudo dnf install -y nginx
else
  sudo apt-get update -y
  sudo apt-get install -y nginx
fi

npm --prefix app install --omit=dev --silent
chmod +x scripts/port-forward-run.sh
sudo install -m 0644 aws/eoffice-portforward.service /etc/systemd/system/eoffice-portforward.service
sudo install -m 0644 aws/eoffice-dashboard.service /etc/systemd/system/eoffice-dashboard.service
sudo install -m 0644 aws/eoffice-dashboard.nginx.conf /etc/nginx/conf.d/eoffice-dashboard.conf
sudo systemctl daemon-reload
sudo systemctl enable --now eoffice-portforward
sudo systemctl enable --now eoffice-dashboard
sudo nginx -t
sudo systemctl enable --now nginx
sudo systemctl restart eoffice-portforward
sudo systemctl restart eoffice-dashboard
sudo systemctl restart nginx

echo "Dashboard: http://$(hostname -I | awk '{print $1}')/"