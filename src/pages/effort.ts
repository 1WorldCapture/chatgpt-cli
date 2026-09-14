// Reasoning-effort control (instant|medium|high|extra high|pro).
//
// The effort control is a composer pill whose TEXT is the current value. It
// renders slightly AFTER the composer on fresh tabs (race), and lives inside
// the composer form (fall back to <main>); it always carries aria-haspopup.
//
// INVARIANT: the popup only OPENS on a tab the browser reports visible — on
// macOS visibility is a window property, and a fully occluded window leaves
// every tab visibilityState "hidden" where the popup ignores clicks. Only
// page-level Page.bringToFront restores it (it also raises the window);
// browser-level Target.activateTarget does not.
//
// Synthesized el.click() opens the menu but it self-closes on focus loss, so
// the popup must be driven with trusted CDP input events. Note: trusted ARROW
// KEYS are not processed by this slider on background tabs — the only working
// mechanism is a trusted pointer DRAG of the thumb to the target x position.

import { CdpSession } from '../cdp/session';
import { sleep } from '../util';
import type { EffortResult } from '../types';

export const EFFORTS = ['instant', 'medium', 'high', 'extra high', 'pro']; // slider 0..4

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

async function trustedClick(s: CdpSession, x: number, y: number) {
  await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', pointerType: 'mouse' });
  await sleep(120);
  await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, pointerType: 'mouse' });
}

async function trustedKey(s: CdpSession, key: string, vk: number) {
  await s.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: vk });
  await s.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: vk });
}

// Make this session's tab visible. Used only as a last resort: the popup
// only opens on a tab the browser reports visible, and Page.bringToFront is
// the only mechanism that restores visibility even when the OS window is
// fully occluded (browser-level Target.activateTarget is not).
async function activateTab(s: CdpSession) {
  try {
    await s.send('Page.bringToFront');
    await sleep(250); // let visibilityState flip before the next trusted click
  } catch { /* best effort */ }
}

async function trustedDrag(s: CdpSession, fromX: number, toX: number, y: number) {
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
export async function setEffort(s: CdpSession, effort: string): Promise<EffortResult> {
  const target = String(effort).trim().toLowerCase();
  const ti = EFFORTS.indexOf(target);
  if (ti < 0) throw new Error(`invalid effort "${effort}" — want one of: ${EFFORTS.join(', ')}`);

  // the pill can lag behind composer readiness on fresh tabs — poll briefly
  const chipDeadline = Date.now() + 5000;
  let chip: { text: string; cx: number; cy: number } | null | undefined;
  while (Date.now() < chipDeadline) {
    chip = await s.eval(EFFORT_CHIP);
    if (chip) break;
    await sleep(300);
  }
  if (!chip) throw new Error('effort chip not found in composer');
  if (chip.text === target) return { effort: target, changed: false };

  // open the popup. On background tabs it can flash-close when no further
  // input follows the click, so: hold it open with an inert key press, poll
  // fast, and as a last resort make the tab visible (the popup only opens on
  // a tab the browser reports visible — see the module invariants).
  let geom: { now: number; min: number; max: number; thumb: number[]; track: number[] | null; visible: boolean } | null | undefined;
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
  const toX = geom.track![0] + (ti / (geom.max - geom.min)) * geom.track![2];
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
