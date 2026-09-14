// Unit tests for chat reference normalization (pure logic, no browser).
import { describe, expect, it } from 'bun:test';
import { normalizeChatRef } from '../src/refs';

const UUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

describe('normalizeChatRef', () => {
  it('accepts a full https URL', () => {
    expect(normalizeChatRef(`https://chatgpt.com/c/${UUID}`)).toBe(`/c/${UUID}`);
  });

  it('accepts an http URL', () => {
    expect(normalizeChatRef(`http://chatgpt.com/c/${UUID}`)).toBe(`/c/${UUID}`);
  });

  it('strips query strings from URLs', () => {
    expect(normalizeChatRef(`https://chatgpt.com/c/${UUID}?model=gpt-4&x=1`)).toBe(`/c/${UUID}`);
  });

  it('accepts a URL path with query', () => {
    expect(normalizeChatRef(`/c/${UUID}?y=2`)).toBe(`/c/${UUID}`);
  });

  it('keeps project chat paths intact', () => {
    expect(normalizeChatRef('https://chatgpt.com/g/g-p-6aa60d-splats/c/' + UUID)).toBe('/g/g-p-6aa60d-splats/c/' + UUID);
  });

  it('expands a bare uuid to /c/<uuid>', () => {
    expect(normalizeChatRef(UUID)).toBe(`/c/${UUID}`);
  });

  it('rejects an uppercase uuid', () => {
    expect(() => normalizeChatRef(UUID.toUpperCase())).toThrow('unrecognized chat reference');
  });

  it('rejects arbitrary text', () => {
    expect(() => normalizeChatRef('hello')).toThrow(/unrecognized chat reference: hello/);
  });
});
