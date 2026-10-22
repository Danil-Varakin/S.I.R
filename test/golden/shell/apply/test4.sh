#!/bin/sh
# [CASE] upstream добавил ветку case перед abort-upgrade — новая встаёт за ней
case "$1" in
  configure)
    update_alternatives
    ;;
  upgrade)
    ;;
  abort-upgrade)
    ;;
esac
