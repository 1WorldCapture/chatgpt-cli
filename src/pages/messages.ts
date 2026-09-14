// Reading conversation messages: turn extraction from the rendered thread,
// full-thread lazy loading, round slicing, and the atomic getMessages read.

import { resolvePort } from '../discovery';
import { normalizeChatRef } from '../refs';
import { attachToChatTab } from '../cdp/tabs';
import { CdpSession } from '../cdp/session';
import type { ChatMessage, PortSpec } from '../types';

// Read all rendered turns of the current conversation: one [data-testid^=
// "conversation-turn-N"] element per message (N can have gaps from edits/deletes,
// so DOM order is the only valid ordering). User text lives in .whitespace-pre-wrap,
// assistant text in .markdown.
export const READ_TURNS = `(() => {
  const turns = [...document.querySelectorAll('[data-testid^="conversation-turn-"]')];
  // citation pills render the SOURCE SITE NAME ("OpenAI Developers") inline —
  // strip them from a clone so prose extraction stays clean
  const cleanText = (el) => {
    if (!el) return '';
    const clone = el.cloneNode(true);
    clone.querySelectorAll('[data-testid="webpage-citation-pill"]').forEach(e => e.remove());
    return clone.textContent;
  };
  return turns.map(t => {
    const role = t.querySelector('[data-message-author-role]')?.dataset.messageAuthorRole || 'unknown';
    let text = '';
    if (role === 'assistant') {
      text = [...t.querySelectorAll('.markdown')].map(m => cleanText(m).trim()).join('\\n\\n');
    } else {
      text = cleanText(t.querySelector('.whitespace-pre-wrap'))
        ?? cleanText(t.querySelector('[data-message-author-role]')) ?? '';
    }
    if (!text.trim() && t.querySelector('img, canvas')) text = '[image]';
    return { role, text: text.trim() };
  });
})()`;

// Long conversations may lazy-render earlier turns; scrolling <main> to the top
// triggers loading. Loop until the turn count stabilizes, then return to bottom.
async function loadFullThread(s: CdpSession) {
  await s.eval(`(() => {
    const main = document.querySelector('main');
    if (main) main.scrollTo(0, 0);
    return true;
  })()`);
  let prev = -1, stable = 0;
  for (let i = 0; i < 15 && stable < 2; i++) {
    await new Promise(r => setTimeout(r, 900));
    const n = await s.eval(`document.querySelectorAll('[data-testid^="conversation-turn-"]').length`);
    stable = n === prev ? stable + 1 : 0;
    prev = n;
    await s.eval(`(() => { document.querySelector('main')?.scrollTo(0, 0); return true; })()`);
  }
  await s.eval(`(() => {
    const main = document.querySelector('main');
    if (main) main.scrollTo(0, main.scrollHeight);
  })()`);
}

// rounds slicing shared by getMessages and the send tools: k>=1 keeps the last
// k user-anchored rounds, 0 -> [], negative -> everything.
export function sliceRounds(msgs: ChatMessage[], rounds: number): ChatMessage[] {
  if (rounds < 0) return msgs;
  if (rounds === 0) return [];
  const userIdx = msgs.map((m, i) => (m.role === 'user' ? i : -1)).filter(i => i >= 0);
  if (!userIdx.length) return [];
  return msgs.slice(userIdx[Math.max(0, userIdx.length - rounds)]);
}

// Atomic read of a chat's messages: the caller passes the chat reference; this
// function never assumes the currently-active page belongs to that chat.
// A "round" starts at a user turn: rounds=1 (default) returns the latest
// user+assistant exchange, rounds=k the last k exchanges, rounds=-1 everything.
export async function getMessages(port: PortSpec = null, ref: string, rounds = 1): Promise<ChatMessage[]> {
  port = await resolvePort(port);
  const path = normalizeChatRef(ref);
  const page = await attachToChatTab(port, path);
  const s = new CdpSession(page.webSocketDebuggerUrl!);
  await s.connect();
  try {
    // wait for the conversation to render (a fresh tab loads from scratch)
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (await s.eval(`document.querySelectorAll('[data-testid^="conversation-turn-"]').length`) > 0) break;
      await new Promise(r => setTimeout(r, 500));
    }
    if (rounds === -1) await loadFullThread(s);
    const msgs = (await s.eval(READ_TURNS)) as ChatMessage[];
    if (!msgs.length) throw new Error(`no conversation turns found at ${path}`);
    return sliceRounds(msgs, rounds);
  } finally {
    s.close();
  }
}
