// csv-core.ts
// UTF-16LE CSV -> UTF-8 JSON, preserving lone surrogates as WTF-8.
// parseJson additionally accepts the raw contents of a JSON string.
// No managed allocations during decoding or parsing.

const MAX_BYTES: usize = 0x7fff0000;

let arena: usize = 0;
let mainBuf: usize = 0;
let errorBuf: usize = 0;
let extraBuf: usize = 0;
let scratch: usize = 0;
let recordLine: u32 = 1;
let recordRow: i32 = 0;

@inline
function size(b: usize): usize {
  return load<usize>(b + 4);
}

@inline
function setSize(b: usize, n: usize): void {
  store<usize>(b + 4, n);
}

function allocate(n: usize): usize {
  const total: u64 = <u64>arena + <u64>n;
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

// Only called with static ASCII literals.
function ascii(b: usize, s: string): void {
  const n = s.length;
  const p = reserve(b, <usize>n);

  for (let i = 0; i < n; ++i) {
    store<u8>(p + <usize>i, <u8>s.charCodeAt(i));
  }
}

function unsignedDecimal(b: usize, value: u32): void {
  const end = scratch + 16;
  let p = end;

  do {
    --p;
    store<u8>(p, <u8>(48 + value % 10));
    value /= 10;
  } while (value != 0);

  append(b, p, end - p);
}

function beginError(code: string): void {
  if (size(errorBuf) != 0) put(errorBuf, 44);

  ascii(errorBuf, '{"code":"');
  ascii(errorBuf, code);
  ascii(errorBuf, '","line":');
  unsignedDecimal(errorBuf, recordLine);
  ascii(errorBuf, ',"row":');

  if (recordRow < 0) {
    ascii(errorBuf, "null");
  } else {
    unsignedDecimal(errorBuf, <u32>recordRow);
  }
}

function fieldError(code: string): void {
  beginError(code);
  put(errorBuf, 125);
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

// The caller guarantees at least six writable bytes.
@inline
function writeEscaped(p: usize, c: u8): usize {
  if (c == 34 || c == 92) {
    store<u16>(p, <u16>(92 | (<u32>c << 8)));
    return p + 2;
  }

  if (c < 32) {
    let shortEscape: u8 = 0;

    if (c == 8) shortEscape = 98;
    else if (c == 9) shortEscape = 116;
    else if (c == 10) shortEscape = 110;
    else if (c == 12) shortEscape = 102;
    else if (c == 13) shortEscape = 114;

    if (shortEscape != 0) {
      store<u16>(p, <u16>(92 | (<u32>shortEscape << 8)));
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

// Unpaired surrogates deliberately take the three-byte path.
// The caller guarantees at least four writable bytes.
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

// Decode raw JSON-string contents, excluding their surrounding quotes.
//
// The loader stages source at destination + byteLength + 32.
// Since decoding emits at most two bytes per consumed source byte,
// every speculative 32-byte store remains before unread source bytes.
// Destination needs 2 * byteLength + 32 writable bytes.
//
// Each \uXXXX writes exactly one UTF-16 code unit. Adjacent surrogate
// escapes therefore become the same UTF-16 pair as literal UTF-8;
// the CSV parser combines pairs and preserves unpaired units.
function decodeJsonString(
  source: usize,
  byteLength: usize,
  destination: usize
): usize {
  let p = source;
  const limit = source + byteLength;
  let out = destination;

  while (p < limit) {
    if (limit - p >= 16) {
      const v = v128.load(p);
      const mask = <u32>i8x16.bitmask(
        v128.or(
          i8x16.lt_s(v, i8x16.splat(32)),
          v128.or(
            i8x16.eq(v, i8x16.splat(92)),
            i8x16.eq(v, i8x16.splat(34))
          )
        )
      );

      v128.store(out, i16x8.extend_low_i8x16_u(v));
      v128.store(out + 16, i16x8.extend_high_i8x16_u(v));

      if (mask == 0) {
        p += 16;
        out += 32;
        continue;
      }

      const count = <usize>ctz<u32>(mask);
      p += count;
      out += count << 1;
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

      store<u16>(out, <u16>c);
      out += 2;
      continue;
    }

    if (c < 0x80) {
      if (c < 32 || c == 34) unreachable();
      store<u16>(out, <u16>c);
      out += 2;
      continue;
    }

    let codePoint: u32 = 0;

    if (c < 0xe0) {
      if (c < 0xc2 || limit - p < 1) unreachable();

      const b1: u32 = load<u8>(p);
      if ((b1 & 0xc0) != 0x80) unreachable();

      ++p;
      codePoint = ((c & 31) << 6) | (b1 & 63);
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

      p += 2;
      codePoint = ((c & 15) << 12) | ((b1 & 63) << 6) | (b2 & 63);
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

      p += 3;
      codePoint =
        ((c & 7) << 18) |
        ((b1 & 63) << 12) |
        ((b2 & 63) << 6) |
        (b3 & 63);
    }

    if (codePoint < 0x10000) {
      store<u16>(out, <u16>codePoint);
      out += 2;
    } else {
      codePoint -= 0x10000;
      store<u32>(
        out,
        (0xd800 | (codePoint >> 10)) |
        ((0xdc00 | (codePoint & 1023)) << 16)
      );
      out += 4;
    }
  }

  return out - destination;
}

@inline
function pack16(p: usize): v128 {
  return i8x16.narrow_i16x8_u(v128.load(p), v128.load(p + 16));
}

// One bit per original UTF-16 code unit. Signed saturation followed
// by the signed comparison rejects every non-ASCII code unit.
@inline
function plainMask(v: v128): u32 {
  return <u32>i8x16.bitmask(
    v128.or(
      v128.or(
        i8x16.lt_s(v, i8x16.splat(32)),
        i8x16.eq(v, i8x16.splat(34))
      ),
      v128.or(
        i8x16.eq(v, i8x16.splat(44)),
        i8x16.eq(v, i8x16.splat(92))
      )
    )
  );
}

// inputPtr addresses UTF-16LE input, with 128 writable bytes before it
// and at least 32 writable bytes after it.
export function parse(
  inputPtr: usize,
  byteLength: usize,
  header: i32
): usize {
  mainBuf = inputPtr - 128;
  errorBuf = inputPtr - 112;
  extraBuf = inputPtr - 96;
  scratch = inputPtr - 64;

  let pos = inputPtr;
  const limit = inputPtr + byteLength;

  arena = (limit + 47) & <usize>0xfffffff0;

  v128.store(limit, i16x8.splat(0));
  v128.store(limit + 16, i16x8.splat(0));

  const cache = scratch + 32;
  v128.store(cache + 16, i16x8.splat(0));

  let cachedStart = limit + 32;
  let cachedMask: u32 = 0;

  let initialCapacity = byteLength + (byteLength >> 1) + 1024;
  if (initialCapacity < 4096) initialCapacity = 4096;

  initBuffer(mainBuf, initialCapacity);
  initBuffer(errorBuf, 4096);
  initBuffer(extraBuf, 1024);

  let line: u32 = 1;
  recordLine = 1;
  recordRow = 0;

  // 0 = comma, 1 = newline, 2 = EOF.
  let ended: i32 = 2;
  let width: i32 = -1;
  let rowCount: i32 = 0;

  if (header != 0) {
    ascii(mainBuf, '{"columns":');
  } else {
    ascii(mainBuf, '{"columns":null,"rows":[');
  }

  if (byteLength >= 2 && load<u16>(inputPtr) == 0xfeff) {
    pos += 2;
  }

  while (pos < limit) {
    while (pos < limit) {
      const c = load<u16>(pos);

      if (c == 10) {
        pos += 2;
        ++line;
      } else if (
        c == 13 &&
        pos + 2 < limit &&
        load<u16>(pos + 2) == 10
      ) {
        pos += 4;
        ++line;
      } else {
        break;
      }
    }

    if (pos == limit) break;

    const isHeader = header != 0 && width < 0;
    recordLine = line;
    recordRow = isHeader ? -1 : rowCount;

    const recordMark = size(mainBuf);

    if (!isHeader && rowCount != 0) {
      store<u16>(reserve(mainBuf, 2), 0x5b2c);
    } else {
      put(mainBuf, 91);
    }

    setSize(extraBuf, 0);

    let target = mainBuf;
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

        target = extraBuf;
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

      const wasQuoted = load<u16>(pos) == 34;
      let quotedMode = wasQuoted;
      let closed = false;
      let tailMark: usize = 0;

      let p = pos;
      if (wasQuoted) p += 2;

      for (;;) {
        if (outEnd - out < 48) {
          const used = out - outBase;
          setSize(target, used);
          growBuffer(target, used + 48);

          outBase = load<usize>(target);
          out = outBase + used;
          outEnd = outBase + load<usize>(target + 8);
        }

        let count: usize;
        const cachedDistance = p - cachedStart;

        if (cachedDistance < 32) {
          const skip = cachedDistance >> 1;
          const mask = cachedMask >> <u32>skip;

          v128.store(out, v128.load(cache + skip));

          if (mask == 0) {
            const remaining = <usize>16 - skip;
            p += remaining << 1;
            out += remaining;
            continue;
          }

          count = <usize>ctz<u32>(mask);
        } else {
          const v0 = pack16(p);
          let mask = plainMask(v0);
          v128.store(out, v0);

          if (mask != 0) {
            cachedStart = p;
            cachedMask = mask;
            v128.store(cache, v0);
            count = <usize>ctz<u32>(mask);
          } else {
            const v1 = pack16(p + 32);
            mask = plainMask(v1);
            v128.store(out + 16, v1);

            if (mask == 0) {
              p += 64;
              out += 32;
              continue;
            }

            cachedStart = p + 32;
            cachedMask = mask;
            v128.store(cache, v1);
            count = 16 + <usize>ctz<u32>(mask);
          }
        }

        p += count << 1;
        out += count;

        let c: u32 = load<u16>(p);

        if (c == 44) {
          p += 2;

          if (!quotedMode) {
            ended = 0;
            break;
          }

          store<u8>(out, 44);
          ++out;
          continue;
        }

        if (quotedMode && c == 34) {
          if (load<u16>(p + 2) == 34) {
            p += 4;
            store<u16>(out, 0x225c);
            out += 2;
            continue;
          }

          p += 2;
          quotedMode = false;
          closed = true;
          tailMark = out - outBase;
          continue;
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

        if (c == 10) {
          p += 2;
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
          p += 2;
          const crlf = load<u16>(p) == 10;

          if (crlf) p += 2;

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
          do {
            p += 2;

            if ((c & 0xfc00) == 0xd800) {
              const d: u32 = load<u16>(p);

              if ((d & 0xfc00) == 0xdc00) {
                p += 2;
                c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
              }
            }

            out = writeUtf8(out, c);
            c = load<u16>(p);
          } while (c >= 0x80 && outEnd - out >= 4);

          continue;
        }

        p += 2;
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
      setSize(mainBuf, recordMark);
      continue;
    }

    if (width < 0) width = fields;

    if (isHeader) {
      put(mainBuf, 93);
      ascii(mainBuf, ',"rows":[');
      continue;
    }

    if (fields < width) {
      beginError("short_row");
      ascii(errorBuf, ',"fields":');
      unsignedDecimal(errorBuf, <u32>fields);
      put(errorBuf, 125);

      const paddingBytes = <u64>(width - fields) * 3;
      if (paddingBytes > <u64>MAX_BYTES) unreachable();

      let padding = reserve(mainBuf, <usize>paddingBytes);

      for (let i = fields; i < width; ++i) {
        store<u16>(padding, 0x222c);
        store<u8>(padding + 2, 34);
        padding += 3;
      }
    } else if (fields > width) {
      beginError("long_row");
      ascii(errorBuf, ',"extra":[');
      append(errorBuf, load<usize>(extraBuf), size(extraBuf));
      ascii(errorBuf, "]}");
    }

    put(mainBuf, 93);
    ++rowCount;
  }

  if (header != 0 && width < 0) {
    ascii(mainBuf, '[],"rows":[');
  }

  ascii(mainBuf, '],"errors":[');
  append(mainBuf, load<usize>(errorBuf), size(errorBuf));
  ascii(mainBuf, "]}");

  return load<usize>(mainBuf);
}

// Raw UTF-8 JSON-string contents live at source, without outer quotes.
// Required layout:
//   inputPtr >= 128
//   source == inputPtr + byteLength + 32
//   memory covers [inputPtr - 128, source + byteLength)
//
// Decoding finishes before parse reuses the source region for output.
export function parseJson(
  source: usize,
  byteLength: usize,
  inputPtr: usize,
  header: i32
): usize {
  const decodedLength = decodeJsonString(source, byteLength, inputPtr);
  return parse(inputPtr, decodedLength, header);
}

export function outputLength(): usize {
  return size(mainBuf);
}
