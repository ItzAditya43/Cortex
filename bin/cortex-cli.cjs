#!/usr/bin/env node
// Entry point for the Cortex command-line agent. Everything lives in
// src/cli.cjs so it can be unit-tested; this file only starts it.

'use strict';

require('../src/cli.cjs')
  .main()
  .then((code) => {
    // Let stdout drain before exiting: a piped consumer must get the whole answer.
    process.exitCode = code;
    if (process.stdout.writableNeedDrain) process.stdout.once('drain', () => process.exit(code));
    else setImmediate(() => process.exit(code));
  })
  .catch((err) => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
