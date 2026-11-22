#!/bin/sh
# Fetches the packed Google Books English Fiction model used by the demo.
set -eu
cd "$(dirname "$0")/../data"

tag=bigrams-en-v1
sha256=e70aa64fef41342cedc1156827b8b52ef770832b8f234f8e8edb2af91f16de9e
file=bigrams-en.bin.gz
url="https://github.com/peterchinman/mishear/releases/download/$tag/$file"

temporary=$(mktemp "$file.XXXXXX")
trap 'rm -f "$temporary"' EXIT
curl --fail --silent --show-error --location --retry 3 "$url" --output "$temporary"
printf '%s  %s\n' "$sha256" "$temporary" | shasum -a 256 --check -
mv -f "$temporary" "$file"
printf 'Ready at data/%s\n' "$file"
