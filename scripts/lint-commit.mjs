#!/usr/bin/env node
// npm run lint:commit -- <message-file>
//
// Checks one commit message against Conventional Commits (lib/commit-lint.mjs). The git hook
// .githooks/commit-msg runs it on every commit once the hook folder is enabled:
//
//   git config core.hooksPath .githooks
//
// Exit 0 when the message conforms, 1 when it does not, 2 when the file cannot be read.

import fs from 'node:fs';
import { lintMessage, TYPES } from '../lib/commit-lint.mjs';

const file = process.argv[2];
if (!file) {
  console.error('usage: npm run lint:commit -- <message-file>');
  process.exit(2);
}
let text;
try {
  text = fs.readFileSync(file, 'utf8');
} catch (e) {
  console.error(`cannot read ${file}: ${e.message}`);
  process.exit(2);
}
const problems = lintMessage(text);
if (problems.length) {
  console.error('commit message rejected (Conventional Commits):');
  for (const p of problems) console.error(`  - ${p}`);
  console.error(`types: ${TYPES.join(', ')}. Example: "fix(guard): refuse an unlisted member"`);
  process.exitCode = 1;
}
