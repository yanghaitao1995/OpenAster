// SPDX-License-Identifier: Apache-2.0
export const mobileCsp = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' https:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-src 'none'; worker-src 'self'; manifest-src 'self'";

export function secureMobileHtml(html) {
  if (!/<head(?:\s[^>]*)?>/i.test(html)) throw new Error('Mobile HTML requires a head element');
  if (/http-equiv\s*=\s*["']Content-Security-Policy["']/i.test(html)) throw new Error('Unexpected existing mobile CSP: review policy before replacing');
  return html.replace(/<head(?:\s[^>]*)?>/i, head => `${head}\n  <meta http-equiv="Content-Security-Policy" content="${mobileCsp}">`);
}
