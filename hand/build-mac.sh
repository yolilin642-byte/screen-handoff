#!/bin/sh
# 在 mac 上编屏幕小程序的两只手。要先装命令行工具：xcode-select --install
# 编出来的 hand-mac、overlay-mac 跟这份脚本放在同一个目录（server.mjs 在 mac 上就找它们）。
# 没在 mac 上跑过。
set -e
cd "$(dirname "$0")"
swiftc -O hand-mac.swift -o hand-mac
swiftc -O overlay-mac.swift -o overlay-mac
echo "好了：$(pwd)/hand-mac  $(pwd)/overlay-mac"
echo "头一回跑会被系统拦：去 系统设置 → 隐私与安全性，给拉起它的程序（终端或 node）开 屏幕录制、辅助功能、输入监控。"
