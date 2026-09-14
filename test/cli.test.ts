// Unit tests for CLI argument parsing and the usage line (no browser needed).
import { describe, expect, it } from 'bun:test';
import { commandList, parseArgv, usageLine } from '../src/cli';

describe('parseArgv', () => {
  it('splits command from the rest', () => {
    expect(parseArgv(['send-chat', 'hello', 'https://chatgpt.com/c/x'])).toEqual({
      cmd: 'send-chat',
      args: ['hello', 'https://chatgpt.com/c/x'],
    });
  });

  it('returns undefined cmd for an empty argv', () => {
    expect(parseArgv([])).toEqual({ cmd: undefined, args: [] });
  });

  it('keeps numeric-looking args as strings', () => {
    expect(parseArgv(['messages', '/c/x', '-1']).args).toEqual(['/c/x', '-1']);
  });
});

describe('command surface', () => {
  it('lists every prototype command, session commands first', () => {
    expect(commandList()).toEqual([
      'url', 'list-projects', 'enter-project', 'new-chat', 'new-project-chat',
      'open-chat', 'search-chat', 'ports', 'messages', 'send-chat', 'send-project-chat',
    ]);
  });

  it('renders the usage line exactly as the prototype did', () => {
    expect(usageLine()).toBe(
      'Commands: url, list-projects, enter-project, new-chat, new-project-chat, ' +
      'open-chat, search-chat, ports, messages, send-chat, send-project-chat',
    );
  });
});
