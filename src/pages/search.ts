// Sidebar search: open the modal, type a query, read results, close.
//
// INVARIANT: Search modal: input #global-search-modal-input, results live
// inside [data-testid="global-search-results-scroller"] as <a> to /c/... or /g/....
//
// Single-responsibility SEARCH ONLY: type the query in the sidebar search,
// return matched chats as [{title, url}], then close the modal. Nothing is
// opened or clicked — the caller opens a chat with openChat().

import { poll, CdpSession } from '../cdp/session';
import { json } from '../util';
import type { SearchHit } from '../types';

const MODAL_CLOSED = `(() => {
  const i = document.querySelector('#global-search-modal-input');
  return !i || i.offsetParent === null;
})()`;

// Shared: open the sidebar search modal (skip the click if already open) and type a query.
async function openSearchAndType(s: CdpSession, query: string) {
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
function readSearchResultsExpr(limit: number) {
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

async function closeSearch(s: CdpSession) {
  await s.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); 'esc'`);
  await poll(s, MODAL_CLOSED, { timeoutMs: 5000 });
}

export async function searchChat(
  s: CdpSession,
  query: string,
  { limit = 20, timeoutMs = 12000 }: { limit?: number; timeoutMs?: number } = {},
): Promise<SearchHit[]> {
  await openSearchAndType(s, query);
  const deadline = Date.now() + timeoutMs;
  let results: SearchHit[] = [];
  while (Date.now() < deadline) {
    results = await s.eval(readSearchResultsExpr(limit));
    if (results.length) break;
    await new Promise(r => setTimeout(r, 500));
  }
  await closeSearch(s);
  if (!results.length) throw new Error(`no search results for: ${query}`);
  return results;
}
