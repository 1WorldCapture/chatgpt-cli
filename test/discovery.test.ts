// Unit tests for SunBrowser CDP port discovery parsing (pure logic, no browser).
import { describe, expect, it } from 'bun:test';
import { parseSunBrowserDataDirs, portFromDevToolsActivePort } from '../src/discovery';

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
