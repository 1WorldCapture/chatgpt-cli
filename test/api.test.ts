// Unit tests for the send-flow expectation substring (pure logic, no browser).
import { describe, expect, it } from 'bun:test';
import { chatExpect } from '../src/api';

const UUID = '11111111-2222-3333-4444-555555555555';

describe('chatExpect', () => {
  it('reduces a chat URL to its conversation uuid', () => {
    expect(chatExpect(`https://chatgpt.com/c/${UUID}`)).toBe(UUID);
  });

  it('reduces a project chat URL to its conversation uuid', () => {
    expect(chatExpect(`/g/g-p-6aa60d-splats/c/${UUID}`)).toBe(UUID);
  });

  it('falls back to the path when there is no /c/<uuid>', () => {
    expect(chatExpect('https://chatgpt.com/g/g-p-6aa60d/project')).toBe('/g/g-p-6aa60d/project');
  });

  it('expands a bare uuid then reduces back to it', () => {
    expect(chatExpect(UUID)).toBe(UUID);
  });
});
