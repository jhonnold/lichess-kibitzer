import type { SseEvent } from '../../shared/types-v2.js';

/** Streaming SSE reader (supertest buffers until the response ends, so it can't read SSE). */
export async function sse(url: string) {
  const ctrl = new AbortController();
  const res = await fetch(url, { signal: ctrl.signal });
  const frames: string[] = [];
  const events: SseEvent[] = [];
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  const done = (async () => {
    let buf = '';
    try {
      for (let r = await reader.read(); !r.done; r = await reader.read()) {
        buf += r.value;
        for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          frames.push(frame);
          if (frame.startsWith('data: ')) events.push(JSON.parse(frame.slice(6)) as SseEvent);
        }
      }
    } catch {
      /* aborted */
    }
  })();
  return { res, frames, events, close: () => (ctrl.abort(), done) };
}
