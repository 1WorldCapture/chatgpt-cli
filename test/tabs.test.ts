// Unit tests for the chat-tab URL matcher (pure logic, no browser).
import { describe, expect, it } from 'bun:test';
import { makeChatTabMatcher } from '../src/cdp/tabs';

const UUID = '11111111-2222-3333-4444-555555555555';

describe('makeChatTabMatcher (convId mode)', () => {
  const isChatTab = makeChatTabMatcher(UUID, `/c/${UUID}`);

  it('matches a plain chat URL', () => {
    expect(isChatTab(`https://chatgpt.com/c/${UUID}`)).toBe(true);
  });

  it('matches a project-scoped chat URL (/g/.../c/<uuid>)', () => {
    expect(isChatTab(`https://chatgpt.com/g/g-p-6aa60d-splats/c/${UUID}`)).toBe(true);
  });

  it('ignores query params', () => {
    expect(isChatTab(`https://chatgpt.com/c/${UUID}?model=gpt-4o`)).toBe(true);
  });

  it('rejects a different conversation', () => {
    expect(isChatTab('https://chatgpt.com/c/99999999-9999-9999-9999-999999999999')).toBe(false);
  });

  it('rejects non-chatgpt.com origins (exact origin check)', () => {
    expect(isChatTab(`https://evil.com/c/${UUID}`)).toBe(false);
    expect(isChatTab(`https://chatgpt.com.evil.com/c/${UUID}`)).toBe(false);
  });

  it('rejects garbage URLs', () => {
    expect(isChatTab('not a url')).toBe(false);
  });
});

describe('makeChatTabMatcher (path mode, no convId)', () => {
  const isChatTab = makeChatTabMatcher(null, '/g/g-p-6aa60d');

  it('matches the exact path', () => {
    expect(isChatTab('https://chatgpt.com/g/g-p-6aa60d')).toBe(true);
  });

  it('tolerates query params on the exact path', () => {
    expect(isChatTab('https://chatgpt.com/g/g-p-6aa60d?x=1')).toBe(true);
  });

  it('requires an exact pathname match (no prefix matching)', () => {
    expect(isChatTab('https://chatgpt.com/g/g-p-6aa60d/project')).toBe(false);
  });
});
