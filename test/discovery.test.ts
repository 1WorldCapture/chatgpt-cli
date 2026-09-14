// Unit tests for SunBrowser CDP port discovery parsing (pure logic, no browser).
import { describe, expect, it } from 'bun:test';
import { fetchJsonRetry, parseSunBrowserDataDirs, portFromDevToolsActivePort } from '../src/discovery';

// Realistic `ps -axo command=` excerpt: one main SunBrowser, one Helper
// (must NOT match), one unrelated process, and a duplicate of the main line.
const PS_OUTPUT = [
  '/Applications/SunBrowser.app/Contents/MacOS/SunBrowser --user-data-dir=/Users/x/Library/Application Support/AdsPower/sunbrowser/Default --remote-debugging-port=0',
  '/Applications/SunBrowser.app/Contents/Frameworks/SunBrowser Helper.app/Contents/MacOS/SunBrowser Helper --user-data-dir=/must/not/match --type=renderer',
  '/Applications/SunBrowser.app/Contents/MacOS/SunBrowser --user-data-dir=/Users/x/Library/Application Support/AdsPower/sunbrowser/Default --duplicate-line',
  '/usr/libexec/syslogd --user-data-dir=/also/not/a/browser',
  'grep SunBrowser',
].join('\n');

describe('parseSunBrowserDataDirs', () => {
  it('extracts the main-process user-data-dir with spaces in the path', () => {
    expect(parseSunBrowserDataDirs(PS_OUTPUT)).toEqual([
      '/Users/x/Library/Application Support/AdsPower/sunbrowser/Default',
    ]);
  });

  it('ignores SunBrowser Helper processes', () => {
    const dirs = parseSunBrowserDataDirs(PS_OUTPUT);
    expect(dirs.some(d => d.includes('must'))).toBe(false);
  });

  it('captures lazily up to the next --flag, not to the first space', () => {
    const dirs = parseSunBrowserDataDirs(
      '/Applications/SunBrowser.app/Contents/MacOS/SunBrowser --user-data-dir=/a dir/with spaces --type=gpu-process',
    );
    expect(dirs).toEqual(['/a dir/with spaces']);
  });

  it('captures to end of line when no further flag follows', () => {
    const dirs = parseSunBrowserDataDirs(
      '/Applications/SunBrowser.app/Contents/MacOS/SunBrowser --user-data-dir=/plain/dir',
    );
    expect(dirs).toEqual(['/plain/dir']);
  });

  it('returns [] when nothing matches', () => {
    expect(parseSunBrowserDataDirs('nothing here\nat all')).toEqual([]);
  });
});

describe('portFromDevToolsActivePort', () => {
  it('returns the first line: the port', () => {
    expect(portFromDevToolsActivePort('9222\n/devtools/browser/abc-uuid\n')).toBe('9222');
  });

  it('tolerates leading whitespace', () => {
    expect(portFromDevToolsActivePort('  9333\n/devtools/browser/x')).toBe('9333');
  });

  it('handles a port-only file', () => {
    expect(portFromDevToolsActivePort('9450')).toBe('9450');
  });
});

// A fetch impl whose first N calls reject, then succeed with the given body.
function flakyFetch(body: unknown, failures: number): typeof fetch & { calls: number } {
  const f = (async (_url: any, _init?: any) => {
    if (f.calls++ < failures) throw new Error('transient network hiccup');
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch & { calls: number };
  f.calls = 0;
  return f;
}

describe('fetchJsonRetry', () => {
  it('returns the JSON on the first try when the endpoint is healthy', async () => {
    const f = flakyFetch({ Browser: 'SunBrowser/149' }, 0);
    expect(await fetchJsonRetry('http://127.0.0.1:60696/json/version', { fetchImpl: f, retryDelayMs: 1 }))
      .toEqual({ Browser: 'SunBrowser/149' });
    expect(f.calls).toBe(1);
  });

  it('rides out a transient failure and succeeds on a retry', async () => {
    const f = flakyFetch({ Browser: 'SunBrowser/149' }, 1);
    expect(await fetchJsonRetry('http://127.0.0.1:60696/json/version', { fetchImpl: f, retryDelayMs: 1 }))
      .toEqual({ Browser: 'SunBrowser/149' });
    expect(f.calls).toBe(2);
  });

  it('gives up after `attempts` failures and rethrows the last error', async () => {
    const f = flakyFetch({}, 99);
    await expect(fetchJsonRetry('http://127.0.0.1:1/json/version', {
      attempts: 3, fetchImpl: f, retryDelayMs: 1,
    })).rejects.toThrow('transient network hiccup');
    expect(f.calls).toBe(3);
  });

  it('treats a non-JSON body as a failure and retries it', async () => {
    let calls = 0;
    const f = (async () => {
      calls++;
      if (calls === 1) return new Response('<html>bad gateway</html>');
      return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    expect(await fetchJsonRetry('http://127.0.0.1:60696/json/list', { fetchImpl: f, retryDelayMs: 1 }))
      .toEqual({ ok: true });
    expect(calls).toBe(2);
  });
});
