#!/usr/bin/env bash
# Copy the shared, pure check modules the browser needs (exact character counting in the edit dialog).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p public/checks
cp src/checks/text.js src/checks/length.js public/checks/
echo "build: copied text.js length.js to public/checks"
