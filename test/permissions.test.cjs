'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { shouldAutoApprove } = require('../src/permissions.cjs');

test('global autoApprove overrides everything', () => {
  assert.strictEqual(shouldAutoApprove('run_command', { autoApprove: true, autoApproveTools: [] }), true);
});

test('per-tool allowlist works independently of the global switch', () => {
  const policy = { autoApprove: false, autoApproveTools: ['write_file'] };
  assert.strictEqual(shouldAutoApprove('write_file', policy), true);
  assert.strictEqual(shouldAutoApprove('run_command', policy), false);
});

test('defaults to requiring approval when policy is empty/missing', () => {
  assert.strictEqual(shouldAutoApprove('write_file', {}), false);
  assert.strictEqual(shouldAutoApprove('write_file', undefined), false);
});
