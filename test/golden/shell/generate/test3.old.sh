#!/bin/sh
# [SHSUBST] правка внутри $( … ) и ${ … } — `#` в ${#x} не комментарий
CHANNEL="${1:-stable}"
LEN="${#CHANNEL}"
VERSION="$(cat "$(dirname "$0")/VERSION")"
echo "$CHANNEL $LEN $VERSION"
