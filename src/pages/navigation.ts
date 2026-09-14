// Chat navigation: new general chat, new project chat, opening an existing
// chat. All of these act on the passed session's tab (SPA navigation, no
// reloads except where noted).

import { poll, CdpSession } from '../cdp/session';
import { normalizeChatRef } from '../refs';
import { json } from '../util';
import { enterProject } from './projects';
import { COMPOSER_READY } from './composer';
import type { NewProjectChatResult } from '../types';

// New NON-PROJECT chat: click the visible sidebar "New chat" link (SPA route);
// if the sidebar is collapsed, fall back to a plain navigation to "/".
export async function newChat(s: CdpSession) {
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
export async function newProjectChat(s: CdpSession, nameOrId: string): Promise<NewProjectChatResult> {
  const entered = await enterProject(s, nameOrId);
  return { ...entered, composer: 'ready' };
}

// Open an existing chat by full URL, URL path, or bare conversation uuid.
export async function openChat(s: CdpSession, ref: string) {
  const path = normalizeChatRef(ref);
  await s.eval(`location.assign(${json(path)}); 'navigating'`);
  await poll(s, `location.pathname === ${json(path)} && ${COMPOSER_READY}`);
  return s.eval(`({ url: location.href })`);
}
