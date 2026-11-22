// wasm-run.mjs
import { Buffer } from 'node:buffer';

const count = Number(process.env.CSVW_N);
if (!Number.isSafeInteger(count) || count < 1) {
  throw new Error('Missing or invalid CSVW_N secret');
}

const parts = new Array(count);
for (let i = 0; i < count; ++i) {
  const part = process.env[`CSVW_${i}`];
  if (typeof part !== 'string' || part.length === 0) {
    throw new Error(`Missing CSVW_${i} secret`);
  }
  parts[i] = part;
}

const instance = new WebAssembly.Instance(
  new WebAssembly.Module(Buffer.from(parts.join(''), 'base64')),
  {
    env: {
      abort() {
        throw new Error('CSV WASM aborted');
      },
    },
  },
);

const wasm = instance.exports;
const memory = wasm.memory;
const INPUT = 0x100000 + 128;
const MAX_BYTES = 0x7fff0000;

function ensureMemory(required) {
  if (!Number.isSafeInteger(required) || required > MAX_BYTES) {
    throw new RangeError('CSV input exceeds the parser memory limit');
  }

  const current = memory.buffer.byteLength;
  if (current < required) {
    memory.grow(Math.ceil((required - current) / 65536));
  }
}

function outputView(pointer) {
  return new Uint8Array(
    memory.buffer,
    pointer >>> 0,
    wasm.outputLength() >>> 0,
  );
}

/**
 * Parse a single {text, header} input through the original UTF-16LE path.
 * The returned view is valid only until the next parser call.
 */
export function runBytes(input) {
  const text = String(input.text);
  const byteLength = text.length * 2;

  ensureMemory(INPUT + byteLength + 32);
  Buffer.from(memory.buffer, INPUT, byteLength).write(
    text,
    0,
    byteLength,
    'utf16le',
  );

  return outputView(
    wasm.parse(INPUT, byteLength, input.header === true ? 1 : 0),
  );
}

/**
 * Parse source[start:end], the UTF-8 bytes BETWEEN a JSON string's quotes.
 * source is a Buffer or Uint8Array; no JavaScript string is constructed.
 * The returned view is valid only until the next parser call.
 */
export function runEscapedBytes(
  source,
  start = 0,
  end = source.byteLength,
  header = false,
) {
  if (!(source instanceof Uint8Array)) {
    throw new TypeError('Expected a Buffer or Uint8Array');
  }
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    end > source.byteLength
  ) {
    throw new RangeError('Invalid JSON string byte range');
  }

  const byteLength = end - start;

  // Decoding expands by at most 2x. This placement permits overlap
  // while keeping speculative decoder stores before unread bytes.
  const sourcePointer = INPUT + byteLength + 32;
  ensureMemory(sourcePointer + byteLength);

  new Uint8Array(memory.buffer, sourcePointer, byteLength).set(
    source.subarray(start, end),
  );

  return outputView(
    wasm.parseJson(
      sourcePointer,
      byteLength,
      INPUT,
      header === true ? 1 : 0,
    ),
  );
}

/** Return one answer as a JSON string, preserving the existing API. */
export function runJson(input) {
  const bytes = runBytes(input);
  return Buffer.from(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).toString('utf8');
}

/** Return one answer as an object, preserving the existing API. */
export function run(input) {
  return JSON.parse(runJson(input));
}
