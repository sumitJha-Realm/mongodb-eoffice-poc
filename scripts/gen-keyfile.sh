#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p keyfile
openssl rand -base64 756 > keyfile/mongo-keyfile
chmod 600 keyfile/mongo-keyfile
echo "Keyfile generated at keyfile/mongo-keyfile"
