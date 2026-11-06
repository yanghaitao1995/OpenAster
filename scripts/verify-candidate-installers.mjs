// SPDX-License-Identifier: Apache-2.0
// No installer URL, source path or output path arguments are accepted.
import { main } from './verify-release-installers.mjs';

if (process.argv.length !== 2) throw new Error('Candidate acceptance takes no command-line arguments');
await main({ candidate: true });
