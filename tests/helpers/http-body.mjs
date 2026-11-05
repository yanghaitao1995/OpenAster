// SPDX-License-Identifier: Apache-2.0
/** Decode once after collecting bytes: HTTP chunks may split any UTF-8 code point. */
export async function readUtf8Body(source) {
  const chunks = [];
  for await (const chunk of source) chunks.push(Buffer.from(chunk));
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
}
