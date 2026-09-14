// Unit tests for message-round extraction (pure logic, no browser).
import { describe, expect, it } from 'bun:test';
import { sliceRounds } from '../src/pages/messages';
import type { ChatMessage } from '../src/types';

const m = (role: string, text: string): ChatMessage => ({ role, text });

// Three full rounds.
const THREE = [m('user', 'q1'), m('assistant', 'a1'), m('user', 'q2'), m('assistant', 'a2'), m('user', 'q3'), m('assistant', 'a3')];

describe('sliceRounds', () => {
  it('rounds=1 keeps the latest user-anchored round', () => {
    expect(sliceRounds(THREE, 1)).toEqual([m('user', 'q3'), m('assistant', 'a3')]);
  });

  it('rounds=2 keeps the last two rounds', () => {
    expect(sliceRounds(THREE, 2)).toEqual(THREE.slice(2));
  });

  it('rounds larger than the round count keeps everything from the first user turn', () => {
    expect(sliceRounds(THREE, 99)).toEqual(THREE);
  });

  it('rounds=-1 returns everything verbatim', () => {
    expect(sliceRounds(THREE, -1)).toBe(THREE);
  });

  it('rounds=0 returns an empty array', () => {
    expect(sliceRounds(THREE, 0)).toEqual([]);
  });

  it('rounds are anchored on user turns, not assistant turns', () => {
    // Assistant-led prefix must be excluded: the round starts at the first kept user turn.
    const msgs = [m('assistant', 'pre'), ...THREE];
    expect(sliceRounds(msgs, 1)).toEqual([m('user', 'q3'), m('assistant', 'a3')]);
    expect(sliceRounds(msgs, 3)).toEqual(THREE);
  });

  it('a trailing user turn without a reply forms its own round', () => {
    const msgs = [m('user', 'q1'), m('assistant', 'a1'), m('user', 'q2')];
    expect(sliceRounds(msgs, 1)).toEqual([m('user', 'q2')]);
  });

  it('returns [] when there is no user turn', () => {
    expect(sliceRounds([m('assistant', 'a1'), m('assistant', 'a2')], 1)).toEqual([]);
  });
});
