// csv-core.ts
// parse: UTF-16LE CSV -> UTF-8/WTF-8 JSON.
// parseJson: raw JSON-string contents -> UTF-8/WTF-8 JSON directly.
// No intermediate decoded string and no managed allocations.
//
// parse requires 32 readable bytes after its input.
// parseJson requires 16 readable bytes after its input. Its third argument
// reserves input memory through that address; the original staging layout
// remains supported. Output always starts after all reserved input.
//
// JSON input must contain valid UTF-8 JSON-string contents, without quotes.

const MAX_BYTES: usize = 0x7fff0000;
const STATE: usize = memory.data(128);
const MAIN: usize = STATE;
const ERRORS: usize = STATE + 16;
const EXTRA: usize = STATE + 32;
const SCRATCH: usize = STATE + 64;
const CACHE: usize = STATE + 96;

let arena: usize = 0;
let recordLine: u32 = 1;
let recordRow: i32 = 0;
let nextUnit: usize = 0;

@inline
function size(b: usize): usize {
  return load<usize>(b + 4);
}

@inline
function setSize(b: usize, n: usize): void {
  store<usize>(b + 4, n);
}

function allocate(n: usize): usize {
  const total = <u64>arena + <u64>n;
  if (total > <u64>MAX_BYTES) unreachable();

  const next = (<usize>total + 15) & <usize>0xfffffff0;
  const wanted = (next + 65535) >> 16;
  const current = <usize>memory.size();

  if (wanted > current) {
    if (memory.grow(<i32>(wanted - current)) < 0) unreachable();
  }

  const result = arena;
  arena = next;
  return result;
}

function initBuffer(b: usize, capacity: usize): void {
  store<usize>(b, allocate(capacity));
  store<usize>(b + 4, 0);
  store<usize>(b + 8, capacity);
}

function growBuffer(b: usize, needed: usize): void {
  if (needed > MAX_BYTES) unreachable();

  let capacity = load<usize>(b + 8);
  while (capacity < needed) {
    if (capacity > MAX_BYTES / 2) {
      capacity = needed;
      break;
    }
    capacity <<= 1;
  }

  const p = allocate(capacity);
  const n = size(b);
  if (n != 0) memory.copy(p, load<usize>(b), n);

  store<usize>(b, p);
  store<usize>(b + 8, capacity);
}

@inline
function reserve(b: usize, n: usize): usize {
  const previous = size(b);
  if (n > MAX_BYTES - previous) unreachable();

  const needed = previous + n;
  if (needed > load<usize>(b + 8)) growBuffer(b, needed);
  setSize(b, needed);
  return load<usize>(b) + previous;
}

@inline
function put(b: usize, c: u8): void {
  store<u8>(reserve(b, 1), c);
}

@inline
function append(b: usize, source: usize, n: usize): void {
  if (n != 0) memory.copy(reserve(b, n), source, n);
}

// Static ASCII literals only.
function ascii(b: usize, s: string): void {
  const n = s.length;
  const p = reserve(b, <usize>n);

  for (let i = 0; i < n; ++i) {
    store<u8>(p + <usize>i, <u8>s.charCodeAt(i));
  }
}

function unsignedDecimal(b: usize, value: u32): void {
  const end = SCRATCH + 16;
  let p = end;

  do {
    --p;
    store<u8>(p, <u8>(48 + value % 10));
    value /= 10;
  } while (value != 0);

  append(b, p, end - p);
}

function beginError(code: string): void {
  if (size(ERRORS) != 0) put(ERRORS, 44);

  ascii(ERRORS, '{"code":"');
  ascii(ERRORS, code);
  ascii(ERRORS, '","line":');
  unsignedDecimal(ERRORS, recordLine);
  ascii(ERRORS, ',"row":');

  if (recordRow < 0) {
    ascii(ERRORS, "null");
  } else {
    unsignedDecimal(ERRORS, <u32>recordRow);
  }
}

function fieldError(code: string): void {
  beginError(code);
  put(ERRORS, 125);
}

@inline
function hexDigit(n: u32): u8 {
  return <u8>(n < 10 ? 48 + n : 87 + n);
}

