/**
 * NDJSONParser adversarial tests.
 *
 * The parser is the most reused piece of the extension (every CLI
 * subcommand funnels through it). The tests below exercise the
 * realistic failure modes the shim or a real CLI might emit:
 *
 *  1. chunks that split a single line in the middle
 *  2. JSON strings that contain an *escaped* newline (`\n` literal)
 *  3. malformed lines (no closing brace, truncated UTF-8, garbage)
 *  4. event types that the consumer does not recognise
 *  5. empty / whitespace-only lines
 *  6. a final flush that contains a partial line
 *  7. CR (`\r\n`) line endings
 *  8. very large payloads (regression test for buffer growth)
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { Readable } from 'node:stream';
import { NDJSONParser } from '../../src/client/ndjson';

function fromStrings(...chunks: string[]): Readable {
  return Readable.from(chunks.map((c) => Buffer.from(c, 'utf8')));
}

async function collect(stream: Readable): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const row of stream as unknown as AsyncIterable<unknown>) {
    out.push(row);
  }
  return out;
}

test('NDJSON: chunked input that splits a single line', async () => {
  // Each line is split into two chunks on purpose.
  const src = fromStrings(
    '{"type":"rea',
    'dy","sessionId":"s1"}\n',
    '{"type":"message","content":"hel',
    'lo"}\n',
    '{"type":"done"}\n',
  );
  const rows = await collect(src.pipe(new NDJSONParser()));
  assert.equal(rows.length, 3);
  assert.equal((rows[0] as { type: string }).type, 'ready');
  assert.equal((rows[1] as { content: string }).content, 'hello');
  assert.equal((rows[2] as { type: string }).type, 'done');
});

test('NDJSON: line with an escaped \\n inside a JSON string is preserved', async () => {
  // "line1\nline2" → the literal escape sequence in the JSON, not a
  // raw newline. The parser must NOT split on it.
  const src = fromStrings(
    JSON.stringify({ type: 'message', content: 'line1\nline2' }) + '\n',
    JSON.stringify({ type: 'message', content: 'no newline here' }) + '\n',
  );
  const rows = await collect(src.pipe(new NDJSONParser()));
  assert.equal(rows.length, 2);
  assert.equal((rows[0] as { content: string }).content, 'line1\nline2');
  assert.equal((rows[1] as { content: string }).content, 'no newline here');
});

test('NDJSON: malformed line (no closing brace) is dropped, others still parse', async () => {
  // Capture stderr to keep the test output clean.
  const origWrite = process.stderr.write.bind(process.stderr);
  const captured: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr.write as any) = (chunk: unknown) => {
    captured.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  };
  try {
    const src = fromStrings(
      '{"type":"ready"}\n',
      '{this is not json\n', // malformed
      '{"type":"message","content":"after"}\n',
      '{"unterminated":"oops"\n', // missing closing brace
      '{"type":"done"}\n',
    );
    const rows = await collect(src.pipe(new NDJSONParser()));
    assert.equal(rows.length, 3, 'expected 3 well-formed lines');
    assert.equal((rows[0] as { type: string }).type, 'ready');
    assert.equal((rows[1] as { content: string }).content, 'after');
    assert.equal((rows[2] as { type: string }).type, 'done');
    assert.ok(captured.some((c) => c.includes('dropped malformed line')));
  } finally {
    process.stderr.write = origWrite;
  }
});

test('NDJSON: unknown event types are passed through to the consumer (graceful ignore at dispatch)', async () => {
  const src = fromStrings(
    JSON.stringify({ type: 'ready' }) + '\n',
    JSON.stringify({ type: 'fancy_new_thing', payload: 42 }) + '\n',
    JSON.stringify({ type: 'done' }) + '\n',
  );
  const rows = await collect(src.pipe(new NDJSONParser()));
  assert.equal(rows.length, 3);
  assert.equal((rows[1] as { type: string; payload: number }).type, 'fancy_new_thing');
  assert.equal((rows[1] as { payload: number }).payload, 42);
});

test('NDJSON: empty / whitespace-only lines are ignored, not parsed as JSON', async () => {
  const src = fromStrings(
    '\n',
    '   \n',
    '\t\n',
    JSON.stringify({ type: 'ready' }) + '\n',
    '\n',
  );
  const rows = await collect(src.pipe(new NDJSONParser()));
  assert.equal(rows.length, 1);
  assert.equal((rows[0] as { type: string }).type, 'ready');
});

test('NDJSON: trailing buffer without newline is parsed on flush', async () => {
  const src = fromStrings(
    JSON.stringify({ type: 'ready' }) + '\n',
    JSON.stringify({ type: 'done' }), // no trailing newline
  );
  const rows = await collect(src.pipe(new NDJSONParser()));
  assert.equal(rows.length, 2);
  assert.equal((rows[1] as { type: string }).type, 'done');
});

test('NDJSON: trailing malformed buffer is dropped on flush (no crash)', async () => {
  const origWrite = process.stderr.write.bind(process.stderr);
  const captured: string[] = [];
  process.stderr.write = ((chunk: unknown) => {
    captured.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const src = fromStrings(JSON.stringify({ type: 'ready' }) + '\n', '{not json');
    const rows = await collect(src.pipe(new NDJSONParser()));
    assert.equal(rows.length, 1);
    assert.ok(captured.some((c) => c.includes('dropped trailing buffer')));
  } finally {
    process.stderr.write = origWrite;
  }
});

test('NDJSON: CRLF line endings are stripped of the CR', async () => {
  const src = fromStrings(
    JSON.stringify({ type: 'ready' }) + '\r\n',
    JSON.stringify({ type: 'done' }) + '\r\n',
  );
  const rows = await collect(src.pipe(new NDJSONParser()));
  assert.equal(rows.length, 2);
  assert.equal((rows[0] as { type: string }).type, 'ready');
  assert.equal((rows[1] as { type: string }).type, 'done');
});

test('NDJSON: very long single line (> 64 KB) parses correctly', async () => {
  const big = 'x'.repeat(80_000);
  const payload = JSON.stringify({ type: 'message', content: big }) + '\n';
  const src = fromStrings(payload);
  const rows = await collect(src.pipe(new NDJSONParser()));
  assert.equal(rows.length, 1);
  assert.equal((rows[0] as { content: string }).content.length, 80_000);
});
