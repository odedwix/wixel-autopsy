import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { config } from './config.js';

// One app at a time: starting it stops the previous copy first. Only our own processes are ever
// killed — the one recorded in the pid file, or a listener on our port whose command is this server.

// One pid file per port, so a second copy on another port never stops this one.
const PID_FILE = path.join(config.cacheDir, `proxy-${config.port}.pid`);
const SELF = 'server/server.js';

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const commandOf = (pid) => {
  try {
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
};

const listenersOn = (port) => {
  try {
    return execFileSync('lsof', ['-nP', `-tiTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).split('\n').map(Number).filter(Boolean);
  } catch {
    return []; // lsof exits 1 when nothing is listening
  }
};

async function stop(pid) {
  process.kill(pid, 'SIGTERM');
  for (let i = 0; i < 30 && alive(pid); i++) await new Promise((r) => setTimeout(r, 100));
  if (alive(pid)) process.kill(pid, 'SIGKILL');
}

export async function takeOver(port) {
  const targets = new Set();
  try {
    const old = Number(fs.readFileSync(PID_FILE, 'utf8'));
    if (old && old !== process.pid && alive(old) && commandOf(old).includes(SELF)) targets.add(old);
  } catch {}
  for (const pid of listenersOn(port)) {
    if (pid === process.pid) continue;
    const cmd = commandOf(pid);
    if (cmd.includes(SELF)) targets.add(pid);
    else throw new Error(`Port ${port} is used by another program (pid ${pid}: ${cmd.slice(0, 80)}). Stop it or set PORT.`);
  }
  for (const pid of targets) {
    console.log(`stopping previous app (pid ${pid})`);
    await stop(pid);
  }
}

export function claim() {
  fs.mkdirSync(config.cacheDir, { recursive: true });
  fs.writeFileSync(PID_FILE, String(process.pid));
  const release = () => {
    try {
      if (Number(fs.readFileSync(PID_FILE, 'utf8')) === process.pid) fs.unlinkSync(PID_FILE);
    } catch {}
  };
  process.on('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
}
