// lib/tool-error.mjs: a failed call is a structured answer -- a code to branch on, the message,
// and the call to make instead when there is one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolError, errorCodeOf, errorResult } from '../lib/tool-error.mjs';
import { SelectViolation } from '../lib/data-preview.mjs';

test('the code: the error s own, a refused HTTP status, the class name, or FAILED', () => {
  assert.equal(errorCodeOf(new ToolError('x', { code: 'STANDARD_OBJECT' })), 'STANDARD_OBJECT');
  assert.equal(errorCodeOf(Object.assign(new Error('x'), { code: 'ENOTFOUND' })), 'ENOTFOUND');
  assert.equal(errorCodeOf(Object.assign(new Error('x'), { notFound: true })), 'NOT_FOUND');
  assert.equal(errorCodeOf(Object.assign(new Error('x'), { status: 403 })), 'HTTP_403');
  assert.equal(errorCodeOf(new SelectViolation('x')), 'SELECT_VIOLATION');
  assert.equal(errorCodeOf(new Error('x')), 'FAILED', 'a bare Error has no better name');
  assert.equal(errorCodeOf(new ToolError('x')), 'FAILED');
  assert.equal(errorCodeOf(Object.assign(new Error('x'), { code: 'not a code' })), 'FAILED');
  assert.equal(errorCodeOf('a string'), 'FAILED');
});

test('the result: isError, the same JSON as structuredContent and as text, the signature in front', () => {
  const sig = { sid: 'DEV', client: '001', category: { read: true, code: 'T', meaning: 'test' }, role: null };
  const next = { tool: 'adt_search', arguments: { query: 'ZDEMO*' } };
  const res = errorResult(new ToolError('Object ZDEMO not found.', { code: 'NOT_FOUND', next }), sig);
  assert.equal(res.isError, true);
  assert.deepEqual(res.structuredContent, { system: sig, error: { code: 'NOT_FOUND', message: 'Object ZDEMO not found.', next } });
  assert.equal(res.content[0].text, JSON.stringify(res.structuredContent));
  const bare = errorResult(new Error('no'));
  assert.deepEqual(bare.structuredContent, { error: { code: 'FAILED', message: 'no' } }, 'no signature, no next: neither is invented');
});
