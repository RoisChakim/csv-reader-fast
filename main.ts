import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { runJson } from './solve.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8'));
const parts = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  parts[i] = runJson(cases[i].input);
}
mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'answers.json'), '[' + parts.join(',') + ']');
