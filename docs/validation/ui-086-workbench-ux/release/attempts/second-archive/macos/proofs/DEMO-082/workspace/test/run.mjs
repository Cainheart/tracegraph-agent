import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
process.on('SIGTERM', () => {});
const child = spawn(process.execPath, ['-e', `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)`], { stdio: 'ignore' });
writeFileSync('processes.json', JSON.stringify({ leader: process.pid, descendant: child.pid }));
setInterval(() => {}, 1000);
