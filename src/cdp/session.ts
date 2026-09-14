// Minimal CDP-over-WebSocket session bound to one page target, plus the poll
// helper every page primitive uses to wait for a page condition.

export class CdpSession {
  wsUrl: string;
  ws: WebSocket | null;
  id: number;
  pending: Map<number, (msg: any) => void>;

  constructor(wsUrl: string) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.id = 0;
    this.pending = new Map();
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('WebSocket connect failed: ' + this.wsUrl));
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id && this.pending.has(msg.id)) {
          this.pending.get(msg.id)!(msg);
          this.pending.delete(msg.id);
        }
      };
    });
  }

  send(method: string, params?: object): Promise<any> {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, resolve);
      this.ws!.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(method + ' timed out')); }
      }, 15000);
    });
  }

  async eval(expression: string): Promise<any> {
    const r = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true, userGesture: true,
    });
    if (r.result?.exceptionDetails) {
      throw new Error('page exception: ' + (r.result.exceptionDetails.exception?.description || 'unknown'));
    }
    return r.result?.result?.value;
  }

  close() { this.ws?.close(); }
}

// Poll a boolean page expression until it evaluates true or the timeout hits.
export async function poll(
  s: CdpSession,
  condExpr: string,
  { timeoutMs = 12000, intervalMs = 500 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<true> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await s.eval(`Boolean(${condExpr})`)) return true;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error('timeout waiting for: ' + condExpr);
}
