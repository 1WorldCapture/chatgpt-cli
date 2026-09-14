// AdsPower SunBrowser CDP port discovery + port resolution.
//
// AdsPower launches SunBrowser with --remote-debugging-port=0 (random port).
// Discover each running instance: the MAIN process carries --user-data-dir;
// the first line of <user-data-dir>/DevToolsActivePort is the actual port.

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { sleep } from './util';
import type { SunBrowserInstance } from './types';

// Extract the --user-data-dir of every MAIN SunBrowser process from `ps -axo
// command=` output. Main process only: its executable is
// ".../SunBrowser.app/Contents/MacOS/SunBrowser" — Helper processes run
// "SunBrowser Helper.app" (note the space), which must NOT match. The
// user-data-dir path contains spaces ("Application Support"), so capture
// lazily up to the next --flag. Duplicates (same dir seen twice) collapse.
export function parseSunBrowserDataDirs(psOutput: string): string[] {
  const dirs = new Set<string>();
  for (const line of psOutput.split('\n')) {
    if (!/\/SunBrowser\.app\/Contents\/MacOS\/SunBrowser /.test(line)) continue;
    const m = line.match(/--user-data-dir=(.*?)(?=\s--|$)/);
    if (m) dirs.add(m[1]);
  }
  return [...dirs];
}

// The DevToolsActivePort file: line 1 is the port, line 2 the browser ws path.
export function portFromDevToolsActivePort(content: string): string {
  return content.trim().split('\n')[0];
}

// GET <url> and parse JSON, retrying transient failures a few times. A single
// hiccup against the CDP HTTP endpoints (observed on a live SunBrowser) must
// not drop the whole instance from discovery. fetchImpl injectable for tests.
export async function fetchJsonRetry(
  url: string,
  { attempts = 3, timeoutMs = 2000, retryDelayMs = 500, fetchImpl = fetch as typeof fetch }: {
    attempts?: number;
    timeoutMs?: number;
    retryDelayMs?: number;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<any> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      return await res.json();
    } catch (e) { lastErr = e; }
    if (i < attempts - 1) await sleep(retryDelayMs);
  }
  throw lastErr;
}

export async function discoverAdspowerCdp(): Promise<SunBrowserInstance[]> {
  let ps;
  try {
    ps = execSync('ps -axo command=', { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  } catch { return []; }
  const found: SunBrowserInstance[] = [];
  for (const dir of parseSunBrowserDataDirs(ps)) {
    let port;
    try {
      port = portFromDevToolsActivePort(readFileSync(dir + '/DevToolsActivePort', 'utf8'));
    } catch { continue; }
    try {
      const ver: any = await fetchJsonRetry(`http://127.0.0.1:${port}/json/version`);
      let hasChatGptTab = false;
      try {
        const tabs = (await fetchJsonRetry(`http://127.0.0.1:${port}/json/list`)) as any[];
        hasChatGptTab = tabs.some((t: any) => t.type === 'page' && /^https?:\/\/chatgpt\.com\//.test(t.url));
      } catch { /* list optional */ }
      found.push({ envId: dir.split('/').pop()!, port: Number(port), browser: ver.Browser, hasChatGptTab });
    } catch { /* DevToolsActivePort stale — endpoint not up */ }
  }
  return found;
}

// Resolve the port to use: explicit arg > CDP_PORT env > auto-discovery
// (memoized). With several SunBrowser instances, prefer one with an open
// chatgpt.com tab, else the first found.
let resolvedPort: string | number | null = null;

export async function resolvePort(explicit?: string | number | null): Promise<string | number> {
  if (explicit) return explicit;
  if (process.env.CDP_PORT) return process.env.CDP_PORT;
  if (resolvedPort) return resolvedPort;
  const found = await discoverAdspowerCdp();
  if (!found.length) {
    throw new Error('no AdsPower SunBrowser CDP port found — is the browser running? (or set CDP_PORT)');
  }
  resolvedPort = (found.find(f => f.hasChatGptTab) || found[0]).port;
  return resolvedPort;
}
