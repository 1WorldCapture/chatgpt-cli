// Sidebar projects: listing and entering project home pages.
//
// INVARIANT: Project URL is /g/<project-id>-<slug>/project; the id is g-p-<hex>,
// the rest is a cosmetic slug. Navigating to the bare /g/<id> redirects to the
// full URL, so storing the id alone is enough.

import { poll, CdpSession } from '../cdp/session';
import { json } from '../util';
import { COMPOSER_READY } from './composer';

// Sidebar "Projects" section: each li carries an options button whose aria-label
// ends with the project name; project id is only in-DOM when the project has chats.
export async function listProjects(s: CdpSession) {
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

// The project page keeps loading after the composer is ready: the h1 briefly
// shows the transient greeting hero ("Hey, ... Ready to dive in?") or nothing
// at all. The settled project name mirrors into document.title ("ChatGPT -
// <name>"), which the greeting never does.
const PROJECT_HEADER_SETTLED = `(() => {
  const h1 = document.querySelector('h1');
  const name = (h1?.textContent || '').trim();
  return name.length > 0 && document.title.endsWith(name);
})()`;

// Enter a project home page by display name (sidebar click) or by project id
// (bare /g/<id> URL, which the app redirects to the full project URL).
export async function enterProject(s: CdpSession, nameOrId: string) {
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
  // Best effort: wait for the real project header so projectName is the
  // project name, not the load-time greeting. On timeout fall back to
  // whatever the DOM says (same output shape as before).
  try {
    await poll(s, PROJECT_HEADER_SETTLED, { timeoutMs: 10000 });
  } catch { /* keep going with the current DOM */ }
  return s.eval(`({
    url: location.href,
    projectId: (location.pathname.match(/g-p-[0-9a-f]+/) || [])[0] || null,
    projectName: document.querySelector('h1')?.textContent.trim() || null,
  })`);
}
