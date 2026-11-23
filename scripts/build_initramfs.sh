#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/env.sh
source "${SCRIPT_DIR}/env.sh"

if [ -z "${BUSYBOX_BIN}" ] || [ ! -x "${BUSYBOX_BIN}" ]; then
  echo "Error: busybox binary not found (BUSYBOX_BIN='${BUSYBOX_BIN}')." >&2
  echo "Hint: Install 'busybox-static' or set BUSYBOX_BIN=/path/to/busybox." >&2
  exit 1
fi

LDD_OUT="$(LC_ALL=C ldd "${BUSYBOX_BIN}" 2>&1 || true)"
if [[ "${LDD_OUT}" != *"not a dynamic executable"* ]] && [[ "${LDD_OUT}" != *"statically linked"* ]]; then
  echo "Error: ${BUSYBOX_BIN} appears to be dynamically linked:" >&2
  echo "${LDD_OUT}" >&2
  echo "Hint: Install a statically linked BusyBox package (e.g., busybox-static)." >&2
  exit 1
fi

mkdir -p "${BUILD_DIR}" "${SHARED_DIR}"

ROOTFS_DIR="$(mktemp -d)"
trap 'rm -rf "${ROOTFS_DIR}"' EXIT

echo "==> [1/4] Creating minimal rootfs hierarchy"
mkdir -p \
  "${ROOTFS_DIR}/bin" \
  "${ROOTFS_DIR}/sbin" \
  "${ROOTFS_DIR}/etc" \
  "${ROOTFS_DIR}/root" \
  "${ROOTFS_DIR}/proc" \
  "${ROOTFS_DIR}/sys" \
  "${ROOTFS_DIR}/dev" \
  "${ROOTFS_DIR}/tmp" \
  "${ROOTFS_DIR}/usr/bin" \
  "${ROOTFS_DIR}/usr/sbin" \
  "${ROOTFS_DIR}/usr/lib" \
  "${ROOTFS_DIR}/usr/lib64" \
  "${ROOTFS_DIR}/mnt/host" \
  "${ROOTFS_DIR}/lib/modules" \
  "${ROOTFS_DIR}/lib64"

cat << 'EOF' > "${ROOTFS_DIR}/etc/passwd"
root:x:0:0:root:/root:/bin/sh
daemon:x:1:1:daemon:/usr/sbin:/bin/false
bin:x:2:2:bin:/bin:/bin/false
sys:x:3:3:sys:/dev:/bin/false
nobody:x:65534:65534:nobody:/nonexistent:/bin/false
EOF

cat << 'EOF' > "${ROOTFS_DIR}/etc/group"
root:x:0:
daemon:x:1:
bin:x:2:
sys:x:3:
adm:x:4:
tty:x:5:
disk:x:6:
nogroup:x:65534:
EOF

echo "==> [2/4] Installing static BusyBox (${BUSYBOX_BIN}) and kernel modules"
cp "${BUSYBOX_BIN}" "${ROOTFS_DIR}/bin/busybox"
chmod +x "${ROOTFS_DIR}/bin/busybox"
ln -sf busybox "${ROOTFS_DIR}/bin/sh"

# GNU-compatible wrapper for /usr/bin/timeout (kselftest runner.sh passes --foreground)
cat << 'EOF' > "${ROOTFS_DIR}/usr/bin/timeout"
#!/bin/sh
OPTS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --foreground|--preserve-status)
      shift
      ;;
    -s|-k)
      OPTS="$OPTS $1 $2"
      shift 2
      ;;
    --signal=*)
      OPTS="$OPTS -s ${1#*=}"
      shift
      ;;
    --kill-after=*)
      OPTS="$OPTS -k ${1#*=}"
      shift
      ;;
    --)
      shift
      break
      ;;
    *)
      break
      ;;
  esac
done
DUR="${1:-0}"
shift || true
if [ "$DUR" = "0" ] || [ "$DUR" = "0s" ]; then
  exec "$@"
fi
exec /bin/busybox timeout $OPTS "$DUR" "$@"
EOF
chmod +x "${ROOTFS_DIR}/usr/bin/timeout"

if [ -f "${BUILD_DIR}/modules.order" ]; then
  make -C "${KERNEL_DIR}" O="${BUILD_DIR}" ARCH="${ARCH}" \
    INSTALL_MOD_PATH="${ROOTFS_DIR}" modules_install
fi

echo "==> [3/4] Generating deterministic guest /init"
cat << 'EOF' > "${ROOTFS_DIR}/init"
#!/bin/sh

/bin/busybox --install -s

mount -t proc proc /proc
mount -t sysfs sysfs /sys
mount -t devtmpfs devtmpfs /dev 2>/dev/null || true

ln -sf /proc/self/fd /dev/fd
ln -sf /proc/self/fd/0 /dev/stdin
ln -sf /proc/self/fd/1 /dev/stdout
ln -sf /proc/self/fd/2 /dev/stderr

mkdir -p /sys/kernel/tracing
mount -t tracefs tracefs /sys/kernel/tracing 2>/dev/null || true

mkdir -p /mnt/host
if ! mount -t 9p -o trans=virtio,version=9p2000.L,msize=104857600 hostshare /mnt/host; then
  echo "[init] Warning: Failed to mount 9p hostshare at /mnt/host" >&2
fi

if [ -x /mnt/host/setup_kprobes.sh ]; then
  echo "[init] Running /mnt/host/setup_kprobes.sh..."
  /mnt/host/setup_kprobes.sh
fi

if [ -x /mnt/host/run_target.sh ]; then
  echo "[init] Running batch target /mnt/host/run_target.sh..."
  /mnt/host/run_target.sh
  TARGET_RC=$?
  echo "${TARGET_RC}" > /mnt/host/exit_code
  echo "[init] Batch target finished with exit code ${TARGET_RC}"
else
  echo "[init] Entering interactive BusyBox shell (type 'exit' to poweroff and collect trace.log)"
  setsid cttyhack /bin/sh
fi

if [ -w /sys/kernel/tracing/tracing_on ]; then
  echo 0 > /sys/kernel/tracing/tracing_on
fi
if [ -r /sys/kernel/tracing/trace ] && [ -d /mnt/host ]; then
  cp /sys/kernel/tracing/trace /mnt/host/trace.log 2>/dev/null || true
fi

sync
poweroff -f
EOF
chmod +x "${ROOTFS_DIR}/init"

echo "==> [4/4] Packing ${BUILD_DIR}/initramfs.cpio.gz"
(
  cd "${ROOTFS_DIR}"
  find . -print0 | cpio --null -ov --format=newc 2>/dev/null | gzip -1 > "${BUILD_DIR}/initramfs.cpio.gz"
)

echo "==> initramfs created at ${BUILD_DIR}/initramfs.cpio.gz"
