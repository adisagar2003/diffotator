#!/usr/bin/env bash
# Rebuilds site/home.bundle.js and site/home.bundle.css — the website's React
# islands (React Bits components, see site-src/) — from site-src/home.jsx.
# Maintainers run this after editing site-src/; the output is committed, so
# deploying the website needs no build step. Needs network once, for npm.
set -euo pipefail
cd "$(dirname "$0")/.."
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/src" && cp -R site-src/home.jsx site-src/reactbits "$tmp/src/"
(
  cd "$tmp"
  npm init -y >/dev/null
  npm install --no-audit --no-fund --silent \
    react@18.3.1 react-dom@18.3.1 gsap@3.13.0 @gsap/react@2.1.2 esbuild@0.24.0
  npx esbuild src/home.jsx --bundle --format=iife --minify --target=es2020 \
    --jsx=automatic --loader:.js=jsx \
    --define:process.env.NODE_ENV='"production"' --legal-comments=none \
    --banner:js='/* Includes React Bits components (c) 2026 David Haz, MIT + Commons Clause: https://github.com/DavidHDev/react-bits/blob/main/LICENSE.md */' \
    --outfile=out/home.bundle.js
)
cp "$tmp/out/home.bundle.js" site/home.bundle.js
cp "$tmp/out/home.bundle.css" site/home.bundle.css
ls -l site/home.bundle.*
