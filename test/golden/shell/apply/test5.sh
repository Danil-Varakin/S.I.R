#!/bin/sh
# [EOL] CRLF-база
CHANNEL="${1:-stable}"
LEN="${#CHANNEL}"
VERSION="$(cat "$(dirname "$0")/VERSION")"
echo "$CHANNEL $LEN $VERSION"
