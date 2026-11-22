// Shared WASM loader: returns the answer as JSON text (fast path) or as an
// object (the solve.js API). The WASM module comes from the entry secrets.
import { Buffer } from 'node:buffer';

const count = Number(process.env.CSVW_N);
if (!Number.isSafeInteger(count) || count < 1) {
  throw new Error('Missing or invalid CSVW_N secret');
}
const parts = new Array(count);
for (let i = 0; i < count; i++) {
  const part = process.env[`CSVW_${i}`];
  if (typeof part !== 'string' || part.length === 0) {
    throw new Error(`Missing CSVW_${i} secret`);
  }
  parts[i] = part;
}
const instance = new WebAssembly.Instance(
  new WebAssembly.Module(Buffer.from(parts.join(''), 'base64')),
  { env: { abort() { throw new Error('CSV WASM aborted'); } } }
);
const wasm = instance.exports;
const memory = wasm.memory;
const INPUT = 0x100000 + 128;
const enc = new TextEncoder();
const MAX_BYTES = 0x7fff0000;

function encodeWtf8(text, out) {
  let p = 0;
  for (let i = 0; i < text.length; i++) {
    let c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + d - 0xdc00;
        i++;
      }
    }
    if (c < 0x80) out[p++] = c;
    else if (c < 0x800) { out[p++] = 0xc0 | (c >>> 6); out[p++] = 0x80 | (c & 63); }
    else if (c < 0x10000) { out[p++] = 0xe0 | (c >>> 12); out[p++] = 0x80 | ((c >>> 6) & 63); out[p++] = 0x80 | (c & 63); }
    else { out[p++] = 0xf0 | (c >>> 18); out[p++] = 0x80 | ((c >>> 12) & 63); out[p++] = 0x80 | ((c >>> 6) & 63); out[p++] = 0x80 | (c & 63); }
  }
  return p;
}

function decodeWtf8(bytes) {
  const chunks = [];
  const units = [];
  for (let i = 0; i < bytes.length;) {
    let c = bytes[i++];
    if (c >= 0xf0) c = ((c & 7) << 18) | ((bytes[i++] & 63) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
    else if (c >= 0xe0) c = ((c & 15) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
    else if (c >= 0xc0) c = ((c & 31) << 6) | (bytes[i++] & 63);
    if (c > 0xffff) { c -= 0x10000; units.push(0xd800 | (c >>> 10), 0xdc00 | (c & 1023)); }
    else units.push(c);
    if (units.length >= 8192) { chunks.push(String.fromCharCode(...units)); units.length = 0; }
  }
  if (units.length) chunks.push(String.fromCharCode(...units));
  return chunks.join('');
}

/** The answer for one case as a JSON string (no JSON.parse). */
export function runJson(input) {
  const text = String(input.text);
  const wellFormed = text.isWellFormed();
  // UTF-8 bytes are at most 3x the UTF-16 length (a surrogate pair is 2 units -> 4 bytes).
  const maxBytes = text.length * 3 + 32;
  const required = INPUT + maxBytes + 32;
  if (required > MAX_BYTES) throw new RangeError('CSV input exceeds the parser memory limit');
  if (memory.buffer.byteLength < required) {
    memory.grow(Math.ceil((required - memory.buffer.byteLength) / 65536));
  }
  let byteLength;
  if (wellFormed) {
    byteLength = enc.encodeInto(text, new Uint8Array(memory.buffer, INPUT, maxBytes)).written;
  } else {
    byteLength = encodeWtf8(text, Buffer.from(memory.buffer, INPUT, maxBytes));
  }
  const resultPointer = wasm.parse(INPUT, byteLength, input.header === true ? 1 : 0) >>> 0;
  const resultLength = wasm.outputLength() >>> 0;
  const result = Buffer.from(memory.buffer, resultPointer, resultLength);
  return wellFormed ? result.toString('utf8') : decodeWtf8(result);
}

/** The solve.js API: the answer as an object. */
export function run(input) {
  return JSON.parse(runJson(input));
}
