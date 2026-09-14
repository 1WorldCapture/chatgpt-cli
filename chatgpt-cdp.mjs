#!/usr/bin/env node
// ChatGPT web-UI driver via CDP — pure page simulation only (clicks / SPA navigation),
// no backend-api or /api calls from our side.
//
// Library API — agent-facing tools (atomic, no implicit page state):
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
//   await getMessages(port, ref, rounds) -> ATOMIC read: ref is a chat URL/path/uuid. Finds the
//                                          tab already showing that chat and reuses it, or
//                                          opens the chat in a NEW background tab, then reads
//                                          messages. rounds=1 (default) latest exchange,
//                                          -1 all. Returns [{role, text}] — never assumes
//                                          anything about the currently-active page
//
// Internal building blocks (NOT agent tools — they act on the passed session's page):
//   await connect(port?)                 -> session bound to the first chatgpt.com tab
//   await newChat(s)                     -> fresh NON-PROJECT chat composer on "/"
//   await newProjectChat(s, nameOrId)    -> fresh composer inside a project
//   await listProjects(s)                -> sidebar projects [{name, id|null}]
//   await openChat(s, ref)               -> navigate this tab to an existing chat
//   await searchChat(s, query, {limit})  -> SEARCH ONLY, never navigates: returns matched
//                                          chats as [{title, url}] and closes the modal
//
// CLI:
//   node chatgpt-cdp.mjs ports                       # list AdsPower SunBrowser CDP ports
//   node chatgpt-cdp.mjs url
//   node chatgpt-cdp.mjs list-projects
//   node chatgpt-cdp.mjs new-chat
//   node chatgpt-cdp.mjs new-project-chat "Splats" | g-p-6aa60d...
//   node chatgpt-cdp.mjs open-chat "https://chatgpt.com/c/<uuid>" | "/c/<uuid>" | "<uuid>"
//   node chatgpt-cdp.mjs search-chat "钢笔" [limit]
//   node chatgpt-cdp.mjs messages <url|path|uuid> [rounds]   # rounds default 1, -1 = all
//   node chatgpt-cdp.mjs send-chat "<text>" [chatUrl]         # no url = new general chat
//   node chatgpt-cdp.mjs send-project-chat "<text>" <projectId|chatUrl>
//   node chatgpt-cdp.mjs enter-project "Splats" | g-p-...
//
// Env: CDP_PORT — optional override; WITHOUT it the port is auto-discovered
// from the running AdsPower SunBrowser (its CDP port is random per launch and
// recorded in <user-data-dir>/DevToolsActivePort). Requires Node >= 22.
//
// Notes:
// - Project URL is /g/<project-id>-<slug>/project; the id is g-p-<hex>, the rest
//   is a cosmetic slug. Navigating to the bare /g/<id> redirects to the full URL,
//   so storing the id alone is enough.
// - The composer (#prompt-textarea) is a <textarea> on "/" but a contenteditable
//   <div> on project pages — check both when typing.
// - Search modal: input #global-search-modal-input, results live inside
//   [data-testid="global-search-results-scroller"] as <a> to /c/... or /g/....

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// AdsPower launches SunBrowser with --remote-debugging-port=0 (random port).
// Discover each running instance: the MAIN process carries --user-data-dir;
// the first line of <user-data-dir>/DevToolsActivePort is the actual port.
export async function discoverAdspowerCdp() {
  let ps;
  try {
    ps = execSync('ps -axo command=', { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  } catch { return []; }
  const dirs = new Set();
  for (const line of ps.split('\n')) {
    // main process only: its executable is ".../SunBrowser.app/Contents/MacOS/
    // SunBrowser" — Helper processes run "SunBrowser Helper.app" (note the
    // space), which must NOT match. The user-data-dir path contains spaces
    // ("Application Support"), so capture lazily up to the next --flag.
    if (!/\/SunBrowser\.app\/Contents\/MacOS\/SunBrowser /.test(line)) continue;
    const m = line.match(/--user-data-dir=(.*?)(?=\s--|$)/);
    if (m) dirs.add(m[1]);
  }
  const found = [];
  for (const dir of dirs) {
    let port;
    try {
      port = readFileSync(dir + '/DevToolsActivePort', 'utf8').trim().split('\n')[0];
    } catch { continue; }
    try {
      const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`,
        { signal: AbortSignal.timeout(2000) })).json();
      let hasChatGptTab = false;
      try {
        const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`,
          { signal: AbortSignal.timeout(2000) })).json();
        hasChatGptTab = tabs.some(t => t.type === 'page' && /^https?:\/\/chatgpt\.com\//.test(t.url));
      } catch { /* list optional */ }
      found.push({ envId: dir.split('/').pop(), port: Number(port), browser: ver.Browser, hasChatGptTab });
    } catch { /* DevToolsActivePort stale — endpoint not up */ }
  }
  return found;
}

