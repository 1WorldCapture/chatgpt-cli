// ChatGPT web-UI driver via CDP — pure page simulation only (clicks / SPA navigation),
// no backend-api or /api calls from our side.
//
// Library API — agent-facing tools (atomic, no implicit page state):
//   await sendChat(port, text, {chatUrl, timeoutMs, effort})
//     SEND a message; see src/api.ts for the full contract and the accepted
//     completion-detection residual.
//   await sendProjectChat(port, text, {projectId, chatUrl, timeoutMs, effort})
//     same, but a new chat is created inside projectId (g-p-<id>).
//   await getMessages(port, ref, rounds)
//     ATOMIC read: ref is a chat URL/path/uuid; rounds=1 (default) latest
//     exchange, -1 all. Returns [{role, text}].
//   await searchChat(s, query, {limit})
//     SEARCH ONLY, never navigates: returns matched chats as [{title, url}].
//   await listProjects(s)
//     sidebar projects [{name, id|null}].
//
// Internal building blocks (NOT agent tools — they act on the passed session's page):
//   await connect(port?)                 -> session bound to the first chatgpt.com tab
//   await newChat(s)                     -> fresh NON-PROJECT chat composer on "/"
//   await newProjectChat(s, nameOrId)    -> fresh composer inside a project
//   await openChat(s, ref)               -> navigate this tab to an existing chat
//   await enterProject(s, nameOrId)      -> project home page by name or g-p- id
//   await setEffort(s, effort)           -> composer reasoning effort slider
//
// The CLI entry lives in src/cli.ts (same commands as the original prototype).
// Env: CDP_PORT — optional port override; without it the port is auto-discovered
// from the running AdsPower SunBrowser.

export { discoverAdspowerCdp } from './discovery';
export { connect } from './cdp/connection';
export { listProjects, enterProject } from './pages/projects';
export { newChat, newProjectChat, openChat } from './pages/navigation';
export { searchChat } from './pages/search';
export { getMessages } from './pages/messages';
export { setEffort } from './pages/effort';
export { sendChat, sendProjectChat } from './api';
