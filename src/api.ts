// Agent-facing SEND tools: sendChat / sendProjectChat and the shared send
// flow (typing, completion detection, reply extraction).
//
//   await sendChat(port, text, {chatUrl, timeoutMs, effort})
//                                       -> SEND a message. With chatUrl: append to that
//                                          existing chat (tab found or opened). Without:
//                                          new general chat in a fresh background tab.
//                                          Waits until the reply is detected complete
//                                          (stop button gone + 5s stability) and returns
//                                          { url, status, messages } where messages is the
//                                          latest round [{role, text}]; status is
//                                          'done' | 'timeout' (partial text included).
//                                          NOTE: a >5s mid-generation pause with no stop
//                                          button is indistinguishable from completion at
//                                          the DOM level — this residual is ACCEPTED and
//                                          the tool never self-verifies; if the calling
//                                          agent wants confirmation, it calls getMessages.
//   await sendProjectChat(port, text, {projectId, chatUrl, timeoutMs, effort})
//                                       -> same, but a new chat is created inside projectId
//                                          (g-p-<id>); chatUrl always wins when given.

import { resolvePort } from './discovery';
import { attachToChatTab, createTab } from './cdp/tabs';
import { poll, CdpSession } from './cdp/session';
import { normalizeChatRef } from './refs';
import { COMPOSER_READY, typeTextExpr, SEND_STATE, CLICK_SEND } from './pages/composer';
import { setEffort } from './pages/effort';
import { READ_TURNS, sliceRounds } from './pages/messages';
import { json, sleep } from './util';
import type { ChatMessage, PortSpec, SendOptions, SendProjectOptions, SendResult } from './types';

// Identity of the last rendered turn. ChatGPT VIRTUALIZES the thread: the DOM
// keeps only the most recent ~5 turns, so the turn COUNT never grows on long
// conversations — completion must be detected by the last turn's identity
// (message id) changing to a NEW assistant turn, never by counting.
const LAST_TURN_MARK = `(() => {
  const t = document.querySelectorAll('[data-testid^="conversation-turn-"]');
  const last = t[t.length - 1];
  if (!last) return null;
  return {
    role: last.querySelector('[data-message-author-role]')?.dataset.messageAuthorRole || 'unknown',
    id: last.querySelector('[data-message-id]')?.dataset.messageId || last.dataset.testid,
    len: (last.querySelector('.markdown')?.textContent || last.textContent || '').length,
  };
})()`;

// Completion detection (v4):
// 1. After clicking send, unconditionally wait 15s first — generation goes
//    through noisy phases where the stop button is ABSENT while the reply is
//    far from done (long thinking; web-search with partial text rendered).
// 2. Failure check: if our message was never posted (no NEW turn id at all)
//    and there is no stop button either, the send itself failed.
//    A missing ASSISTANT turn alone is NOT failure — thinking can run 40s+.
// 3. Success: the last turn is a NEW assistant message AND the stop button is
//    gone AND this holds for 5 consecutive reads (guard for the observed
//    mid-generation pause: partial assistant text + no stop button + a
//    multi-second gap before the body streams). Returns 'done' | 'timeout'.
async function waitForReply(s: CdpSession, beforeMark: any, timeoutMs: number): Promise<'done' | 'timeout'> {
  await sleep(15000); // forced quiet period absorbing the noisy early phases
  const deadline = Date.now() + timeoutMs;
  let stable = 0, lastId: string | null = null, lastLen = -1;
  while (Date.now() < deadline) {
    const state = await s.eval(SEND_STATE);
    const mark = await s.eval(LAST_TURN_MARK);
    const posted = !!mark && (!beforeMark || mark.id !== beforeMark.id);
    if (!posted) {
      // our turn is not in the thread yet; a live stop button means it is
      // still being accepted — only (no new turn AND no stop) is a failure
      if (state !== 'streaming') throw new Error('send failed — message was not posted');
    } else if (mark.role === 'assistant' && state !== 'streaming') {
      if (mark.id === lastId && mark.len === lastLen) {
        if (++stable >= 5) return 'done';
      } else { stable = 0; lastId = mark.id; lastLen = mark.len; }
    } else { stable = 0; }
    await sleep(1000);
  }
  return 'timeout';
}

