import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Identify the bytes actually deployed, rather than trusting a manually set
 * revision that could be left unchanged when the compiled runtime changes. */
export async function sourcingReleaseVersion(): Promise<string> {
  const entry = fileURLToPath(import.meta.url);
  const sourceDirectory = dirname(entry);
  const extension = extname(entry);
  if (extension !== '.js' && extension !== '.ts') throw new Error('Unknown sourcing release format.');
  const root = extension === '.js' ? resolve(sourceDirectory, '../..') : resolve(sourceDirectory, '..');
  const packageJson = await readFile(join(root, 'package.json'));
  const pkg = JSON.parse(packageJson.toString('utf8')) as { version?: unknown };
  if (typeof pkg.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version))
    throw new Error('Invalid sourcing package version.');
  const hash = createHash('sha256');
  const add = (name: string, bytes: Buffer) => {
    hash.update(name); hash.update('\0'); hash.update(bytes); hash.update('\0');
  };
  add('package.json', packageJson);
  add('npm-shrinkwrap.json', await readFile(join(root, 'npm-shrinkwrap.json')));
  if (extension === '.js') {
    try { add('pnpm-lock.yaml', await readFile(join(root, 'pnpm-lock.yaml'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  async function addSource(directory: string): Promise<void> {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await addSource(path);
      else if (entry.isFile() && extname(entry.name) === extension)
        add(relative(root, path), await readFile(path));
      else if (entry.isSymbolicLink()) throw new Error('Sourcing release source contains a symlink.');
    }
  }
  // The owner CLI and benchmark utilities ship beside the MCP server in the
  // same immutable release. Their bytes must change the release identity too.
  if (extension === '.js') await addSource(resolve(root, 'dist-alpha'));
  else for (const directory of ['src', 'scripts', 'test']) await addSource(resolve(root, directory));
  return `${pkg.version}+code.${hash.digest('hex')}`;
}