@inline
function hexValue(c: u32): u32 {
  if (c >= 48 && c <= 57) return c - 48;
  c |= 32;
  if (c >= 97 && c <= 102) return c - 87;
  unreachable();
  return 0;
}

// The caller supplies six writable bytes.
@inline
function writeEscaped(p: usize, c: u8): usize {
  if (c == 34 || c == 92) {
    store<u16>(p, <u16>(92 | (<u32>c << 8)));
    return p + 2;
  }

  if (c < 32) {
    let escape: u8 = 0;

    if (c == 8) escape = 98;
    else if (c == 9) escape = 116;
    else if (c == 10) escape = 110;
    else if (c == 12) escape = 102;
    else if (c == 13) escape = 114;

    if (escape != 0) {
      store<u16>(p, <u16>(92 | (<u32>escape << 8)));
      return p + 2;
    }

    store<u32>(p, 0x3030755c);
    store<u8>(p + 4, hexDigit(<u32>c >> 4));
    store<u8>(p + 5, hexDigit(<u32>c & 15));
    return p + 6;
  }

  store<u8>(p, c);
  return p + 1;
}

// Unpaired surrogate code units deliberately use the three-byte path.
// The caller supplies four writable bytes.
@inline
function writeUtf8(p: usize, c: u32): usize {
  if (c < 0x800) {
    store<u16>(
      p,
      <u16>((0xc0 | (c >> 6)) | ((0x80 | (c & 63)) << 8))
    );
    return p + 2;
  }

  if (c < 0x10000) {
    store<u16>(
      p,
      <u16>(
        (0xe0 | (c >> 12)) |
        ((0x80 | ((c >> 6) & 63)) << 8)
      )
    );
    store<u8>(p + 2, <u8>(0x80 | (c & 63)));
    return p + 3;
  }

  store<u32>(
    p,
    (0xf0 | (c >> 18)) |
    ((0x80 | ((c >> 12) & 63)) << 8) |
    ((0x80 | ((c >> 6) & 63)) << 16) |
    ((0x80 | (c & 63)) << 24)
  );
  return p + 4;
}

// Reads one UTF-16 code unit, JSON escape, or literal UTF-8 scalar.
// nextUnit is the source position immediately after the result.
// A literal supplementary scalar is returned whole; \uXXXX always
// returns exactly one code unit so escaped surrogate pairs stay exact.
@inline
function readUnit(p: usize, limit: usize, json: bool): u32 {
  if (p >= limit) {
    nextUnit = p;
    return 0xffffffff;
  }

  if (!json) {
    nextUnit = p + 2;
    return load<u16>(p);
  }

  let c: u32 = load<u8>(p);
  ++p;

  if (c == 92) {
    if (p == limit) unreachable();

    const escape: u32 = load<u8>(p);
    ++p;

    if (escape == 117) {
      if (limit - p < 4) unreachable();

      c =
        (hexValue(load<u8>(p)) << 12) |
        (hexValue(load<u8>(p + 1)) << 8) |
        (hexValue(load<u8>(p + 2)) << 4) |
        hexValue(load<u8>(p + 3));
      p += 4;
    } else if (escape == 34 || escape == 92 || escape == 47) {
      c = escape;
    } else if (escape == 110) {
      c = 10;
    } else if (escape == 114) {
      c = 13;
    } else if (escape == 116) {
      c = 9;
    } else if (escape == 98) {
      c = 8;
    } else if (escape == 102) {
      c = 12;
    } else {
      unreachable();
    }

    nextUnit = p;
    return c;
  }

  if (c < 0x80) {
    if (c < 32 || c == 34) unreachable();
    nextUnit = p;
    return c;
  }

  let result: u32;

  if (c < 0xe0) {
    if (c < 0xc2 || limit - p < 1) unreachable();

    const b1: u32 = load<u8>(p);
    if ((b1 & 0xc0) != 0x80) unreachable();

    result = ((c & 31) << 6) | (b1 & 63);
    ++p;
  } else if (c < 0xf0) {
    if (limit - p < 2) unreachable();

    const b1: u32 = load<u8>(p);
    const b2: u32 = load<u8>(p + 1);

    if (
      (b1 & 0xc0) != 0x80 ||
      (b2 & 0xc0) != 0x80 ||
      (c == 0xe0 && b1 < 0xa0) ||
      (c == 0xed && b1 >= 0xa0)
    ) {
      unreachable();
    }

    result = ((c & 15) << 12) | ((b1 & 63) << 6) | (b2 & 63);
    p += 2;
  } else {
    if (c > 0xf4 || limit - p < 3) unreachable();

    const b1: u32 = load<u8>(p);
    const b2: u32 = load<u8>(p + 1);
    const b3: u32 = load<u8>(p + 2);

    if (
      (b1 & 0xc0) != 0x80 ||
      (b2 & 0xc0) != 0x80 ||
      (b3 & 0xc0) != 0x80 ||
      (c == 0xf0 && b1 < 0x90) ||
      (c == 0xf4 && b1 >= 0x90)
    ) {
      unreachable();
    }

    result =
      ((c & 7) << 18) |
      ((b1 & 63) << 12) |
      ((b2 & 63) << 6) |
      (b3 & 63);
    p += 3;
  }

  nextUnit = p;
  return result;
}

