// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createConformanceFixtures, probeGit, verifyGitignore } from '../scripts/verify-gitignore.mjs';

test('original Git oracle inputs are deterministic and include explicit hierarchy and byte cases', () => {
  const first = createConformanceFixtures({ seed: 0x47a91c03, fuzzGroups: 24 });
  assert.deepEqual(first, createConformanceFixtures({ seed: 0x47a91c03, fuzzGroups: 24 }));
  assert.notDeepEqual(first, createConformanceFixtures({ seed: 0x47a91c04, fuzzGroups: 24 }));
  assert.ok(first.some(group => group.ignores.length > 2));
  assert.ok(first.some(group => group.ignores[0].content.includes('[[:digit:]]')));
  assert.ok(first.some(group => group.probes.some(probe => probe.path === '🙂')));
});

test('isolated native Git agrees with original ignore matcher for fixed and seeded cases', { timeout: 60000 }, async t => {
  const available = probeGit();
  if (!available.available) return t.skip(available.reason);
  const result = await verifyGitignore();
  t.diagnostic(`Git oracle: ${result.git.version}; seed=${result.seed}; probes=${result.probes}; evidence=${result.evidence}`);
  assert.equal(result.temporaryResourcesCleaned, true, result.evidence);
  assert.equal(result.sourceUnchanged, true, result.evidence);
  assert.ok(result.probes >= 1000, result.evidence);
  assert.equal(result.passed, true, `Git conformance failed; seed=${result.seed}, differences=${result.differences.length}, evidence=${result.evidence}`);
});
