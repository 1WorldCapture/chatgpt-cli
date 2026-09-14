// Tab management over the CDP HTTP endpoints: background tab creation and
// "find or open" attachment to a specific conversation.

import type { CdpTarget } from '../types';

// Find an open chatgpt.com tab already showing this conversation (matched by
// conversation uuid, tolerating /c/<uuid> vs /g/.../c/<uuid> and query params)
// and reuse it; otherwise open the chat in a NEW background tab.
export function makeChatTabMatcher(convId: string | null, path: string): (tabUrl: string) => boolean {
  return (tabUrl) => {
    try {
      const u = new URL(tabUrl);
      if (!/^https?:\/\/chatgpt\.com$/.test(u.origin)) return false;
      if (convId) return u.pathname.endsWith('/c/' + convId);
      return u.pathname === path;
    } catch { return false; }
  };
}

export async function attachToChatTab(port: string | number, path: string): Promise<CdpTarget> {
  const convId = (path.match(/\/c\/([0-9a-f-]{36})/) || [])[1] || null;
  const isChatTab = makeChatTabMatcher(convId, path);
  const found = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as CdpTarget[])
    .find(t => t.type === 'page' && t.webSocketDebuggerUrl && isChatTab(t.url));
  if (found) return found;
  return createTab(port, 'https://chatgpt.com' + (convId ? '/c/' + convId : path));
}

// Create a new tab: prefer a BACKGROUND tab via the browser-level WebSocket so
// the user's active tab is not stolen; fall back to HTTP PUT /json/new.
export async function createTab(port: string | number, url: string): Promise<CdpTarget> {
  try {
    const ver: any = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const ws = new WebSocket(ver.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = () => rej(new Error('browser ws failed'));
    });
    const target = await new Promise<any>((res, rej) => {
      // Clear the timeout on settle: a leftover timer keeps the event loop
      // alive for its full 10s after the target was created.
      let settled = false;
      const timer = setTimeout(() => { if (!settled) rej(new Error('Target.createTarget timed out')); }, 10000);
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id === 1) {
          settled = true;
          clearTimeout(timer);
          m.error ? rej(new Error(m.error.message)) : res(m.result);
        }
      };
      ws.send(JSON.stringify({ id: 1, method: 'Target.createTarget', params: { url, background: true } }));
    });
    ws.close();
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const page = ((await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as CdpTarget[])
        .find(t => (t.id === target.targetId || t.targetId === target.targetId) && t.webSocketDebuggerUrl);
      if (page) return page;
      await new Promise(r => setTimeout(r, 300));
    }
    throw new Error('new tab did not appear in /json/list');
  } catch (e: any) {
    const res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
    if (!res.ok) throw new Error(`failed to create tab (${e.message}; fallback HTTP ${res.status})`);
    return await res.json() as CdpTarget;
  }
}
