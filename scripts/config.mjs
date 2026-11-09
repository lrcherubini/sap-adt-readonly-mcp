// npm run config -- <command>: the only writer of the environment store (lib/config-cli.mjs).
// `npm run config` with no command prints the usage.

import { main } from '../lib/config-cli.mjs';

process.exitCode = main(process.argv.slice(2));
