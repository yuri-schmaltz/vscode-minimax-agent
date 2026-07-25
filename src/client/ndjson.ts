/**
 * Tiny NDJSON line splitter. Operates on a Buffer stream and emits one
 * parsed JSON object per newline-delimited record.
 *
 * Note: this stream is in `objectMode` so that downstream `data` listeners
 * receive the parsed JavaScript values directly (rather than having to
 * re-parse the JSON string).
 */
import { Transform, TransformCallback } from 'node:stream';
import { redactString } from '../util/redact';

export class NDJSONParser extends Transform {
  private buf = '';

  constructor() {
    super({ readableObjectMode: true });
  }

  override _transform(chunk: Buffer | string, _enc: string, cb: TransformCallback): void {
    this.buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let idx: number;
    while ((idx = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, idx).replace(/\r$/, '');
      this.buf = this.buf.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        this.push(JSON.parse(line));
      } catch {
        // Drop malformed lines instead of crashing the whole stream. The
        // shim never produces these in mock mode, but the real CLI might
        // (e.g. ANSI escapes on TTY). Log to stderr for debugging.
        process.stderr.write(`[mavis:ndjson] dropped malformed line: ${redactString(line.slice(0, 120))}\n`);
      }
    }
    cb();
  }

  override _flush(cb: TransformCallback): void {
    if (this.buf.trim()) {
      try {
        this.push(JSON.parse(this.buf));
      } catch {
        process.stderr.write(`[mavis:ndjson] dropped trailing buffer: ${redactString(this.buf.slice(0, 120))}\n`);
      }
      this.buf = '';
    }
    cb();
  }
}
