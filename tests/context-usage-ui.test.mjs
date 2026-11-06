// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { contextUsageText } from '../public/execution-flow.mjs';

test('context usage distinguishes estimated input, configured output ceiling and this request budget', () => {
  const text = contextUsageText({ estimatedInputTokens: 5000, contextWindowTokens: 8192,
    reservedOutputTokens: 2900, configuredOutputTokens: 131072, thresholdTokens: 6963 });
  assert.match(text, /上下文约 62%（仅输入）/u);
  assert.match(text, /输入约 5,000 \/ 窗口 8,192 token/u);
  assert.match(text, /本次输出预算 2,900（配置上限 131,072）/u);
});

test('legacy usage retains its recorded budget without inventing a configured ceiling', () => {
  const text = contextUsageText({ estimatedInputTokens: 1000, contextWindowTokens: 8192, reservedOutputTokens: 4096 });
  assert.match(text, /本次输出预算 4,096/u); assert.doesNotMatch(text, /配置上限/u);
  for (const value of [null, {}, { estimatedInputTokens: -1, contextWindowTokens: 8192 }]) assert.equal(contextUsageText(value), '');
});
