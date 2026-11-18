export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${url}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) throw new ApiError(data?.error ?? `${res.status} ${res.statusText}`, res.status);
  return data as T;
}

export const api = {
  get: <T = any>(u: string) => req<T>('GET', u),
  post: <T = any>(u: string, b: unknown = {}) => req<T>('POST', u, b),
  put: <T = any>(u: string, b: unknown) => req<T>('PUT', u, b),
  del: <T = any>(u: string) => req<T>('DELETE', u),
  text: async (u: string) => {
    const r = await fetch(`/api${u}`);
    if (!r.ok) throw new ApiError(await r.text(), r.status);
    return r.text();
  },
};

type Listener = (msg: any) => void;

export class Socket {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private subs = new Set<string>();
  private retry = 0;
  connected = false;
  onStatus?: (c: boolean) => void;

  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      this.retry = 0;
      this.onStatus?.(true);
      for (const s of this.subs) ws.send(JSON.stringify({ subscribe: s }));
    };
    ws.onmessage = (ev) => {
      try {
        const m = JSON.parse(ev.data);
        for (const l of this.listeners) l(m);
      } catch {
        /* ignore */
      }
    };
    ws.onclose = () => {
      this.connected = false;
      this.onStatus?.(false);
      setTimeout(() => this.connect(), Math.min(5000, 500 * 2 ** this.retry++));
    };
  }
  subscribe(projectId: string) {
    for (const s of this.subs) if (s !== projectId) this.ws?.readyState === 1 && this.ws.send(JSON.stringify({ unsubscribe: s }));
    this.subs = new Set([projectId]);
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ subscribe: projectId }));
  }
  on(l: Listener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}

export const socket = new Socket();
