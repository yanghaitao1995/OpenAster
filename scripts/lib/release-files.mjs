// SPDX-License-Identifier: Apache-2.0
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const forbiddenName = name => name.startsWith('.env') || /\.(?:pem|key|p12|pfx|keystore|jks|log|bak|sqlite|db)$/i.test(name);
const normalized = value => value.split(path.sep).join('/');

/** Enumerate only maintained source inputs. Local data and arbitrary docs never enter a release. */
export async function collectReleaseFiles(root, policy) {
  root = path.resolve(root);
  const excluded = new Set(policy.excludedDirectories);
  const files = new Set();
  const extension = new Set(policy.sourceExtensions);
  async function inspect(relative, { recursive = false, extensions = extension, optional = false } = {}) {
    if (typeof relative !== 'string' || !relative || relative.includes('\\') || relative.startsWith('/') || relative.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid release path');
    if (relative.split('/').some(part => excluded.has(part)) || policy.excludedPaths.some(item => relative === item || relative.startsWith(item + '/'))) return;
    const full = path.resolve(root, relative);
    if (!full.startsWith(root + path.sep)) throw new Error('Release input escaped project');
    let stat;
    try { stat = await lstat(full); } catch (error) { if (optional && error.code === 'ENOENT') return; throw error; }
    if (stat.isSymbolicLink()) throw new Error(`Linked release input: ${relative}`);
    if (stat.isDirectory()) {
      if (!recursive) throw new Error(`Expected release file: ${relative}`);
      for (const entry of (await readdir(full)).sort()) await inspect(relative + '/' + entry, { recursive, extensions });
    } else if (stat.isFile()) {
      if (stat.nlink !== 1 || forbiddenName(path.basename(relative))) throw new Error(`Unsafe release input: ${relative}`);
      if (!recursive || extensions.has(path.extname(relative)) || relative === 'mobile/.gitignore') files.add(relative);
      else throw new Error(`Unreviewed release file type: ${relative}`);
    } else throw new Error(`Nonregular release input: ${relative}`);
  }
  for (const file of policy.rootFiles) await inspect(file);
  for (const directory of policy.sourceDirectories) await inspect(directory, { recursive: true });
  for (const file of policy.documents) await inspect(file);
  await inspect(policy.mediaDirectory, { recursive: true, extensions: new Set(policy.mediaExtensions), optional: true });
  return [...files].map(normalized).sort();
}

export async function loadReleasePolicy(root) {
  const policy = JSON.parse(await readFile(path.join(root, 'config/release-policy.json'), 'utf8'));
  if (policy.schemaVersion !== 1) throw new Error('Unsupported release policy');
  for (const key of ['rootFiles', 'sourceDirectories', 'excludedDirectories', 'excludedPaths', 'sourceExtensions', 'documents', 'mediaExtensions']) {
    if (!Array.isArray(policy[key]) || policy[key].some(value => typeof value !== 'string' || !value)) throw new Error('Invalid release policy');
  }
  return policy;
}