// Two v128 loads cover sixteen UTF-16 code units.
@inline
function pack16(p: usize): v128 {
  return i8x16.narrow_i16x8_u(v128.load(p), v128.load(p + 16));
}

// Every comma, quote, backslash, LF, CR, and other control character
// gets a bit. The UTF-16 path additionally flags every non-ASCII unit.
// Valid literal UTF-8 passes through the JSON path without conversion.
@inline
function specialMask(v: v128, json: bool): u32 {
  const controls = json
    ? i8x16.lt_u(v, i8x16.splat(32))
    : i8x16.lt_s(v, i8x16.splat(32));

  return <u32>i8x16.bitmask(
    v128.or(
      controls,
      v128.or(
        i8x16.eq(v, i8x16.splat(92)),
        v128.or(
          i8x16.eq(v, i8x16.splat(44)),
          i8x16.eq(v, i8x16.splat(34))
        )
      )
    )
  );
}

// Inlining specializes the two exported entry points for their input
// representations. JSON escapes are decoded only when encountered.
@inline
function transduce(
  inputPtr: usize,
  byteLength: usize,
  reservedEnd: usize,
  header: i32,
  json: bool
): usize {
  const inputEnd = <u64>inputPtr + <u64>byteLength;
  if (inputEnd > <u64>MAX_BYTES) unreachable();

  const limit = <usize>inputEnd;
  const last = reservedEnd > limit ? reservedEnd : limit;
  if (last > MAX_BYTES - 47) unreachable();

  arena = (last + 47) & <usize>0xfffffff0;

  const initialCapacity = <u64>byteLength * 3 + 4096;
  if (initialCapacity > <u64>MAX_BYTES) unreachable();

  initBuffer(MAIN, <usize>initialCapacity);
  initBuffer(ERRORS, 4096);
  initBuffer(EXTRA, 1024);

  const shift: u32 = json ? 0 : 1;
  const blockBytes: usize = json ? 16 : 32;

  let cachedStart = limit + 32;
  let cachedMask: u32 = 0;

  let pos = inputPtr;
  let line: u32 = 1;
  recordLine = 1;
  recordRow = 0;

  // 0 = comma, 1 = newline, 2 = EOF.
  let ended: i32 = 2;
  let width: i32 = -1;
  let rowCount: i32 = 0;

  if (header != 0) {
    ascii(MAIN, '{"columns":');
  } else {
    ascii(MAIN, '{"columns":null,"rows":[');
  }

  if (pos < limit && readUnit(pos, limit, json) == 0xfeff) {
    pos = nextUnit;
  }

  while (pos < limit) {
    while (pos < limit) {
      const c = readUnit(pos, limit, json);
      const after = nextUnit;

      if (c == 10) {
        pos = after;
        ++line;
      } else if (
        c == 13 &&
        readUnit(after, limit, json) == 10
      ) {
        pos = nextUnit;
        ++line;
      } else {
        break;
      }
    }

    if (pos == limit) break;

    const isHeader = header != 0 && width < 0;
    recordLine = line;
    recordRow = isHeader ? -1 : rowCount;

    const recordMark = size(MAIN);

    if (!isHeader && rowCount != 0) {
      store<u16>(reserve(MAIN, 2), 0x5b2c);
    } else {
      put(MAIN, 91);
    }

    setSize(EXTRA, 0);

    let target = MAIN;
    let outBase = load<usize>(target);
    let out = outBase + size(target);
    let outEnd = outBase + load<usize>(target + 8);

    if (outEnd - out < 2) {
      const used = out - outBase;
      setSize(target, used);
      growBuffer(target, used + 48);

      outBase = load<usize>(target);
      out = outBase + used;
      outEnd = outBase + load<usize>(target + 8);
    }

    let fields: i32 = 0;
    let firstQuoted = false;
    let firstNonempty = false;

    for (;;) {
      if (width >= 0 && fields == width) {
        setSize(target, out - outBase);

        target = EXTRA;
        outBase = load<usize>(target);
        out = outBase;
        outEnd = outBase + load<usize>(target + 8);
      }

      const separator = fields != 0 && fields != width;
      const prefixBytes: usize = separator ? 2 : 1;
      const bodyMark = out - outBase + prefixBytes;
      const open = pos;
      const openLine = line;

      if (separator) {
        store<u16>(out, 0x222c);
      } else {
        store<u8>(out, 34);
      }
      out += prefixBytes;

      const wasQuoted = readUnit(pos, limit, json) == 34;
      let quotedMode = wasQuoted;
      let closed = false;
      let tailMark: usize = 0;
      let p = wasQuoted ? nextUnit : pos;

      for (;;) {
        if (outEnd - out < 48) {
          const used = out - outBase;
          setSize(target, used);
          growBuffer(target, used + 48);

          outBase = load<usize>(target);
          out = outBase + used;
          outEnd = outBase + load<usize>(target + 8);
        }

        if (p == limit) {
          if (quotedMode) {
            out = outBase + bodyMark;
            p = open;
            line = openLine;
            quotedMode = false;
            fieldError("unterminated_quote");
            continue;
          }

          ended = 2;
          break;
        }

        let count: usize;
        const distance = p - cachedStart;

        if (distance < blockBytes) {
          const skip = distance >> shift;
          const mask = cachedMask >> <u32>skip;

          v128.store(out, v128.load(CACHE + skip));

          if (mask == 0) {
            const remaining = <usize>16 - skip;
            p += remaining << shift;
            out += remaining;
            continue;
          }

          count = <usize>ctz<u32>(mask);
        } else {
          const v = json ? v128.load(p) : pack16(p);
          let mask = specialMask(v, json);
          const remaining = (limit - p) >> shift;

          // A virtual delimiter terminates the final partial vector.
          // Input is never padded or overwritten.
          if (remaining < 16) {
            mask |= <u32>0xffff << <u32>remaining;
          }

          v128.store(out, v);

          if (mask == 0) {
            p += blockBytes;
            out += 16;
            continue;
          }

          // Preserve ALL delimiter bits across fields and rows.
          // Subsequent commas in this chunk need no new SIMD compares.
          cachedStart = p;
          cachedMask = mask;
          v128.store(CACHE, v);
          count = <usize>ctz<u32>(mask);
        }

        p += count << shift;
        out += count;

        if (p == limit) {
          if (quotedMode) {
            out = outBase + bodyMark;
            p = open;
            line = openLine;
            quotedMode = false;
            fieldError("unterminated_quote");
            continue;
          }

          ended = 2;
          break;
        }

        let c = readUnit(p, limit, json);
        let after = nextUnit;

        if (c == 44) {
          p = after;

          if (!quotedMode) {
            ended = 0;
            break;
          }

          store<u8>(out, 44);
          ++out;
          continue;
        }

        if (quotedMode && c == 34) {
          if (readUnit(after, limit, json) == 34) {
            p = nextUnit;
            store<u16>(out, 0x225c);
            out += 2;
            continue;
          }

          p = after;
          quotedMode = false;
          closed = true;
          tailMark = out - outBase;
          continue;
        }

        if (c == 10) {
          p = after;
          ++line;

          if (!quotedMode) {
            ended = 1;
            break;
          }

          store<u16>(out, 0x6e5c);
          out += 2;
          continue;
        }

        if (c == 13) {
          const crlf = readUnit(after, limit, json) == 10;
          p = crlf ? nextUnit : after;

          if (quotedMode) {
            ++line;
            store<u16>(out, 0x6e5c);
            out += 2;
            continue;
          }

          if (crlf) {
            ++line;
            ended = 1;
            break;
          }

          fieldError("stray_cr");
          continue;
        }

        if (c >= 0x80) {
          for (;;) {
            p = after;

            if ((c & 0xfc00) == 0xd800) {
              const d = readUnit(p, limit, json);

              if ((d & 0xfc00) == 0xdc00) {
                p = nextUnit;
                c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
              }
            }

            out = writeUtf8(out, c);
            if (p == limit || outEnd - out < 4) break;

            c = readUnit(p, limit, json);
            after = nextUnit;
            if (c < 0x80) break;
          }

          continue;
        }

        p = after;
        out = writeEscaped(out, <u8>c);
      }

      if (closed && out - outBase != tailMark) {
        fieldError("quote_junk");
      }

      if (fields == 0) {
        firstQuoted = wasQuoted;
        firstNonempty = out - outBase != bodyMark;
      }

      store<u8>(out, 34);
      ++out;

      pos = p;
      ++fields;

      if (ended != 0) break;
    }

    setSize(target, out - outBase);

    if (fields == 1 && !firstQuoted && !firstNonempty) {
      setSize(MAIN, recordMark);
      continue;
    }

    if (width < 0) width = fields;

    if (isHeader) {
      put(MAIN, 93);
      ascii(MAIN, ',"rows":[');
      continue;
    }

    if (fields < width) {
      beginError("short_row");
      ascii(ERRORS, ',"fields":');
      unsignedDecimal(ERRORS, <u32>fields);
      put(ERRORS, 125);

      const paddingBytes = <u64>(width - fields) * 3;
      if (paddingBytes > <u64>MAX_BYTES) unreachable();

      let padding = reserve(MAIN, <usize>paddingBytes);

      for (let i = fields; i < width; ++i) {
        store<u16>(padding, 0x222c);
        store<u8>(padding + 2, 34);
        padding += 3;
      }
    } else if (fields > width) {
      beginError("long_row");
      ascii(ERRORS, ',"extra":[');
      append(ERRORS, load<usize>(EXTRA), size(EXTRA));
      ascii(ERRORS, "]}");
    }

    put(MAIN, 93);
    ++rowCount;
  }

  if (header != 0 && width < 0) {
    ascii(MAIN, '[],"rows":[');
  }

  ascii(MAIN, '],"errors":[');
  append(MAIN, load<usize>(ERRORS), size(ERRORS));
  ascii(MAIN, "]}");

  return load<usize>(MAIN);
}

