// Unit tests for CdpSession.send() over a fake WebSocket (no browser): the
// promise resolves with the full CDP response for the matching id, and the
// response clears the timeout timer (a leftover timer would hang the CLI ~15s).
import { describe, expect, it } from 'bun:test';
import { CdpSession } from '../src/cdp/session';

// Minimal WebSocket double: records outgoing frames; replies optionally.
class FakeWs {
  sent: string[] = [];
  onmessage: ((ev: { data: string }) => void) | null = null;
  send(data: string) { this.sent.push(data); }
  // Deliver a CDP response frame {id, ...msg} as the real socket would.
  reply(id: number, msg: Record<string, unknown>) {
    queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ id, ...msg }) }));
  }
}

// A session wired to a FakeWs without going through connect(). The message
// dispatch below replicates what connect() installs on a real socket.
function sessionWith(ws: FakeWs): CdpSession {
  const s = new CdpSession('ws://127.0.0.1:1/devtools/page/ABC');
  (s as any).ws = ws;
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && s.pending.has(msg.id)) {
      s.pending.get(msg.id)!(msg);
      s.pending.delete(msg.id);
    }
  };
  return s;
}

describe('CdpSession.send', () => {
  it('resolves with the full CDP response matching the request id', async () => {
    const ws = new FakeWs();
    const s = sessionWith(ws);
    const p = s.send('Runtime.evaluate', { expression: '1+1' });
    const frame = JSON.parse(ws.sent[0]);
    expect(frame.method).toBe('Runtime.evaluate');
    ws.reply(frame.id, { result: { result: { value: 2 } } });
    // send() resolves with the FULL response message (id + CDP result blob)
    expect(await p).toEqual({ id: frame.id, result: { result: { value: 2 } } });
  });

  it('does not resolve a promise from a response with a different id', async () => {
    const ws = new FakeWs();
    const s = sessionWith(ws);
    const p = s.send('Page.bringToFront');
    const frame = JSON.parse(ws.sent[0]);
    ws.reply(frame.id + 99, { result: {} }); // unrelated id: must be ignored
    ws.reply(frame.id, { result: {} });
    expect(await p).toEqual({ id: frame.id, result: {} });
  });

  it('serves concurrent sends, each with its own id', async () => {
    const ws = new FakeWs();
    const s = sessionWith(ws);
    const p1 = s.send('A.one');
    const p2 = s.send('A.two');
    const f1 = JSON.parse(ws.sent[0]);
    const f2 = JSON.parse(ws.sent[1]);
    expect(f2.id).toBe(f1.id + 1);
    ws.reply(f2.id, { result: 'second' });
    ws.reply(f1.id, { result: 'first' });
    expect(await p1).toEqual({ id: f1.id, result: 'first' });
    expect(await p2).toEqual({ id: f2.id, result: 'second' });
  });
});