// Resolve the port to use: explicit arg > CDP_PORT env > auto-discovery
// (memoized). With several SunBrowser instances, prefer one with an open
// chatgpt.com tab, else the first found.
let resolvedPort = null;
async function resolvePort(explicit) {
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

async function findChatGPTPage(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  const targets = await res.json();
  const page = targets.find(t => t.type === 'page' && /^https?:\/\/chatgpt\.com\//.test(t.url));
  if (!page) throw new Error('No chatgpt.com page target found — open the ChatGPT tab first.');
  return page;
}

class CdpSession {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.ws = null; this.id = 0; this.pending = new Map(); }
  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error('WebSocket connect failed: ' + this.wsUrl));
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id && this.pending.has(msg.id)) {
          this.pending.get(msg.id)(msg);
          this.pending.delete(msg.id);
        }
      };
    });
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(method + ' timed out')); }
      }, 15000);
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true, userGesture: true,
    });
    if (r.result?.exceptionDetails) {
      throw new Error('page exception: ' + (r.result.exceptionDetails.exception?.description || 'unknown'));
    }
    return r.result?.result?.value;
  }
  close() { this.ws?.close(); }
}

export async function connect(port = null) {
  const p = await resolvePort(port);
  const page = await findChatGPTPage(p);
  const s = new CdpSession(page.webSocketDebuggerUrl);
  await s.connect();
  return s;
}

async function poll(session, condExpr, { timeoutMs = 12000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await session.eval(`Boolean(${condExpr})`)) return true;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error('timeout waiting for: ' + condExpr);
}

const json = (v) => JSON.stringify(v);

// Composer exists and is visible (textarea on "/", contenteditable div on project pages).
const COMPOSER_READY = `(() => {
  const c = document.querySelector('#prompt-textarea');
  return !!(c && c.offsetParent !== null);
})()`;

const MODAL_CLOSED = `(() => {
  const i = document.querySelector('#global-search-modal-input');
  return !i || i.offsetParent === null;
})()`;

// Sidebar "Projects" section: each li carries an options button whose aria-label
// ends with the project name; project id is only in-DOM when the project has chats.
export async function listProjects(s) {
  return s.eval(`(() => {
    const rows = [...document.querySelectorAll('button[aria-label^="Open project options for"]')];
    return rows.map(b => {
      const li = b.closest('li');
      const anchor = li ? li.querySelector('a[href^="/g/"]') : null;
      const m = anchor ? anchor.getAttribute('href').match(/g-p-[0-9a-f]+/) : null;
      return {
        name: b.getAttribute('aria-label').replace('Open project options for', '').trim(),
        id: m ? m[0] : null,
      };
    });
  })()`);
}

// Enter a project home page by display name (sidebar click) or by project id
// (bare /g/<id> URL, which the app redirects to the full project URL).
export async function enterProject(s, nameOrId) {
  if (/^g-p-[0-9a-f]+$/.test(nameOrId)) {
    await s.eval(`location.assign(${json('/g/' + nameOrId)}); 'navigating'`);
    await poll(s, `location.pathname.includes(${json(nameOrId)}) && ${COMPOSER_READY}`);
  } else {
    const clicked = await s.eval(`(() => {
      const rows = [...document.querySelectorAll('button[aria-label^="Open project options for"]')];
      const btn = rows.find(b =>
        b.getAttribute('aria-label').replace('Open project options for', '').trim() === ${json(nameOrId)});
      if (!btn) return false;
      btn.closest('li')?.querySelector('button[aria-label="Open project home"]')?.click();
      return true;
    })()`);
    if (!clicked) throw new Error(`project not found in sidebar: ${nameOrId}`);
    await poll(s, `/g-p-[0-9a-f]+/.test(location.pathname) && ${COMPOSER_READY}`);
  }
  return s.eval(`({
    url: location.href,
    projectId: (location.pathname.match(/g-p-[0-9a-f]+/) || [])[0] || null,
    projectName: document.querySelector('h1')?.textContent.trim() || null,
  })`);
}

