#!/usr/bin/env python3
"""Create fresh immutable-archive-only install evidence; does not launch apps."""
from pathlib import Path
import hashlib
import json
import os
import platform
import subprocess
import sys
import tempfile

archive = Path(sys.argv[1]).resolve()
digest = sys.argv[2]
output = Path(sys.argv[3]).resolve()
container_name = sys.argv[4]
assert hashlib.sha256(archive.read_bytes()).hexdigest() == digest
output.mkdir(parents=True, exist_ok=False)
for surface in ["linux", "macos"]:
    (output / surface).mkdir()
(output / "scope.json").write_text(json.dumps({
    "schema_version": "outlive.ux086.release-closure.v1",
    "participant_class": "simulated", "participant": "maintainer workspace Agent",
    "independent_non_maintainer": False, "archive": str(archive), "archive_sha256": digest,
    "status": "installing", "linux_image": "node:22.19.0-bookworm-slim",
    "linux_image_id": "sha256:4a4884e8a44826194dff92ba316264f392056cbe243dcc9fd3551e71cea02b90",
    "frozen_archive_not_modified": True,
}, indent=2) + "\n")
script = f'''#!/bin/bash
set -euo pipefail
trap 'status=$?; printf "%s\\n" "$status" > /evidence/container-script-exit.txt' EXIT
printf '%s  %s\\n' '{digest}' '/artifact/outlive.tar.gz' | sha256sum -c - > /evidence/archive-checksum.txt
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
'''
(output / "linux/install.sh").write_text(script)
command = [
    "docker", "run", "--init", "--rm", "--name", container_name,
    "--mount", f"type=bind,src={archive},dst=/artifact/outlive.tar.gz,readonly",
    "--mount", f"type=bind,src={output}/linux,dst=/evidence",
    "node:22.19.0-bookworm-slim", "bash", "/evidence/install.sh",
]
(output / "linux/docker-command.json").write_text(json.dumps(command, indent=2) + "\n")
runner = '''from pathlib import Path
import subprocess, json
out=Path(__file__).parent
command=json.loads((out/'docker-command.json').read_text())
with (out/'docker-run.log').open('w') as stream:
 result=subprocess.run(command,stdout=stream,stderr=subprocess.STDOUT)
(out/'docker-run-exit.txt').write_text(str(result.returncode)+'\\n')
print('Linux frozen install exit:',result.returncode)
raise SystemExit(result.returncode)
'''
(output / "linux/install-runner.py").write_text(runner)
temporary = Path(tempfile.mkdtemp(prefix="outlive-ux086-macos-third-"))
subprocess.run(["tar", "-xzf", str(archive), "-C", str(temporary)], check=True)
installed = temporary / "outlive-agent-0.1.0-alpha.0-preview"
(output / "macos/install-path.txt").write_text(str(installed) + "\n")
environment = dict(os.environ)
environment.pop("NODE_OPTIONS", None)
node = subprocess.check_output(["node", "--version"], env=environment, text=True).strip()
pnpm = subprocess.check_output(["pnpm", "--version"], env=environment, text=True).strip()
assert pnpm == "11.19.0"
(output / "macos/environment.json").write_text(json.dumps({
    "schema_version": "outlive.ux086.macos-environment.v1",
    "platform": platform.platform(), "machine": platform.machine(), "node": node,
    "pnpm": pnpm, "new_extract": str(installed), "source_mounted": False,
    "note": "same maintainer Mac; fresh directory and frozen install; not a clean machine or independent-user evidence",
}, indent=2) + "\n")
mac_runner = '''from pathlib import Path
import os, subprocess, json
out=Path(__file__).parent
installed=Path((out/'install-path.txt').read_text().strip())
env=dict(os.environ);env.pop('NODE_OPTIONS',None)
for label,args in [('preview-install',['node','scripts/preview-install.mjs','--desktop']),('preview-smoke',['node','scripts/preview-smoke.mjs']),('proofs',['node','demos/proofs.mjs','--output',str(out/'proofs')])]:
 with (out/(label+'.stdout.log')).open('w') as stdout, (out/(label+'.stderr.log')).open('w') as stderr:
  result=subprocess.run(args,cwd=installed,env=env,stdout=stdout,stderr=stderr)
 (out/(label+'-exit.txt')).write_text(str(result.returncode)+'\\n')
 if result.returncode: raise SystemExit(result.returncode)
 if label=='preview-smoke':
  report=json.loads((out/(label+'.stdout.log')).read_text())
  (out/'preview-smoke-report.json').write_text(json.dumps(report,indent=2)+'\\n')
print('macOS frozen Desktop install, smoke and proofs finished.')
'''
(output / "macos/install-runner.py").write_text(mac_runner)
print(json.dumps({"output": str(output), "mac_installed": str(installed), "archive_verified": digest}))
