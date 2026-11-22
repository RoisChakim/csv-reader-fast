// CSV -> JSON transducer. No managed allocations during parsing.
// Input/output use UTF-8, with WTF-8 permitted for lone surrogates.
// Structural CSV characters are ASCII, so both encodings parse identically.

const MAX_BYTES: usize = 0x7fff0000;

let arena: usize = 0;

let mainBuf: usize = 0;
let errorBuf: usize = 0;
let extraBuf: usize = 0;
let scratch: usize = 0;

let recordLine: u32 = 1;
let recordRow: i32 = 0;

// Buffer descriptor: pointer, length, capacity; each is four bytes.

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

// Only called with ASCII literals.
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

// Write one byte as JSON string content.
// The caller guarantees at least six writable bytes.
// Return the first byte after the written content.
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

    store<u32>(p, 0x3030755c); // \u00, little endian
    store<u8>(p + 4, hexDigit(<u32>c >> 4));
    store<u8>(p + 5, hexDigit(<u32>c & 15));
    return p + 6;
  }

  store<u8>(p, c);
  return p + 1;
}

// delimiter is constant at each call:
// 44 for unquoted content, 34 for quoted content.
@inline
function plainMask(p: usize, delimiter: i8): u32 {
  const v = v128.load(p);

  return <u32>i8x16.bitmask(
    v128.or(
      v128.or(
        i8x16.lt_u(v, i8x16.splat(32)),
        i8x16.eq(v, i8x16.splat(34))
      ),
      v128.or(
        i8x16.eq(v, i8x16.splat(92)),
        i8x16.eq(v, i8x16.splat(delimiter))
      )
    )
  );
}

// Scan up to 64 bytes per iteration, stopping after each vector.
//
// Every subsequent load is guarded by the preceding vector's mask.
// Consequently, the existing sixteen-byte zero sentinel is sufficient:
// a vector containing the input end always stops the scan.
@inline
function plainEnd(p: usize, delimiter: i8): usize {
  for (;;) {
    let mask = plainMask(p, delimiter);
    if (mask != 0) return p + <usize>ctz<u32>(mask);

    mask = plainMask(p + 16, delimiter);
    if (mask != 0) return p + 16 + <usize>ctz<u32>(mask);

    mask = plainMask(p + 32, delimiter);
    if (mask != 0) return p + 32 + <usize>ctz<u32>(mask);

    mask = plainMask(p + 48, delimiter);
    if (mask != 0) return p + 48 + <usize>ctz<u32>(mask);

    p += 64;
  }

  return p;
}