// New NON-PROJECT chat: click the visible sidebar "New chat" link (SPA route);
// if the sidebar is collapsed, fall back to a plain navigation to "/".
export async function newChat(s) {
  const clicked = await s.eval(`(() => {
    const btn = [...document.querySelectorAll('a[data-testid="create-new-chat-button"]')]
      .find(el => el.offsetParent !== null);
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  if (!clicked) await s.eval(`location.assign('/'); 'navigating'`);
  await poll(s, `location.pathname === '/' && ${COMPOSER_READY}`);
  return s.eval(`({ url: location.href })`);
}

// New PROJECT chat: enter the project page first, its composer (aria-label
// "New chat in <project>") starts a chat scoped to that project.
export async function newProjectChat(s, nameOrId) {
  const entered = await enterProject(s, nameOrId);
  return { ...entered, composer: 'ready' };
}

// Normalize a chat reference (full URL / URL path / bare uuid) to a canonical path.
function normalizeChatRef(ref) {
  let path;
  if (/^https?:\/\//.test(ref)) path = new URL(ref).pathname;
  else if (ref.startsWith('/')) path = ref;
  else if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(ref)) path = '/c/' + ref;
  else throw new Error(`unrecognized chat reference: ${ref} (want URL, /c/<uuid>, or <uuid>)`);
  return path.split('?')[0];
}

// Open an existing chat by full URL, URL path, or bare conversation uuid.
export async function openChat(s, ref) {
  const path = normalizeChatRef(ref);
  await s.eval(`location.assign(${json(path)}); 'navigating'`);
  await poll(s, `location.pathname === ${json(path)} && ${COMPOSER_READY}`);
  return s.eval(`({ url: location.href })`);
}

// Shared: open the sidebar search modal (skip the click if already open) and type a query.
async function openSearchAndType(s, query) {
  const alreadyOpen = await s.eval(`(() => {
    const i = document.querySelector('#global-search-modal-input');
    return !!(i && i.offsetParent !== null);
  })()`);
  if (!alreadyOpen) {
    const opened = await s.eval(`(() => {
      const btn = [...document.querySelectorAll('button[aria-label="Search"]')]
        .find(el => el.offsetParent !== null);
      if (!btn) return false;
      btn.click();
      return true;
    })()`);
    if (!opened) throw new Error('search button not found (sidebar collapsed?)');
    await poll(s, `(() => {
      const i = document.querySelector('#global-search-modal-input');
      return !!(i && i.offsetParent !== null);
    })()`);
  }
  await s.eval(`(() => {
    const input = document.querySelector('#global-search-modal-input');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${json(query)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
}

// Structured read of the current search results (no clicking). Each result
// anchor holds a title node ([class*="resultTitle"]) and an href to the chat.
function readSearchResultsExpr(limit) {
  return `(() => {
    const scroller = document.querySelector('[data-testid="global-search-results-scroller"]');
    if (!scroller) return [];
    const visible = el => !!(el && el.offsetParent !== null);
    return [...scroller.querySelectorAll('a[href*="/c/"], a[href*="/g/"]')]
      .filter(visible).slice(0, ${limit}).map(a => ({
        title: (a.querySelector('[class*="resultTitle"]')?.textContent
          || a.textContent.trim().split('…')[0] || '').trim(),
        url: location.origin + new URL(a.getAttribute('href'), location.origin).pathname,
      }));
  })()`;
}

async function closeSearch(s) {
  await s.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); 'esc'`);
  await poll(s, MODAL_CLOSED, { timeoutMs: 5000 });
}

// Single-responsibility SEARCH ONLY: type the query in the sidebar search,
// return matched chats as [{title, url}], then close the modal. Nothing is
// opened or clicked — the caller opens a chat with openChat().
export async function searchChat(s, query, { limit = 20, timeoutMs = 12000 } = {}) {
  await openSearchAndType(s, query);
  const deadline = Date.now() + timeoutMs;
  let results = [];
  while (Date.now() < deadline) {
    results = await s.eval(readSearchResultsExpr(limit));
    if (results.length) break;
    await new Promise(r => setTimeout(r, 500));
  }
  await closeSearch(s);
  if (!results.length) throw new Error(`no search results for: ${query}`);
  return results;
}

// Read all rendered turns of the current conversation: one [data-testid^=
// "conversation-turn-N"] element per message (N can have gaps from edits/deletes,
// so DOM order is the only valid ordering). User text lives in .whitespace-pre-wrap,
// assistant text in .markdown.
const READ_TURNS = `(() => {
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
async function loadFullThread(s) {
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
    return true;
  })()`);
}

// Find an open chatgpt.com tab already showing this conversation (matched by
// conversation uuid, tolerating /c/<uuid> vs /g/.../c/<uuid> and query params)
// and reuse it; otherwise open the chat in a NEW background tab.
async function attachToChatTab(port, path) {
  const convId = (path.match(/\/c\/([0-9a-f-]{36})/) || [])[1] || null;
  const isChatTab = (tabUrl) => {
    try {
      const u = new URL(tabUrl);
      if (!/^https?:\/\/chatgpt\.com$/.test(u.origin)) return false;
      if (convId) return u.pathname.endsWith('/c/' + convId);
      return u.pathname === path;
    } catch { return false; }
  };
  const found = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json())
    .find(t => t.type === 'page' && t.webSocketDebuggerUrl && isChatTab(t.url));
  if (found) return found;
  return createTab(port, 'https://chatgpt.com' + (convId ? '/c/' + convId : path));
}

// Atomic read of a chat's messages: the caller passes the chat reference; this
// function never assumes the currently-active page belongs to that chat.
// A "round" starts at a user turn: rounds=1 (default) returns the latest
// user+assistant exchange, rounds=k the last k exchanges, rounds=-1 everything.
export async function getMessages(port = null, ref, rounds = 1) {
  port = await resolvePort(port);
  const path = normalizeChatRef(ref);
  const page = await attachToChatTab(port, path);
  const s = new CdpSession(page.webSocketDebuggerUrl);
  await s.connect();
  try {
    // wait for the conversation to render (a fresh tab loads from scratch)
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (await s.eval(`document.querySelectorAll('[data-testid^="conversation-turn-"]').length`) > 0) break;
      await new Promise(r => setTimeout(r, 500));
    }
    if (rounds === -1) await loadFullThread(s);
    const msgs = await s.eval(READ_TURNS);
    if (!msgs.length) throw new Error(`no conversation turns found at ${path}`);
    return sliceRounds(msgs, rounds);
  } finally {
    s.close();
  }
}

// rounds slicing shared by getMessages and the send tools: k>=1 keeps the last
// k user-anchored rounds, 0 -> [], negative -> everything.
function sliceRounds(msgs, rounds) {
  if (rounds < 0) return msgs;
  if (rounds === 0) return [];
  const userIdx = msgs.map((m, i) => (m.role === 'user' ? i : -1)).filter(i => i >= 0);
  if (!userIdx.length) return [];
  return msgs.slice(userIdx[Math.max(0, userIdx.length - rounds)]);
}

// Create a new tab: prefer a BACKGROUND tab via the browser-level WebSocket so
// the user's active tab is not stolen; fall back to HTTP PUT /json/new.
async function createTab(port, url) {
  try {
    const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const ws = new WebSocket(ver.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = () => rej(new Error('browser ws failed'));
    });
    const target = await new Promise((res, rej) => {
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id === 1) m.error ? rej(new Error(m.error.message)) : res(m.result);
      };
      ws.send(JSON.stringify({ id: 1, method: 'Target.createTarget', params: { url, background: true } }));
      setTimeout(() => rej(new Error('Target.createTarget timed out')), 10000);
    });
    ws.close();
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json())
        .find(t => (t.id === target.targetId || t.targetId === target.targetId) && t.webSocketDebuggerUrl);
      if (page) return page;
      await new Promise(r => setTimeout(r, 300));
    }
    throw new Error('new tab did not appear in /json/list');
  } catch (e) {
    const res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
    if (!res.ok) throw new Error(`failed to create tab (${e.message}; fallback HTTP ${res.status})`);
    return await res.json();
  }
}

// ---------------------------------------------------------------------------
// Reasoning effort
// ---------------------------------------------------------------------------
const EFFORTS = ['instant', 'medium', 'high', 'extra high', 'pro']; // slider 0..4

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// The effort control is a composer pill whose TEXT is the current value. It
// renders slightly AFTER the composer on fresh tabs (race), and lives inside
// the composer form (fall back to <main>); it always carries aria-haspopup.
const EFFORT_CHIP = `(() => {
  const shown = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const isValue = b => /^(instant|medium|high|extra high|pro)$/i.test((b.textContent || '').trim())
    && b.getAttribute('aria-haspopup') === 'menu';
  const c = document.querySelector('#prompt-textarea');
  const scopes = [c?.closest('form'), document.querySelector('main'), document];
  for (const sc of scopes) {
    if (!sc) continue;
    const chip = [...sc.querySelectorAll('button')].filter(shown).find(isValue);
    if (chip) {
      const r = chip.getBoundingClientRect();
      return { text: chip.textContent.trim().toLowerCase(),
               cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2) };
    }
  }
  return null;
})()`;

const EFFORT_GEOM = `(() => {
  const s = document.querySelector('[role="slider"]');
  if (!s) return null;
  const thumb = s.getBoundingClientRect();
  // the track is the nearest ancestor wider than the thumb
  let tr = null, el = s.parentElement;
  for (let i = 0; i < 6 && el; i++) {
    const r = el.getBoundingClientRect();
    if (r.width > thumb.width + 10) { tr = r; break; }
    el = el.parentElement;
  }
  return { now: Number(s.getAttribute('aria-valuenow')),
           min: Number(s.getAttribute('aria-valuemin') || 0),
           max: Number(s.getAttribute('aria-valuemax') || 4),
           thumb: [thumb.x, thumb.y, thumb.width, thumb.height].map(Math.round),
           track: tr ? [tr.x, tr.y, tr.width, tr.height].map(Math.round) : null,
           visible: thumb.width > 0 && thumb.height > 0 && !!tr };
})()`;

// Synthesized el.click() opens the menu but it self-closes on focus loss, so
// the popup must be driven with trusted CDP input events. Note: trusted ARROW
// KEYS are not processed by this slider on background tabs — the only working
// mechanism is a trusted pointer DRAG of the thumb to the target x position.
async function trustedClick(s, x, y) {
  await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', pointerType: 'mouse' });
  await sleep(120);
  await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, pointerType: 'mouse' });
}

async function trustedKey(s, key, vk) {
  await s.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: vk });
  await s.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: vk });
}

// Bring this session's tab to the foreground (browser-level). Used only as a
// last resort: some popups are unstable on background tabs.
async function activateTab(s) {
  const m = s.wsUrl.match(/^ws:\/\/([^/]+)\/devtools\/page\/([0-9A-Fa-f]+)/);
  if (!m) return;
  try {
    const ver = await (await fetch(`http://${m[1]}/json/version`)).json();
    const ws = new WebSocket(ver.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('browser ws fail')); });
    ws.send(JSON.stringify({ id: 1, method: 'Target.activateTarget', params: { targetId: m[2] } }));
    await sleep(400);
    ws.close();
  } catch { /* best effort */ }
}

