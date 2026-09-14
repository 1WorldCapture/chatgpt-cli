#!/usr/bin/env node
// CLI entry: argument parsing and command dispatch.
//
// Commands:
//   chatgpt-cdp-cli ports                       # list AdsPower SunBrowser CDP ports
//   chatgpt-cdp-cli url
//   chatgpt-cdp-cli list-projects
//   chatgpt-cdp-cli new-chat
//   chatgpt-cdp-cli new-project-chat "Splats" | g-p-6aa60d...
//   chatgpt-cdp-cli open-chat "https://chatgpt.com/c/<uuid>" | "/c/<uuid>" | "<uuid>"
//   chatgpt-cdp-cli search-chat "钢笔" [limit]
//   chatgpt-cdp-cli messages <url|path|uuid> [rounds]   # rounds default 1, -1 = all
//   chatgpt-cdp-cli send-chat "<text>" [chatUrl]         # no url = new general chat
//   chatgpt-cdp-cli send-project-chat "<text>" <projectId|chatUrl>
//   chatgpt-cdp-cli enter-project "Splats" | g-p-...
//
// Env: CDP_PORT — optional override; WITHOUT it the port is auto-discovered
// from the running AdsPower SunBrowser (its CDP port is random per launch and
// recorded in <user-data-dir>/DevToolsActivePort). Requires Node >= 22.

import { pathToFileURL } from 'node:url';
import { discoverAdspowerCdp } from './discovery';
import { connect } from './cdp/connection';
import { CdpSession } from './cdp/session';
import { listProjects, enterProject } from './pages/projects';
import { newChat, newProjectChat, openChat } from './pages/navigation';
import { searchChat } from './pages/search';
import { getMessages } from './pages/messages';
import { sendChat, sendProjectChat } from './api';

// Commands operating on the session's own tab (connected via connect()).
const commands: Record<string, (s: CdpSession, ...args: string[]) => any> = {
  url: (s) => s.eval('location.href'),
  'list-projects': listProjects,
  'enter-project': enterProject,
  'new-chat': newChat,
  'new-project-chat': newProjectChat,
  'open-chat': openChat,
  'search-chat': (s, query, limit) => searchChat(s, query!, limit ? { limit: +limit } : {}),
};
// getMessages and the send tools manage their own tabs, so they take the port
// instead of a session.
const portCommands: Record<string, (args: string[]) => any> = {
  'ports': async () => discoverAdspowerCdp(),
  'messages': (args) => getMessages(null, args[0]!, args[1] === undefined ? 1 : +args[1]),
  'send-chat': ([text, chatUrl, effort]) => sendChat(null, text!, { chatUrl, effort }),
  'send-project-chat': ([text, ref, effort]) => (/^g-p-[0-9a-f]+$/.test(ref ?? '')
    ? sendProjectChat(null, text!, { projectId: ref, effort })
    : sendProjectChat(null, text!, { chatUrl: ref, effort })),
};

// All command names in usage order (session commands first, then port commands).
export function commandList(): string[] {
  return [...Object.keys(commands), ...Object.keys(portCommands)];
}

export function usageLine(): string {
  return 'Commands: ' + commandList().join(', ');
}

export function parseArgv(argv: string[]): { cmd: string | undefined; args: string[] } {
  const [cmd, ...args] = argv;
  return { cmd, args };
}

export async function cliMain(argv: string[] = process.argv.slice(2)): Promise<void> {
  const { cmd, args } = parseArgv(argv);
  if (!cmd || (!commands[cmd] && !portCommands[cmd])) {
    console.error(usageLine());
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

// Main-module guard: Bun (script or compiled executable) sets import.meta.main;
// under plain Node compare the module URL with the invoked script path.
const invokedAsMain = import.meta.main === true
  || (typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href);

if (invokedAsMain) await cliMain();
