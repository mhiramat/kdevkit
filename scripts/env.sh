#!/usr/bin/env bash
# Shared environment contract for Linux Kernel VSCode Development Foundation (Phase 1)

WS_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KERNEL_DIR="${KERNEL_DIR:-${WS_ROOT}/linux}"
PROFILE="${PROFILE:-current}"
BUILD_DIR="${BUILD_DIR:-${WS_ROOT}/build/${PROFILE}}"
SHARED_DIR="${SHARED_DIR:-${BUILD_DIR}/shared}"
ARCH="${ARCH:-x86_64}"
BASE_CONFIG="${BASE_CONFIG:-defconfig}"
BUSYBOX_BIN="${BUSYBOX_BIN:-$(command -v busybox 2>/dev/null || true)}"
QEMU_BIN="${QEMU_BIN:-qemu-system-x86_64}"
QEMU_MEM="${QEMU_MEM:-2G}"
QEMU_SMP="${QEMU_SMP:-2}"

export WS_ROOT KERNEL_DIR PROFILE BUILD_DIR SHARED_DIR ARCH BASE_CONFIG
export BUSYBOX_BIN QEMU_BIN QEMU_MEM QEMU_SMP
