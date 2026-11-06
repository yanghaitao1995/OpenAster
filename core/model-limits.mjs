// SPDX-License-Identifier: Apache-2.0
// Application bounds, not a claim about any provider's supported token window.
export const MIN_OUTPUT_TOKENS = 128;
export const DEFAULT_MAX_OUTPUT_TOKENS = 16384;
export const MAX_OUTPUT_TOKENS = 131072;
export const MAX_MODEL_OUTPUT_BYTES = 1024 * 1024;
export const MAX_JSON_RESPONSE_BYTES = 8 * 1024 * 1024;
// Streaming envelopes repeat protocol metadata around small token deltas.
export const MAX_STREAM_RESPONSE_BYTES = 64 * 1024 * 1024;
