'use strict';
const path = require('path');
const fs = require('fs');

// Minimal runner: no mocha, matching the repo's dependency-free testing style.
// Collects failures and reports them all rather than stopping at the first.
exports.run = async function run() {
  const dir = __dirname;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.cjs'));
  const failures = [];
  let passed = 0;

  for (const file of files) {
    const mod = require(path.join(dir, file));
    for (const [name, fn] of Object.entries(mod.tests || {})) {
      try {
        await fn();
        console.log(`  ✔ ${name}`);
        passed++;
      } catch (err) {
        console.log(`  ✖ ${name}\n      ${err.message}`);
        failures.push(`${name}: ${err.message}`);
      }
    }
  }

  console.log(`\n  ${passed} passed, ${failures.length} failed`);
  if (failures.length) throw new Error(`${failures.length} integration test(s) failed`);
};