async function trustedDrag(s, fromX, toX, y) {
  const steps = 8;
  await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(fromX), y: Math.round(y), button: 'none', pointerType: 'mouse' });
  await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(fromX), y: Math.round(y), button: 'left', clickCount: 1, pointerType: 'mouse' });
  for (let i = 1; i <= steps; i++) {
    const x = Math.round(fromX + ((toX - fromX) * i) / steps);
    await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y: Math.round(y), button: 'left', pointerType: 'mouse' });
    await sleep(30);
  }
  await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(toX), y: Math.round(y), button: 'left', clickCount: 1, pointerType: 'mouse' });
}

// Set the composer's reasoning effort (instant|medium|high|extra high|pro).
// Opens the slider popup with a trusted click, DRAGS the thumb to the target
// step (aria-valuenow 0..4), verifies the snap, closes with Escape, re-checks
// the chip text.
export async function setEffort(s, effort) {
  const target = String(effort).trim().toLowerCase();
  const ti = EFFORTS.indexOf(target);
  if (ti < 0) throw new Error(`invalid effort "${effort}" — want one of: ${EFFORTS.join(', ')}`);

  // the pill can lag behind composer readiness on fresh tabs — poll briefly
  const chipDeadline = Date.now() + 5000;
  let chip;
  while (Date.now() < chipDeadline) {
    chip = await s.eval(EFFORT_CHIP);
    if (chip) break;
    await sleep(300);
  }
  if (!chip) throw new Error('effort chip not found in composer');
  if (chip.text === target) return { effort: target, changed: false };

  // open the popup. On background tabs it can flash-close when no further
  // input follows the click, so: hold it open with an inert key press, poll
  // fast, and as a last resort bring the tab to the foreground (popups are
  // stable when the tab is active).
  let geom;
  for (let attempt = 0; attempt < 3 && !geom?.visible; attempt++) {
    const c = await s.eval(EFFORT_CHIP);
    if (!c) throw new Error('effort chip disappeared');
    if (attempt === 2) await activateTab(s);
    await trustedClick(s, c.cx, c.cy);
    await trustedKey(s, 'Shift', 16); // keep-alive: input right after opening
    const dl = Date.now() + 2000;
    while (Date.now() < dl) {
      geom = await s.eval(EFFORT_GEOM);
      if (geom?.visible) break;
      await sleep(60);
    }
  }
  if (!geom?.visible) throw new Error('effort slider popup did not open');

  const fromX = geom.thumb[0] + geom.thumb[2] / 2;
  const toX = geom.track[0] + (ti / (geom.max - geom.min)) * geom.track[2];
  await trustedDrag(s, fromX, toX, geom.thumb[1] + geom.thumb[3] / 2);
  await sleep(350);

  const after = await s.eval(EFFORT_GEOM);
  await trustedKey(s, 'Escape', 27);
  if (!after || after.now !== ti) {
    throw new Error(`effort drag failed (slider at ${after?.now}, want ${ti})`);
  }
  const chip2 = await s.eval(EFFORT_CHIP);
  return { effort: chip2?.text || target, changed: true };
}

