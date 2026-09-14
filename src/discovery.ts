// AdsPower SunBrowser CDP port discovery + port resolution.
//
// AdsPower launches SunBrowser with --remote-debugging-port=0 (random port).
// Discover each running instance: the MAIN process carries --user-data-dir;
// the first line of <user-data-dir>/DevToolsActivePort is the actual port.

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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
      const ver: any = await (await fetch(`http://127.0.0.1:${port}/json/version`,
        { signal: AbortSignal.timeout(2000) })).json();
      let hasChatGptTab = false;
      try {
        const tabs = (await (await fetch(`http://127.0.0.1:${port}/json/list`,
          { signal: AbortSignal.timeout(2000) })).json()) as any[];
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
