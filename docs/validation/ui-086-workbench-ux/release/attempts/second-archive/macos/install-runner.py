from pathlib import Path
import os, subprocess, json
out=Path(__file__).parent
installed=Path((out/'install-path.txt').read_text().strip())
env=dict(os.environ);env.pop('NODE_OPTIONS',None)
for label,args in [('preview-install',['node','scripts/preview-install.mjs','--desktop']),('preview-smoke',['node','scripts/preview-smoke.mjs']),('proofs',['node','demos/proofs.mjs','--output',str(out/'proofs')])]:
 with (out/(label+'.stdout.log')).open('w') as stdout, (out/(label+'.stderr.log')).open('w') as stderr:
  result=subprocess.run(args,cwd=installed,env=env,stdout=stdout,stderr=stderr)
 (out/(label+'-exit.txt')).write_text(str(result.returncode)+'\n')
 if result.returncode: raise SystemExit(result.returncode)
 if label=='preview-smoke':
  report=json.loads((out/(label+'.stdout.log')).read_text())
  (out/'preview-smoke-report.json').write_text(json.dumps(report,indent=2)+'\n')
print('macOS final frozen Desktop install, smoke and proofs finished.')