// ---------------------------------------------------------------------------
// Send tools
// ---------------------------------------------------------------------------
// Type text into the composer as user-level input, REPLACING whatever is there
// (the home composer may restore a saved draft, which must not leak into sends).
// The composer is a <textarea> on "/" but a contenteditable <div> everywhere
// else; execCommand('insertText') makes ProseMirror register the text through
// its own input handlers.
function typeTextExpr(text) {
  return `(() => {
    const c = document.querySelector('#prompt-textarea');
    if (!c) return 'no-composer';
    c.focus();
    if (c.tagName === 'TEXTAREA') {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(c, '');
      c.dispatchEvent(new Event('input', { bubbles: true }));
      setter.call(c, ${json(text)});
      c.dispatchEvent(new Event('input', { bubbles: true }));
      return 'textarea';
    }
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(c);
    sel.removeAllRanges();
    sel.addRange(range);
    return document.execCommand('insertText', false, ${json(text)}) ? 'contenteditable' : 'insert-failed';
  })()`;
}

// The send button only exists once text is registered; while the assistant is
// streaming it is replaced by a stop button (hover: "stop answering").
const SEND_STATE = `(() => {
  const vis = el => !!(el && el.offsetParent !== null);
  const stop = document.querySelector('button[data-testid="stop-button"], button[aria-label^="Stop"]');
  if (vis(stop)) return 'streaming';
  const send = document.querySelector('button[data-testid="send-button"], button[aria-label^="Send prompt"], button[aria-label="Send message"]');
  if (vis(send)) return send.disabled ? 'idle' : 'ready';
  return 'none';
})()`;