export function parse(
  inputPtr: usize,
  byteLength: usize,
  header: i32
): usize {
  if ((byteLength & 1) != 0) unreachable();
  return transduce(inputPtr, byteLength, inputPtr, header, false);
}

export function parseJson(
  source: usize,
  byteLength: usize,
  inputPtr: usize,
  header: i32
): usize {
  return transduce(source, byteLength, inputPtr, header, true);
}

export function outputLength(): usize {
  return size(MAIN);
}

// Envelope scanning also stays in WASM: one call per JSON string,
// instead of one JS/native call per escaped CSV quote.
// Requires sixteen readable bytes after limit; returns limit if absent.
export function jsonStringEnd(start: usize, limit: usize): usize {
  let p = start;

  while (p < limit) {
    let mask = <u32>i8x16.bitmask(
      i8x16.eq(v128.load(p), i8x16.splat(34))
    );

    const remaining = limit - p;
    if (remaining < 16) {
      mask &= (<u32>1 << <u32>remaining) - 1;
    }

    while (mask != 0) {
      const quote = p + <usize>ctz<u32>(mask);
      let back = quote;

      while (back > start && load<u8>(back - 1) == 92) {
        --back;
      }

      if (((quote - back) & 1) == 0) return quote;
      mask &= mask - 1;
    }

    p += 16;
  }

  return limit;
}
