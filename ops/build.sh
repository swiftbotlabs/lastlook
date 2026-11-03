#!/usr/bin/env bash
# Copy the pure check modules to the browser bundle: the checks run in the page, on the same code the tests cover.
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf public/checks
mkdir -p public/checks
cp src/checks/*.js public/checks/
echo "build: copied $(ls public/checks | wc -l) check modules to public/checks"
