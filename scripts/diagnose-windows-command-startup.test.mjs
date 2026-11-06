// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseInnerTimings, parseOuterLine } from './diagnose-windows-command-startup.mjs';

test('startup diagnostic accepts only the ordered fixed outer stages', () => {
  const stages = ['BOOTSTRAP_ENTER', 'SOURCE_READ', 'ADD_TYPE_BEGIN', 'ADD_TYPE_END', 'RUN_ENTER', 'READY'];
  for (const [i, stage] of stages.entries()) assert.deepEqual(parseOuterLine(stage === 'READY' ? stage : `DIAG\t${stage}`, i), { type: 'stage', stage });
  assert.throws(() => parseOuterLine('DIAG\tADD_TYPE_END', 0), /DIAGNOSTIC_PROTOCOL_INVALID/u);
  assert.throws(() => parseOuterLine('RAW_SECRET_OR_PATH', 0), /DIAGNOSTIC_PROTOCOL_INVALID/u);
  assert.throws(() => parseOuterLine('READY', 6), /DIAGNOSTIC_PROTOCOL_INVALID/u);
});

test('startup diagnostic retains bounded timing evidence but never raw stderr', () => {
  const output = Buffer.from('INNER\tINNER_ENTER\t0\t1793966400000\r\n').toString('base64');
  const secretError = Buffer.from('DO_NOT_RETAIN_SECRET').toString('base64');
  const result = parseOuterLine(`RESULT\t0\t0\t${output}\t${secretError}`, 6);
  assert.equal(result.stderrBytes, 20);
  assert.equal('stderr' in result, false);
  assert.doesNotMatch(JSON.stringify(result), /DO_NOT_RETAIN_SECRET/u);
  assert.deepEqual(parseInnerTimings(result.stdout, 1793966400000), [{ stage: 'INNER_ENTER', elapsedMs: 0, unixMs: 1793966400000 }]);
  assert.throws(() => parseOuterLine(`RESULT\t0\t1\t${output}\t`, 6), /DIAGNOSTIC_PROTOCOL_INVALID/u);
  assert.throws(() => parseOuterLine(`RESULT\t0\t0\t${Buffer.alloc(2049).toString('base64')}\t`, 6), /DIAGNOSTIC_PROTOCOL_INVALID/u);
});

test('startup diagnostic rejects reordered, unbounded or unexpected inner output', () => {
  const start = 1793966400000;
  const valid = ['INNER_ENTER', 'MANAGEMENT_IMPORT_BEGIN', 'MANAGEMENT_IMPORTED', 'GET_LOCATION_DONE', 'INNER_DONE'].map((stage, i) => `INNER\t${stage}\t${i}\t${start + i}`).join('\n') + '\n';
  assert.equal(parseInnerTimings(valid, start).length, 5);
  for (const invalid of ['ENV=private\n', valid.replace('INNER_ENTER', 'UNKNOWN'), valid.replace('MANAGEMENT_IMPORT_BEGIN', 'GET_LOCATION_DONE'), valid.replace('\t2\t', '\t999999\t'), valid.replace(String(start), String(start - 6000)), valid + 'secret']) {
    assert.throws(() => parseInnerTimings(invalid, start), /DIAGNOSTIC_PROTOCOL_INVALID/u);
  }
  assert.deepEqual(parseInnerTimings('', start), []);
});
