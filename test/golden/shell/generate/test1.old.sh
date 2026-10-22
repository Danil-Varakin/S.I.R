#!/bin/sh
# [SHFUNC] строка в функции — у соседней функции то же тело
set -e

update_bad_repo() {
  APT_SOURCES_LIST="/etc/apt/sources.list.d/@@PACKAGE@@.list"
  install_key
}

update_good_repo() {
  APT_SOURCES_LIST="/etc/apt/sources.list.d/@@PACKAGE@@.list"
  install_key
}
