// Composer primitives: readiness probe, typing, and send/stop button state.
//
// INVARIANT: The composer (#prompt-textarea) is a <textarea> on "/" but a
// contenteditable <div> on project pages — check both when typing.

import { json } from '../util';

// Composer exists and is visible (textarea on "/", contenteditable div on project pages).
export const COMPOSER_READY = `(() => {
  const c = document.querySelector('#prompt-textarea');
  return !!(c && c.offsetParent !== null);
})()`;

// Type text into the composer as user-level input, REPLACING whatever is there
// (the home composer may restore a saved draft, which must not leak into sends).
// The composer is a <textarea> on "/" but a contenteditable <div> everywhere
// else; execCommand('insertText') makes ProseMirror register the text through
// its own input handlers.
export function typeTextExpr(text: string): string {
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
export const SEND_STATE = `(() => {
  const vis = el => !!(el && el.offsetParent !== null);
  const stop = document.querySelector('button[data-testid="stop-button"], button[aria-label^="Stop"]');
  if (vis(stop)) return 'streaming';
  const send = document.querySelector('button[data-testid="send-button"], button[aria-label^="Send prompt"], button[aria-label="Send message"]');
  if (vis(send)) return send.disabled ? 'idle' : 'ready';
  return 'none';
})()`;

export const CLICK_SEND = `(() => {
  const b = document.querySelector('button[data-testid="send-button"], button[aria-label^="Send prompt"], button[aria-label="Send message"]');
  if (!b || b.disabled || b.offsetParent === null) return false;
  b.click();
  return true;
})()`;
