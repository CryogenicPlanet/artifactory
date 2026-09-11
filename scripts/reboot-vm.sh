#!/usr/bin/env bash
# Only QMP controls the disposable guest. Never reboot the runner or Docker kernel.
set -euo pipefail
vm_dir=$(mktemp -d)
qemu_pid=''
cleanup() {
  result=$?
  if [[ "$result" != 0 && -f "$vm_dir/qemu.log" ]]; then
    echo 'QEMU host diagnostics (guest credentials and runtime logs excluded):' >&2
    tail -40 "$vm_dir/qemu.log" >&2
  fi
  if [[ -n "$qemu_pid" ]]; then kill "$qemu_pid" 2>/dev/null || true; wait "$qemu_pid" 2>/dev/null || true; fi
  rm -rf "$vm_dir"
  return "$result"
}
trap cleanup EXIT
umask 077
ssh-keygen -q -t ed25519 -N '' -f "$vm_dir/key"
cat > "$vm_dir/user-data" <<EOF
#cloud-config
users:
  - name: ubuntu
    sudo: ALL=(ALL) NOPASSWD:ALL
    groups: users
    shell: /bin/bash
    ssh_authorized_keys:
      - $(cat "$vm_dir/key.pub")
ssh_pwauth: false
EOF
printf 'instance-id: comms-reboot\nlocal-hostname: comms-reboot\n' > "$vm_dir/meta-data"
cloud-localds "$vm_dir/seed.img" "$vm_dir/user-data" "$vm_dir/meta-data"
curl --fail --location --silent --show-error --retry 3 \
  https://cloud-images.ubuntu.com/noble/20260826/noble-server-cloudimg-amd64.img -o "$vm_dir/base.img"
printf '%s  %s\n' d0fe84bb5f80853425fa6be28e2c106f30104c3cfe8611933f2e65c9b63f0e30 "$vm_dir/base.img" | sha256sum --check -
qemu-img create -q -f qcow2 -F qcow2 -b "$vm_dir/base.img" "$vm_dir/guest.img" 8G
cp /usr/share/OVMF/OVMF_VARS_4M.fd "$vm_dir/vars.fd"
accelerator='tcg,thread=multi'
cpu='max'
if [[ -r /dev/kvm && -w /dev/kvm ]]; then accelerator=kvm; cpu=host; fi
printf 'Guest accelerator: %s\n' "$accelerator"
qemu-system-x86_64 -machine q35 -accel "$accelerator" -cpu "$cpu" -smp 2 -m 2048 \
  -drive if=pflash,format=raw,readonly=on,file=/usr/share/OVMF/OVMF_CODE_4M.fd \
  -drive "if=pflash,format=raw,file=$vm_dir/vars.fd" \
  -drive "file=$vm_dir/guest.img,if=virtio,format=qcow2,cache=none" \
  -drive "file=$vm_dir/seed.img,if=virtio,format=raw,readonly=on" \
  -nic user,hostfwd=tcp:127.0.0.1:2222-:22 -display none \
  -serial "file:$vm_dir/serial.log" -qmp "unix:$vm_dir/qmp,server=on,wait=off" > "$vm_dir/qemu.log" 2>&1 &
qemu_pid=$!
ssh_options=(-i "$vm_dir/key" -p 2222 -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR)
wait_guest() {
  for _ in $(seq 1 120); do
    kill -0 "$qemu_pid"
    if ssh "${ssh_options[@]}" ubuntu@127.0.0.1 true 2>/dev/null; then return; fi
    sleep 2
  done
  echo 'Guest SSH did not become ready' >&2
  return 1
}
wait_guest
# Transfer the built Linux runtime and its exact resolved dependency tree, not macOS binaries.
tar -czf "$vm_dir/runtime.tgz" --exclude='packages/*/test' \
  package.json bun.lock node_modules packages scripts/reboot-guest.py
scp -q -i "$vm_dir/key" -P 2222 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR \
  "$vm_dir/runtime.tgz" "$(command -v bun)" ubuntu@127.0.0.1:/home/ubuntu/
ssh "${ssh_options[@]}" ubuntu@127.0.0.1 \
  'sudo install -m755 /home/ubuntu/bun /usr/local/bin/bun; mkdir comms; tar -xzf runtime.tgz -C comms; cd comms; test "$(bun --revision)" = "1.4.0+34cbb9a40"; python3 - <<'"'"'PY'"'"'
import json
from pathlib import Path
for name, entry in [("boot", "./dist/index.js"), ("server", "./dist/start.js")]:
 p=Path("packages")/name/"package.json"
 data=json.loads(p.read_text()); data["exports"]["."]=entry; p.write_text(json.dumps(data))
PY
python3 scripts/reboot-guest.py before'
# Keep the test oracle outside the guest; do not rely on un-fsynced fixture metadata.
scp -q -i "$vm_dir/key" -P 2222 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR \
  ubuntu@127.0.0.1:/home/ubuntu/comms/reboot-proof.json ubuntu@127.0.0.1:/home/ubuntu/comms/reboot-cookie "$vm_dir/"
# QMP hard-reset does not deliver shutdown signals to the guest kernel or keeper.
python3 - "$vm_dir/qmp" <<'PY'
import json, socket, sys
with socket.socket(socket.AF_UNIX) as client:
 client.settimeout(10); client.connect(sys.argv[1]); stream=client.makefile('rwb')
 json.loads(stream.readline())
 for command in ['qmp_capabilities', 'system_reset']:
  stream.write((json.dumps({'execute':command})+'\n').encode()); stream.flush()
  while True:
   response=json.loads(stream.readline())
   if 'error' in response: raise RuntimeError(response)
   if 'return' in response: break
PY
# Wait for the old SSH connection/kernel to disappear, then require a changed boot ID in the probe.
sleep 3
wait_guest
scp -q -i "$vm_dir/key" -P 2222 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR \
  "$vm_dir/reboot-proof.json" "$vm_dir/reboot-cookie" ubuntu@127.0.0.1:/home/ubuntu/comms/
ssh "${ssh_options[@]}" ubuntu@127.0.0.1 'cd comms; python3 scripts/reboot-guest.py after' 