const CLICK_SEND = `(() => {
  const b = document.querySelector('button[data-testid="send-button"], button[aria-label^="Send prompt"], button[aria-label="Send message"]');
  if (!b || b.disabled || b.offsetParent === null) return false;
  b.click();
  return true;
})()`;

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
async function waitForReply(s, beforeMark, timeoutMs) {
  await sleep(15000); // forced quiet period absorbing the noisy early phases
  const deadline = Date.now() + timeoutMs;
  let stable = 0, lastId = null, lastLen = -1;
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

// Core send flow on an attached tab: wait composer -> set reasoning effort ->
// type -> wait send button appear+enabled -> click -> (new chats: capture the
// materialized URL) -> wait for the reply to finish -> return url + latest round.
// extra-high/pro replies think + stream for minutes — default timeout is 5 min.
async function sendInTab(s, text, { timeoutMs = 300000, isNewChat = false, effort = 'high', expect = null } = {}) {
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

  let url;
  if (isNewChat) {
    const oldPath = await s.eval('location.pathname');
    // a brand-new chat only materializes as /c/<uuid> (or /g/.../c/<uuid>) after
    // the first message is sent
    await poll(s, `location.pathname !== ${json(oldPath)}`, { timeoutMs: 20000 });
  }
  url = await s.eval('location.href');

  const status = await waitForReply(s, beforeMark, timeoutMs);
  const msgs = await s.eval(READ_TURNS);
  return { url, status, messages: sliceRounds(msgs, 1) };
}

// Expectation substring for sendInTab: after attaching, the tab's pathname
// must contain it — a DELETED conversation silently redirects to a new chat,
// which would send our message into the wrong place. Null skips the check.
function chatExpect(ref) {
  const path = normalizeChatRef(ref);
  const convId = (path.match(/\/c\/([0-9a-f-]{36})/) || [])[1];
  return convId || path;
}

// Agent tool: send a message. chatUrl given -> append to that chat (tab found
// or opened); no chatUrl -> new general chat in a fresh background tab.
export async function sendChat(port = null, text, { chatUrl, timeoutMs, effort } = {}) {
  port = await resolvePort(port);
  let s, isNewChat = false, expect = null;
  if (chatUrl) {
    const page = await attachToChatTab(port, normalizeChatRef(chatUrl));
    s = new CdpSession(page.webSocketDebuggerUrl);
    expect = chatExpect(chatUrl);
  } else {
    const page = await createTab(port, 'https://chatgpt.com/');
    s = new CdpSession(page.webSocketDebuggerUrl);
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
export async function sendProjectChat(port = null, text, { projectId, chatUrl, timeoutMs, effort } = {}) {
  port = await resolvePort(port);
  let s, isNewChat = false, expect = null;
  if (chatUrl) {
    const page = await attachToChatTab(port, normalizeChatRef(chatUrl));
    s = new CdpSession(page.webSocketDebuggerUrl);
    expect = chatExpect(chatUrl);
  } else {
    if (!projectId || !/^g-p-[0-9a-f]+$/.test(projectId)) {
      throw new Error('sendProjectChat needs {chatUrl} or a valid g-p-<id> projectId');
    }
    const page = await createTab(port, 'https://chatgpt.com/g/' + projectId);
    s = new CdpSession(page.webSocketDebuggerUrl);
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

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const commands = {
  url: (s) => s.eval('location.href'),
  'list-projects': listProjects,
  'enter-project': enterProject,
  'new-chat': newChat,
  'new-project-chat': newProjectChat,
  'open-chat': openChat,
  'search-chat': (s, query, limit) => searchChat(s, query, limit ? { limit: +limit } : {}),
};
// getMessages and the send tools manage their own tabs, so they take the port
// instead of a session.
const portCommands = {
  'ports': async () => discoverAdspowerCdp(),
  'messages': (args) => getMessages(null, args[0], args[1] === undefined ? 1 : +args[1]),
  'send-chat': ([text, chatUrl, effort]) => sendChat(null, text, { chatUrl, effort }),
  'send-project-chat': ([text, ref, effort]) => (/^g-p-[0-9a-f]+$/.test(ref)
    ? sendProjectChat(null, text, { projectId: ref, effort })
    : sendProjectChat(null, text, { chatUrl: ref, effort })),
};

if (process.argv[1] && import.meta.url === 'file://' + process.argv[1]) {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || (!commands[cmd] && !portCommands[cmd])) {
    console.error('Commands: ' + [...Object.keys(commands), ...Object.keys(portCommands)].join(', '));
    process.exit(1);
  }
  let out;
  if (portCommands[cmd]) {
    out = await portCommands[cmd](args);
  } else {
    const s = await connect();
    try {
      out = await commands[cmd](s, ...args);
    } finally {
      s.close();
    }
  }
  console.log(JSON.stringify(out, null, 2));
}
