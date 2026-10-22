#!/bin/sh
# [SHINDENT] вставка в if внутри функции — отступ строки значим
remove_udev_symlinks() {
  if [ -L "/usr/lib/libudev.so.0" ]; then
    rm "/usr/lib/libudev.so.0"
  fi
}
