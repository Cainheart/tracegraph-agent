#!/bin/bash
set -euo pipefail
trap 'status=$?; printf "%s\n" "$status" > /evidence/container-script-exit.txt' EXIT
printf '%s  %s\n' '41622f1719467850475d583115357d21ba0aa69e8469f27ab8b1e6cf0140298a' '/artifact/outlive.tar.gz' | sha256sum -c - > /evidence/archive-checksum.txt
uname -a > /evidence/uname.txt
cat /etc/os-release > /evidence/os-release.txt
node --version > /evidence/node-version.txt
npm install --global pnpm@11.19.0 --ignore-scripts > /evidence/pnpm-bootstrap.log 2>&1
pnpm --version > /evidence/pnpm-version.txt
mkdir /tmp/outlive-fresh-install
tar -xzf /artifact/outlive.tar.gz -C /tmp/outlive-fresh-install
cd /tmp/outlive-fresh-install/outlive-agent-0.1.0-alpha.0-preview
node scripts/preview-install.mjs > /evidence/preview-install.log 2>&1
node scripts/preview-smoke.mjs > /evidence/preview-smoke.json 2> /evidence/preview-smoke.stderr.log
node demos/proofs.mjs --output /evidence/proofs > /evidence/proofs.log 2>&1
