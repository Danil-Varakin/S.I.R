#!/bin/sh
# [DRIFT] upstream добавил функцию и строку в update_bad_repo — строка встаёт в update_good_repo
set -e

noop() { :; }

update_bad_repo() {
  echo "bad"
  APT_SOURCES_LIST="/etc/apt/sources.list.d/@@PACKAGE@@.list"
  install_key
}

update_good_repo() {
  APT_SOURCES_LIST="/etc/apt/sources.list.d/@@PACKAGE@@.list"
  install_key
}