export function parse(
  start: usize,
  length: usize,
  withHeader: i32
): usize {
  mainBuf = start - 128;
  errorBuf = start - 112;
  extraBuf = start - 96;
  scratch = start - 64;

  let pos = start;
  const limit = start + length;
  arena = (limit + 31) & <usize>0xfffffff0;

  // The JS caller reserves input length plus at least 32 bytes.
  v128.store(limit, i8x16.splat(0));

  let initialCapacity = length + (length >> 1) + 1024;
  if (initialCapacity < 4096) initialCapacity = 4096;

  initBuffer(mainBuf, initialCapacity);
  initBuffer(errorBuf, 4096);
  initBuffer(extraBuf, 1024);

  let line: u32 = 1;
  recordLine = 1;
  recordRow = 0;

  // 0 = comma, 1 = newline, 2 = EOF
  let ended: i32 = 2;

  let width: i32 = -1;
  let rowCount: i32 = 0;

  if (withHeader != 0) {
    ascii(mainBuf, '{"columns":');
  } else {
    ascii(mainBuf, '{"columns":null,"rows":[');
  }

  // Drop exactly one initial U+FEFF.
  if (
    length >= 3 &&
    load<u8>(start) == 0xef &&
    load<u8>(start + 1) == 0xbb &&
    load<u8>(start + 2) == 0xbf
  ) {
    pos += 3;
  }

  while (pos < limit) {
    // Empty LF/CRLF lines have no record.
    while (pos < limit) {
      const c = load<u8>(pos);

      if (c == 10) {
        ++pos;
        ++line;
      } else if (
        c == 13 &&
        pos + 1 < limit &&
        load<u8>(pos + 1) == 10
      ) {
        pos += 2;
        ++line;
      } else {
        break;
      }
    }

    if (pos == limit) break;

    const isHeader = withHeader != 0 && width < 0;
    recordLine = line;
    recordRow = isHeader ? -1 : rowCount;

    const recordMark = size(mainBuf);

    if (!isHeader && rowCount != 0) {
      store<u16>(reserve(mainBuf, 2), 0x5b2c); // ,[
    } else {
      put(mainBuf, 91);
    }

    setSize(extraBuf, 0);

    // Cache the active buffer's state across fields and spans.
    // Its descriptor is synchronized only before growth, when switching
    // to extra fields, and at the end of the record.
    let target = mainBuf;
    let outBase = load<usize>(target);
    let out = outBase + size(target);
    let outEnd = outBase + load<usize>(target + 8);

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

      // The first field in either output buffer has no separator.
      const separator = fields != 0 && fields != width;
      let prefixBytes: usize = separator ? 2 : 1;

      // Marks are offsets, so they survive output buffer relocation.
      const bodyMark = out - outBase + prefixBytes;
      const open = pos;
      const openLine = line;

      // pos may equal limit after a trailing comma. The sentinel
      // makes this load safe and identifies that field as unquoted.
      const wasQuoted = load<u8>(pos) == 34;
      let quotedMode = wasQuoted;
      let closed = false;
      let tailMark: usize = 0;

      let p = pos;
      if (wasQuoted) ++p;

      for (;;) {
        const next = quotedMode
          ? plainEnd(p, 34)
          : plainEnd(p, 44);
        const n = next - p;

        // Cover the prefix, a short SIMD store, and any escape.
        // Short stores may write past the logical output end, but
        // always remain inside this buffer's allocated capacity.
        if (n + 18 > outEnd - out) {
          const used = out - outBase;
          setSize(target, used);
          growBuffer(target, used + n + 18);

          outBase = load<usize>(target);
          out = outBase + used;
          outEnd = outBase + load<usize>(target + 8);
        }

        if (prefixBytes != 0) {
          if (prefixBytes == 2) {
            store<u16>(out, 0x222c); // ,"
          } else {
            store<u8>(out, 34);
          }

          out += prefixBytes;
          prefixBytes = 0;
        }

        // Avoid a bulk-memory operation for small fields.
        // The input sentinel permits the full sixteen-byte load.
        if (n <= 16) {
          v128.store(out, v128.load(p));
        } else {
          memory.copy(out, p, n);
        }

        out += n;
        p = next;

        // At EOF this reads the zero sentinel. EOF is distinguished
        // from an embedded NUL by comparing p with limit below.
        let c = load<u8>(p);

        if (quotedMode) {
          if (c == 34) {
            if (load<u8>(p + 1) == 34) {
              p += 2;
              store<u16>(out, 0x225c); // \"
              out += 2;
              continue;
            }

            // Closing quote. Interpret its following byte directly,
            // avoiding another SIMD scan for ordinary delimiters.
            ++p;
            quotedMode = false;
            closed = true;
            tailMark = out - outBase;
            c = load<u8>(p);
          } else {
            if (p == limit) {
              // Match the original speculative-quote rollback.
              // Re-read the opening quote as an unquoted literal.
              out = outBase + bodyMark;
              p = open;
              line = openLine;
              quotedMode = false;
              fieldError("unterminated_quote");
              continue;
            }

            ++p;

            if (c == 13) {
              if (load<u8>(p) == 10) ++p;
              ++line;
              store<u16>(out, 0x6e5c); // \n
              out += 2;
            } else {
              if (c == 10) ++line;
              out = writeEscaped(out, c);
            }

            continue;
          }
        }

        // Unquoted content, including text after a closing quote.
        if (c == 44) {
          ++p;
          ended = 0;
          break;
        }

        if (c == 10) {
          ++p;
          ++line;
          ended = 1;
          break;
        }

        if (c == 13) {
          ++p;

          if (load<u8>(p) == 10) {
            ++p;
            ++line;
            ended = 1;
            break;
          }

          fieldError("stray_cr");
          continue;
        }

        if (p == limit) {
          ended = 2;
          break;
        }

        // Usually a quote, backslash, or control byte.
        // Immediately after a closing quote it may also be the
        // first ordinary byte of junk; writeEscaped handles both.
        ++p;
        out = writeEscaped(out, c);
      }

      // Emit this after all errors encountered in the trailing text.
      // Dropped stray CRs do not constitute appended junk.
      if (closed && out - outBase != tailMark) {
        fieldError("quote_junk");
      }

      if (fields == 0) {
        firstQuoted = wasQuoted;
        firstNonempty = out - outBase != bodyMark;
      }

      // The last span's capacity check also covers this quote.
      store<u8>(out, 34);
      ++out;

      pos = p;
      ++fields;
      if (ended != 0) break;
    }

    setSize(target, out - outBase);

    // Preserve field errors, but discard CR-only empty records.
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

      // Reserve all padding once.
      const paddingBytes = <u64>(width - fields) * 3;
      if (paddingBytes > <u64>MAX_BYTES) unreachable();

      let padding = reserve(mainBuf, <usize>paddingBytes);
      for (let i = fields; i < width; ++i) {
        store<u16>(padding, 0x222c); // ,"
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

  if (withHeader != 0 && width < 0) {
    ascii(mainBuf, '[],"rows":[');
  }

  ascii(mainBuf, '],"errors":[');
  append(mainBuf, load<usize>(errorBuf), size(errorBuf));
  ascii(mainBuf, "]}");

  return load<usize>(mainBuf);
}

export function outputLength(): usize {
  return size(mainBuf);
}
