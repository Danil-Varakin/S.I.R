#!/bin/sh
# [RENAMED] MUST-REFUSE: upstream переименовал функцию — заголовок блока не совпал
set -e

update_bad_repo() {
  APT_SOURCES_LIST="/etc/apt/sources.list.d/@@PACKAGE@@.list"
  install_key
}

update_repo_config() {
  APT_SOURCES_LIST="/etc/apt/sources.list.d/@@PACKAGE@@.list"
  install_key
}
