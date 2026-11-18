#!/bin/sh
set -eu

release_url=https://github.com/pavel-voronin/byteforbyte/releases/download/catalog-production/catalog.html
public=/srv/byteforbyte/public/index.html
stage=$(mktemp /srv/byteforbyte/staging/catalog.XXXXXX)
trap 'rm -f "$stage"' EXIT
trap 'exit 1' HUP INT TERM

curl --silent --show-error --fail --location \
  --proto '=https' --proto-redir '=https' --max-time 30 --max-filesize 1048576 \
  --output "$stage" "$release_url?sync=$(date +%s)"
grep -qx '<!doctype html>' "$stage"
grep -Eq '^<meta name="catalog-revision" content="[a-f0-9]{40}">$' "$stage"

if [ -f "$public" ] && cmp -s "$stage" "$public"; then
  exit 0
fi
chmod 644 "$stage"
mv -f "$stage" "$public"
sed -nE 's/^<meta name="catalog-revision" content="([a-f0-9]{40})">$/Published \1/p' "$public"
