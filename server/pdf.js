import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

// Reports as real PDF downloads, no print dialog: headless Chrome opens the app's own report view
// (`?report=run|insights`), waits until report.js says it's ready, and prints it with the page's
// CSS size and colours (Chrome DevTools protocol over the WebSocket built into Node 22).
// One at a time; each render uses a throwaway Chrome process with its own profile.

const CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);
export const chromePath = () => CANDIDATES.find((p) => existsSync(p)) || null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let chain = Promise.resolve();

// One Chrome job at a time (PDFs and Exact captures share it).
export function withChrome(fn) {
  const job = chain.then(() => session(fn));
  chain = job.catch(() => {});
  return job;
}

export function renderPdf(url, { timeoutMs = 180000 } = {}) {
  return withChrome(async ({ send }) => {
    // Tell the page it's being rendered here: report.js then marks itself ready instead of
    // opening the print dialog.
    await send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__AUTOPSY_HEADLESS = true;' });
    await send('Page.navigate', { url });
    const state = await waitFor(send, 'window.__reportState || null', timeoutMs);
    if (!state) throw Object.assign(new Error('The report took too long to build'), { status: 504 });
    if (state.error) throw Object.assign(new Error(state.error), { status: 500 });
    await send('Emulation.setEmulatedMedia', { media: 'print' });
    await sleep(800);
    const pdf = await send('Page.printToPDF', { preferCSSPageSize: true, printBackground: true, displayHeaderFooter: false });
    if (!pdf.result?.data) throw new Error(pdf.error?.message || 'printToPDF failed');
    return { buf: Buffer.from(pdf.result.data, 'base64'), title: state.title || null };
  });
}

// Poll a page expression until it's truthy.
export async function waitFor(send, expression, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await sleep(500);
    const r = await send('Runtime.evaluate', { expression, returnByValue: true });
    const v = r.result?.result?.value;
    if (v) return v;
  }
  return null;
}

// A throwaway headless Chrome with one page; `fn({ send })` drives it over the DevTools protocol.
async function session(fn) {
  const bin = chromePath();
  if (!bin) throw Object.assign(new Error('Google Chrome not found (set CHROME_PATH)'), { status: 503 });
  // A fresh profile per session (a killed Chrome can still be writing to the last one).
  await fs.mkdir(path.join(config.cacheDir, 'chrome-pdf'), { recursive: true });
  const profile = await fs.mkdtemp(path.join(config.cacheDir, 'chrome-pdf', 'p-'));
  // Software WebGL (SwiftShader): the product's image components draw with WebGL, and without a GPU
  // headless Chrome has no WebGL context — those layers would come out blank in Exact captures.
  const chrome = spawn(bin, ['--headless=new', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-first-run', '--no-default-browser-check', '--mute-audio',
    '--autoplay-policy=no-user-gesture-required', `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--window-size=1400,1000', 'about:blank'], { stdio: 'ignore' });
  let ws;
  try {
    // Chrome writes the port it picked to DevToolsActivePort.
    let port;
    for (let i = 0; i < 100 && !port; i++) {
      await sleep(100);
      port = (await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8').catch(() => '')).split('\n')[0];
    }
    if (!port) throw new Error('headless Chrome did not start');
    const page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page');
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve);
      ws.addEventListener('error', reject);
    });
    let id = 0;
    const pending = new Map();
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) {
        pending.get(m.id)(m);
        pending.delete(m.id);
      }
    });
    const send = (method, params = {}) => new Promise((resolve) => {
      const i = ++id;
      pending.set(i, resolve);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
    await send('Page.enable');
    return await fn({ send });
  } finally {
    try {
      ws?.close();
    } catch {}
    const exited = new Promise((r) => chrome.once('exit', r));
    chrome.kill();
    await Promise.race([exited, sleep(3000)]);
    fs.rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}
