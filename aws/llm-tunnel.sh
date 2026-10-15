#!/usr/bin/env bash
# The MongoDB AI gateway only accepts requests from the corp network, so the EC2
# host can't call it directly. This runs a tiny forwarder on the Mac and exposes
# it to EC2 over a reverse SSH tunnel: EC2 -> localhost:8089 -> Mac -> gateway.
# Keep this running during the demo (RAG answers depend on it).
set -euo pipefail
cd "$(dirname "$0")/.."
source aws/instance.env

PORT=8089
pkill -f "ai-gateway-proxy" 2>/dev/null || true

node -e '
const http = require("http");
const UP = "https://ai-gateway.corp.mongodb.com";
http.createServer((req, res) => {
  let body = [];
  req.on("data", c => body.push(c)).on("end", async () => {
    try {
      const r = await fetch(UP + req.url, {
        method: req.method,
        headers: { "Content-Type": "application/json", Authorization: req.headers.authorization || "" },
        body: body.length ? Buffer.concat(body) : undefined,
      });
      res.writeHead(r.status, { "Content-Type": "application/json" });
      res.end(await r.text());
    } catch (e) { res.writeHead(502); res.end(JSON.stringify({ error: e.message })); }
  });
}).listen('"$PORT"', "127.0.0.1", () => console.log("ai-gateway-proxy on 127.0.0.1:'"$PORT"'"));
' &
sleep 1

echo "Opening reverse tunnel to $EC2_IP (Ctrl-C to stop)..."
ssh -i "$PEM" -o ExitOnForwardFailure=yes -R ${PORT}:127.0.0.1:${PORT} "ec2-user@$EC2_IP" \
  "echo 'tunnel up: EC2 localhost:${PORT} -> Mac -> ai-gateway'; sleep infinity"
