#!/usr/bin/env node
import { run } from '../src/cli.js';

run(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
}).catch((err: unknown) => {
    console.error(`jevlint: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 2;
});
