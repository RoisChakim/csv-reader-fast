// main.ts
import {
  openSync,
  fstatSync,
  readSync,
  writeSync,
  closeSync,
  mkdirSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  stageInput,
  findStringEnd,
  runStagedBytes,
} from './solve.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

function readSource() {
  const fd = openSync(join(inputDir, 'cases.json'), 'r');

  try {
    const bytes = stageInput(fstatSync(fd).size);
    let offset = 0;

    while (offset < bytes.byteLength) {
      const n = readSync(
        fd,
        bytes,
        offset,
        bytes.byteLength - offset,
        null,
      );
      if (n <= 0) throw new Error('Unexpected EOF in cases.json');
      offset += n;
    }

    return bytes;
  } finally {
    closeSync(fd);
  }
}

// Read directly into WASM memory. No file-sized JS buffer or input copy.
const source = readSource();
let cursor = 0;

type CaseSlice = {
  start: number;
  end: number;
  header: boolean;
};

function invalid(): never {
  throw new SyntaxError(`Invalid cases.json near byte ${cursor}`);
}

function skipWhitespace(): void {
  while (cursor < source.length) {
    const c = source[cursor];
    if (c !== 32 && c !== 9 && c !== 10 && c !== 13) return;
    ++cursor;
  }
}

function expect(c: number): void {
  skipWhitespace();
  if (source[cursor] !== c) invalid();
  ++cursor;
}

function stringEnd(start: number): number {
  const end = findStringEnd(start);
  if (end >= source.length) invalid();
  return end;
}

function hexValue(c: number): number {
  if (c >= 48 && c <= 57) return c - 48;
  c |= 32;
  return c >= 97 && c <= 102 ? c - 87 : -1;
}

function keyEquals(start: number, end: number, expected: string): boolean {
  let index = 0;

  while (start < end) {
    let c = source[start++];

    if (c === 92) {
      if (start === end) return false;
      const escape = source[start++];

      if (escape === 117) {
        if (end - start < 4) return false;
        c = 0;

        for (let i = 0; i < 4; ++i) {
          const digit = hexValue(source[start++]);
          if (digit < 0) return false;
          c = (c << 4) | digit;
        }
      } else if (escape === 34 || escape === 92 || escape === 47) {
        c = escape;
      } else if (escape === 98) {
        c = 8;
      } else if (escape === 102) {
        c = 12;
      } else if (escape === 110) {
        c = 10;
      } else if (escape === 114) {
        c = 13;
      } else if (escape === 116) {
        c = 9;
      } else {
        return false;
      }
    }

    if (
      index >= expected.length ||
      c !== expected.charCodeAt(index)
    ) {
      return false;
    }
    ++index;
  }

  return index === expected.length;
}

function skipValue(): void {
  skipWhitespace();
  const first = source[cursor];

  if (first === 34) {
    cursor = stringEnd(cursor + 1) + 1;
    return;
  }

  if (first === 123 || first === 91) {
    let depth = 1;
    ++cursor;

    while (cursor < source.length && depth !== 0) {
      const c = source[cursor++];

      if (c === 34) {
        cursor = stringEnd(cursor) + 1;
      } else if (c === 123 || c === 91) {
        ++depth;
      } else if (c === 125 || c === 93) {
        --depth;
      }
    }

    if (depth !== 0) invalid();
    return;
  }

  const start = cursor;

  while (cursor < source.length) {
    const c = source[cursor];
    if (
      c === 44 ||
      c === 93 ||
      c === 125 ||
      c === 32 ||
      c === 9 ||
      c === 10 ||
      c === 13
    ) {
      break;
    }
    ++cursor;
  }

  if (cursor === start) invalid();
}

function readBoolean(): boolean {
  skipWhitespace();

  if (
    source[cursor] === 116 &&
    source[cursor + 1] === 114 &&
    source[cursor + 2] === 117 &&
    source[cursor + 3] === 101
  ) {
    cursor += 4;
    return true;
  }

  if (
    source[cursor] === 102 &&
    source[cursor + 1] === 97 &&
    source[cursor + 2] === 108 &&
    source[cursor + 3] === 115 &&
    source[cursor + 4] === 101
  ) {
    cursor += 5;
    return false;
  }

  invalid();
}

function readInput(): CaseSlice {
  expect(123);
  skipWhitespace();

  const result: CaseSlice = {
    start: -1,
    end: -1,
    header: false,
  };

  if (source[cursor] === 125) {
    ++cursor;
  } else {
    for (;;) {
      expect(34);
      const keyStart = cursor;
      const keyEnd = stringEnd(keyStart);
      cursor = keyEnd + 1;
      expect(58);

      if (keyEquals(keyStart, keyEnd, 'text')) {
        expect(34);
        result.start = cursor;
        result.end = stringEnd(cursor);
        cursor = result.end + 1;
      } else if (keyEquals(keyStart, keyEnd, 'header')) {
        result.header = readBoolean();
      } else {
        skipValue();
      }

      skipWhitespace();
      const separator = source[cursor++];
      if (separator === 125) break;
      if (separator !== 44) invalid();
    }
  }

  if (result.start < 0) invalid();
  return result;
}

function readCase(): CaseSlice {
  expect(123);
  skipWhitespace();

  let result: CaseSlice | null = null;

  if (source[cursor] === 125) {
    ++cursor;
  } else {
    for (;;) {
      expect(34);
      const keyStart = cursor;
      const keyEnd = stringEnd(keyStart);
      cursor = keyEnd + 1;
      expect(58);

      if (keyEquals(keyStart, keyEnd, 'input')) {
        result = readInput();
      } else {
        skipValue();
      }

      skipWhitespace();
      const separator = source[cursor++];
      if (separator === 125) break;
      if (separator !== 44) invalid();
    }
  }

  if (result === null) invalid();
  return result;
}

const cases: CaseSlice[] = [];

expect(91);
skipWhitespace();

if (source[cursor] === 93) {
  ++cursor;
} else {
  for (;;) {
    cases.push(readCase());

    skipWhitespace();
    const separator = source[cursor++];
    if (separator === 93) break;
    if (separator !== 44) invalid();
  }
}

skipWhitespace();
if (cursor !== source.length) invalid();

// Only numeric ranges are used after this point. WASM may grow its
// memory during parsing without invalidating the staged input offsets.
function writeAll(fd: number, bytes: Uint8Array): void {
  let offset = 0;

  while (offset < bytes.byteLength) {
    const n = writeSync(
      fd,
      bytes,
      offset,
      bytes.byteLength - offset,
      null,
    );
    if (n <= 0) throw new Error('Unable to write answers.json');
    offset += n;
  }
}

const openArray = Uint8Array.of(91);
const comma = Uint8Array.of(44);
const closeArray = Uint8Array.of(93);

mkdirSync(outputDir, { recursive: true });
const fd = openSync(join(outputDir, 'answers.json'), 'w');

try {
  writeAll(fd, openArray);

  for (let i = 0; i < cases.length; ++i) {
    if (i !== 0) writeAll(fd, comma);

    const item = cases[i];
    writeAll(fd, runStagedBytes(item.start, item.end, item.header));
  }

  writeAll(fd, closeArray);
} finally {
  closeSync(fd);
}
