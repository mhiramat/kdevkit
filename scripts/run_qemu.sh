#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/env.sh
source "${SCRIPT_DIR}/env.sh"

BZIMAGE="${BUILD_DIR}/arch/x86/boot/bzImage"
INITRAMFS="${BUILD_DIR}/initramfs.cpio.gz"

if [ ! -f "${BZIMAGE}" ]; then
  echo "Error: Kernel image not found at ${BZIMAGE}" >&2
  echo "Hint: Run ./scripts/build_kernel.sh first." >&2
  exit 1
fi

if [ ! -f "${INITRAMFS}" ]; then
  echo "Error: initramfs not found at ${INITRAMFS}" >&2
  echo "Hint: Run ./scripts/build_initramfs.sh first." >&2
  exit 1
fi

mkdir -p "${SHARED_DIR}"

KVM_FLAGS=""
if [ -r /dev/kvm ] && [ -w /dev/kvm ]; then
  KVM_FLAGS="-enable-kvm -cpu host"
else
  echo "Warning: /dev/kvm is not accessible; falling back to QEMU TCG software emulation." >&2
fi

echo "==> Launching QEMU (${QEMU_BIN})"
echo "    Kernel:    ${BZIMAGE}"
echo "    Initramfs: ${INITRAMFS}"
echo "    9p Share:  ${SHARED_DIR} -> /mnt/host"

# shellcheck disable=SC2086
exec "${QEMU_BIN}" \
  ${KVM_FLAGS} \
  -m "${QEMU_MEM}" -smp "${QEMU_SMP}" \
  -kernel "${BZIMAGE}" \
  -initrd "${INITRAMFS}" \
  -append "console=ttyS0 nokaslr quiet loglevel=4" \
  -virtfs "local,path=${SHARED_DIR},mount_tag=hostshare,security_model=none,id=hostshare" \
  -nographic -no-reboot \
  ${QEMU_EXTRA_ARGS:-}
