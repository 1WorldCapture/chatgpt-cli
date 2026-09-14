// CDP connection: find the first chatgpt.com page target and bind a session
// to it. This is the session the CLI's per-tab commands operate on.

import { resolvePort } from '../discovery';
import type { CdpTarget, PortSpec } from '../types';
import { CdpSession } from './session';

export async function findChatGPTPage(port: string | number): Promise<CdpTarget> {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  const targets = (await res.json()) as CdpTarget[];
  const page = targets.find(t => t.type === 'page' && /^https?:\/\/chatgpt\.com\//.test(t.url));
  if (!page) throw new Error('No chatgpt.com page target found — open the ChatGPT tab first.');
  return page;
}

// Bind a session to the first chatgpt.com tab.
export async function connect(port: PortSpec = null): Promise<CdpSession> {
  const p = await resolvePort(port);
  const page = await findChatGPTPage(p);
  const s = new CdpSession(page.webSocketDebuggerUrl!);
  await s.connect();
  return s;
}
