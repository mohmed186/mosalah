#!/usr/bin/env sh
set -e
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22 or newer is required."
  exit 1
fi
echo "Starting Nest Marketplace at http://localhost:3000"
node server.js
