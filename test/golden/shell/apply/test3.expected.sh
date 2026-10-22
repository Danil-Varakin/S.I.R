#!/bin/sh
# [DEEPER] upstream переотступил тело глубже — строка встаёт в свой if, со своим отступом (в shell он не значим; в YAML это Н2)
remove_udev_symlinks() {
    if [ -L "/usr/lib/libudev.so.0" ]; then
      rm "/usr/lib/libudev.so.0"
    rm -f "/usr/lib/brave/libudev.so.0"
    fi
}
