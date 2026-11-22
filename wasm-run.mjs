// wasm-run.mjs
import { Buffer } from 'node:buffer';

const count = Number(process.env.CSVW_N);
if (!Number.isSafeInteger(count) || count < 1) {
  throw new Error('Missing or invalid CSVW_N secret');
}

let code = '';
for (let i = 0; i < count; ++i) {
  const part = process.env[`CSVW_${i}`];
  if (typeof part !== 'string' || part.length === 0) {
    throw new Error(`Missing CSVW_${i} secret`);
  }
  code += part;
}

const wasm = new WebAssembly.Instance(
  new WebAssembly.Module(Buffer.from(code, 'base64')),
  {
    env: {
      abort() {
        throw new Error('CSV WASM aborted');
      },
    },
  },
).exports;
code = '';

const memory = wasm.memory;
const INPUT = 0x100000 + 128;
const MAX_BYTES = 0x7fff0000;
let stagedEnd = INPUT;

function ensureMemory(required) {
  if (!Number.isSafeInteger(required) || required > MAX_BYTES) {
    throw new RangeError('CSV input exceeds the parser memory limit');
  }

  const current = memory.buffer.byteLength;
  if (required > current) {
    memory.grow(Math.ceil((required - current) / 65536));
  }
}

function outputView(pointer) {
  return Buffer.from(
    memory.buffer,
    pointer >>> 0,
    wasm.outputLength() >>> 0,
  );
}

function checkRange(start, end, length) {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    end > length
  ) {
    throw new RangeError('Invalid JSON string byte range');
  }
}

/** Returned views remain valid only until the next parser/staging call. */
export function runBytes(input) {
  const text = String(input.text);
  const length = text.length * 2;

  ensureMemory(INPUT + length + 32);
  Buffer.from(memory.buffer, INPUT, length).write(
    text,
    0,
    length,
    'utf16le',
  );

  return outputView(
    wasm.parse(INPUT, length, input.header === true ? 1 : 0),
  );
}

/** Transduce bytes between a JSON string's surrounding quotes. */
export function runEscapedBytes(
  source,
  start = 0,
  end = source.byteLength,
  header = false,
) {
  if (!(source instanceof Uint8Array)) {
    throw new TypeError('Expected a Buffer or Uint8Array');
  }
  checkRange(start, end, source.byteLength);

  const length = end - start;
  let pointer;
  let reservedEnd;

  if (source.buffer === memory.buffer) {
    pointer = source.byteOffset + start;
    reservedEnd = source.byteOffset + source.byteLength;
    ensureMemory(reservedEnd + 32);
  } else {
    pointer = INPUT;
    reservedEnd = INPUT + length;
    ensureMemory(reservedEnd + 32);

    new Uint8Array(memory.buffer, INPUT, length).set(
      source.subarray(start, end),
    );
  }

  return outputView(
    wasm.parseJson(pointer, length, reservedEnd, header === true ? 1 : 0),
  );
}

export function runJson(input) {
  return runBytes(input).toString('utf8');
}

export function run(input) {
  return JSON.parse(runJson(input));
}

/**
 * Allocate the entire input file in WASM memory for direct readSync.
 * Scan the envelope before parsing: memory growth can detach this view.
 */
export function stageInput(length) {
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new RangeError('Invalid input file length');
  }

  const end = INPUT + length;
  ensureMemory(end + 32);
  stagedEnd = end;
  return Buffer.from(memory.buffer, INPUT, length);
}

/** Return a staged-file-relative closing quote position. */
export function findStringEnd(start) {
  return (wasm.jsonStringEnd(INPUT + start, stagedEnd) >>> 0) - INPUT;
}

/** Parse a staged range while preserving the entire staged input file. */
export function runStagedBytes(start, end, header = false) {
  checkRange(start, end, stagedEnd - INPUT);

  return outputView(
    wasm.parseJson(
      INPUT + start,
      end - start,
      stagedEnd,
      header === true ? 1 : 0,
    ),
  );
}
