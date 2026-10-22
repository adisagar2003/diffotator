#!/usr/bin/env bash
# Rebuilds web/vendor/canvas.js and canvas.css — the walkthrough map (React,
# React Flow and ELK) — from vendor-src/canvas.js. Maintainers run this after
# editing vendor-src/; people installing diffotator never do, because the
# output is committed. Needs network once, for npm.
set -euo pipefail
cd "$(dirname "$0")/.."
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cp vendor-src/canvas.js "$tmp/canvas.js"
(
  cd "$tmp"
  npm init -y >/dev/null
  npm install --no-audit --no-fund --silent \
    react@18.3.1 react-dom@18.3.1 @xyflow/react@12.3.5 elkjs@0.9.3 esbuild@0.24.0
  npx esbuild canvas.js --bundle --format=iife --minify --target=es2020 \
    --define:process.env.NODE_ENV='"production"' --legal-comments=none \
    --outfile=out.js
)
mkdir -p web/vendor
cp "$tmp/out.js" web/vendor/canvas.js
cp "$tmp/node_modules/@xyflow/react/dist/style.css" web/vendor/canvas.css
ls -l web/vendor