// Core send flow on an attached tab: make the tab visible (ChatGPT throttles
// streaming to a crawl on hidden tabs, defeating every completion signal) ->
// wait composer -> set reasoning effort -> type -> wait send button
// appear+enabled -> click -> (new chats: capture the materialized URL) ->
// wait for the reply to finish -> return url + latest round.
// extra-high/pro replies think + stream for minutes — default timeout is 5 min.
async function sendInTab(
  s: CdpSession,
  text: string,
  { timeoutMs = 300000, isNewChat = false, effort = 'high', expect = null as string | null } = {},
): Promise<SendResult> {
  // Hidden tabs postpone the streamed reply (no stop button, no markdown) for
  // ~minutes, which reads as instant completion and returns an empty answer.
  // Page.bringToFront makes the tab visible even when the OS window is fully
  // occluded (browser-level Target.activateTarget does not).
  try { await s.send('Page.bringToFront'); } catch { /* best effort */ }
  await poll(s, COMPOSER_READY, { timeoutMs: 20000 });
  if (expect) {
    // a deleted conversation silently redirects to a fresh chat — refuse to
    // send into that; only the real target's URL contains `expect`
    try {
      await poll(s, `location.pathname.includes(${json(expect)})`, { timeoutMs: 10000 });
    } catch {
      throw new Error(`conversation not found (deleted?): expected URL to contain "${expect}"`);
    }
  }
  await setEffort(s, effort);
  const beforeMark = await s.eval(LAST_TURN_MARK);

  const typed = await s.eval(typeTextExpr(text));
  if (typed === 'no-composer' || typed === 'insert-failed') {
    // fallback: trusted CDP text insertion at the focused composer
    if (typed === 'insert-failed') {
      await s.eval(`document.querySelector('#prompt-textarea')?.focus(); true`);
      await s.send('Input.insertText', { text });
    } else throw new Error('composer not found');
  }

  await poll(s, `(() => ${SEND_STATE})() === 'ready'`, { timeoutMs: 10000 });
  const clicked = await s.eval(CLICK_SEND);
  if (!clicked) throw new Error('send button not clickable');

  let url: string;
  if (isNewChat) {
    const oldPath = await s.eval('location.pathname');
    // a brand-new chat only materializes as /c/<uuid> (or /g/.../c/<uuid>) after
    // the first message is sent
    await poll(s, `location.pathname !== ${json(oldPath)}`, { timeoutMs: 20000 });
  }
  url = await s.eval('location.href');

  const status = await waitForReply(s, beforeMark, timeoutMs);
  const msgs = (await s.eval(READ_TURNS)) as ChatMessage[];
  return { url, status, messages: sliceRounds(msgs, 1) };
}

// Expectation substring for sendInTab: after attaching, the tab's pathname
// must contain it — a DELETED conversation silently redirects to a new chat,
// which would send our message into the wrong place. Null skips the check.
export function chatExpect(ref: string): string {
  const path = normalizeChatRef(ref);
  const convId = (path.match(/\/c\/([0-9a-f-]{36})/) || [])[1];
  return convId || path;
}

// Agent tool: send a message. chatUrl given -> append to that chat (tab found
// or opened); no chatUrl -> new general chat in a fresh background tab.
export async function sendChat(
  port: PortSpec = null,
  text: string,
  { chatUrl, timeoutMs, effort }: SendOptions = {},
): Promise<SendResult> {
  port = await resolvePort(port);
  let s: CdpSession, isNewChat = false, expect: string | null = null;
  if (chatUrl) {
    const page = await attachToChatTab(port, normalizeChatRef(chatUrl));
    s = new CdpSession(page.webSocketDebuggerUrl!);
    expect = chatExpect(chatUrl);
  } else {
    const page = await createTab(port, 'https://chatgpt.com/');
    s = new CdpSession(page.webSocketDebuggerUrl!);
    isNewChat = true;
  }
  await s.connect();
  try {
    return await sendInTab(s, text, { timeoutMs, isNewChat, effort, expect });
  } finally {
    s.close();
  }
}

// Agent tool: send into a project chat. chatUrl given -> append (project or
// not, the URL decides); else projectId (g-p-<id>) required -> new chat inside
// that project, opened in a fresh background tab.
export async function sendProjectChat(
  port: PortSpec = null,
  text: string,
  { projectId, chatUrl, timeoutMs, effort }: SendProjectOptions = {},
): Promise<SendResult> {
  port = await resolvePort(port);
  let s: CdpSession, isNewChat = false, expect: string | null = null;
  if (chatUrl) {
    const page = await attachToChatTab(port, normalizeChatRef(chatUrl));
    s = new CdpSession(page.webSocketDebuggerUrl!);
    expect = chatExpect(chatUrl);
  } else {
    if (!projectId || !/^g-p-[0-9a-f]+$/.test(projectId)) {
      throw new Error('sendProjectChat needs {chatUrl} or a valid g-p-<id> projectId');
    }
    const page = await createTab(port, 'https://chatgpt.com/g/' + projectId);
    s = new CdpSession(page.webSocketDebuggerUrl!);
    isNewChat = true;
    expect = projectId;
  }
  await s.connect();
  try {
    return await sendInTab(s, text, { timeoutMs, isNewChat, effort, expect });
  } finally {
    s.close();
  }
}
