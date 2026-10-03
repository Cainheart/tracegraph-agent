from pathlib import Path
import subprocess, json
out=Path(__file__).parent
command=json.loads((out/'docker-command.json').read_text())
with (out/'docker-run.log').open('w') as stream:
 result=subprocess.run(command,stdout=stream,stderr=subprocess.STDOUT)
(out/'docker-run-exit.txt').write_text(str(result.returncode)+'\n')
print('Linux frozen install exit:',result.returncode)
raise SystemExit(result.returncode)
