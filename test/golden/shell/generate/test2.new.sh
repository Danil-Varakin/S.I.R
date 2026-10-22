#!/bin/sh
# [SHCASE] новая ветка case — `)` у шаблонов case не пара, а ;; не скобка
case "$1" in
  configure)
    update_alternatives
    ;;
  abort-upgrade)
    ;;
  remove)
    cleanup_brave
    ;;
esac
