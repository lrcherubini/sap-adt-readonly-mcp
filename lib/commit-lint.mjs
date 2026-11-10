// Conventional Commits, checked without a dependency.
//
// A header is `type(scope)!: subject`. The scope and the `!` are optional. A breaking change is
// marked by the `!` or by a `BREAKING CHANGE:` footer, and the release script (lib/release.mjs)
// reads both to choose the SemVer bump. The header limit is 100 columns, the repository's
// column rule, not the customary 72: the subjects here say what changed AND why.

export const TYPES = Object.freeze([
  'feat',
  'fix',
  'perf',
  'refactor',
  'docs',
  'test',
  'build',
  'ci',
  'chore',
  'style',
  'revert',
]);

export const MAX_HEADER = 100;

const HEADER = /^(?<type>[a-z]+)(?:\((?<scope>[^()\s]+)\))?(?<bang>!)?:(?: (?<subject>.*))?$/;
const FOOTER = /^(?<token>BREAKING CHANGE|BREAKING-CHANGE|[A-Za-z-]+): (?<value>.+)$/;
const SCISSORS = /^# -+ >8 -+$/;

/** Messages git writes itself, which the convention does not cover. */
const GENERATED = [/^Merge /, /^Revert "/, /^fixup! /, /^squash! /, /^amend! /];

/** The message as git stores it: no comment lines, no verbose diff, no trailing blank lines. */
export function cleanMessage(text) {
  const lines = [];
  for (const line of String(text).replace(/\r\n?/g, '\n').split('\n')) {
    if (SCISSORS.test(line)) break;
    if (line.startsWith('#')) continue;
    lines.push(line.replace(/\s+$/, ''));
  }
  while (lines.length && !lines[0]) lines.shift();
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  return lines;
}

/**
 * @param {string} text the raw commit message
 * @returns {{header: string, type: string|null, scope: string|null, breaking: boolean,
 *   subject: string|null, body: string[], footers: {token: string, value: string}[],
 *   generated: boolean}}
 */
export function parseMessage(text) {
  const lines = cleanMessage(text);
  const header = lines[0] ?? '';
  const m = HEADER.exec(header);
  // Footers are the last paragraph, when every line of it is `Token: value`.
  let end = lines.length;
  let start = end;
  while (start > 1 && lines[start - 1]) start--;
  const last = lines.slice(start, end);
  const isFooter = start > 1 && last.length && last.every((l) => FOOTER.test(l));
  const footers = isFooter ? last.map((l) => FOOTER.exec(l).groups).map((g) => ({ ...g })) : [];
  if (isFooter) end = start;
  const body = lines.slice(1, end);
  while (body.length && !body[0]) body.shift();
  while (body.length && !body[body.length - 1]) body.pop();
  const breakingFooter = footers.some((f) => /^BREAKING[ -]CHANGE$/.test(f.token));
  return {
    header,
    type: m ? m.groups.type : null,
    scope: m ? (m.groups.scope ?? null) : null,
    breaking: Boolean(m && (m.groups.bang || breakingFooter)),
    subject: m ? (m.groups.subject ?? '') : null,
    body,
    footers,
    generated: GENERATED.some((re) => re.test(header)),
  };
}

/** @returns {string[]} the problems found; empty means the message conforms */
export function lintMessage(text) {
  const lines = cleanMessage(text);
  if (!lines.length) return ['the message is empty'];
  const msg = parseMessage(text);
  if (msg.generated) return [];
  const problems = [];
  if (msg.type === null) {
    problems.push(
      `the header "${msg.header}" is not "type(scope)!: subject" ` +
        '(scope and ! optional, one space after the colon)'
    );
  } else {
    if (!TYPES.includes(msg.type)) {
      problems.push(`unknown type "${msg.type}"; use one of: ${TYPES.join(', ')}`);
    }
    if (!msg.subject.trim()) problems.push('the subject after the colon is empty');
    else if (/^\s/.test(msg.subject)) problems.push('only one space goes after the colon');
    if (/\.$/.test(msg.subject)) problems.push('the subject ends with a period');
  }
  if (msg.header.length > MAX_HEADER) {
    problems.push(`the header is ${msg.header.length} columns, the limit is ${MAX_HEADER}`);
  }
  if (lines.length > 1 && lines[1]) problems.push('a blank line must follow the header');
  return problems;
}
