// SPDX-License-Identifier: Apache-2.0
// Shared conservative segment policy. It cannot identify every secret in text.
const SENSITIVE_NAMES = new Set([
  '.git', '.hg', '.svn', '.ssh', '.aws', '.azure', '.gnupg', '.kube', '.config',
  '.npmrc', '.netrc', '_netrc', '.pypirc', '.git-credentials',
  'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'id_xmss', 'id_ecdsa_sk', 'id_ed25519_sk',
]);
const ENV_TEMPLATES = new Set(['.env.example', '.env.sample', '.env.template']);

export function isSensitiveSegment(value) {
  const name = value.toLowerCase();
  return SENSITIVE_NAMES.has(name) || name.startsWith('.openaster') || /\.(?:pem|key|p12|pfx)$/u.test(name)
    || ((name === '.env' || name.startsWith('.env.')) && !ENV_TEMPLATES.has(name));
}
