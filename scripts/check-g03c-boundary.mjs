import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const sourceRoot = path.join(root, 'src');
const graphRoots = [
  path.join(sourceRoot, 'access', 'domain'),
  path.join(sourceRoot, 'access', 'application'),
];
const forbiddenDependency = /nestjs|express|mongodb|jsonwebtoken|(^|[-_/])auth([-_/]|$)|(^|[-_/])http([-_/]|$)/iu;
const rawComparison = /(?:^|[\\/])comparison[\\/](?:index|frame-codec|digests|recognition-input|comparison-capability)\.js$/u;

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(fullPath));
    else if (entry.isFile() && fullPath.endsWith('.ts')) files.push(fullPath);
  }
  return files;
}

function importsOf(source) {
  const imports = [];
  const pattern = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/gu;
  for (const match of source.matchAll(pattern)) imports.push(match[1]);
  return imports;
}

async function resolveLocal(importer, specifier) {
  if (!specifier.startsWith('.')) return null;
  const base = path.resolve(path.dirname(importer), specifier.replace(/\.js$/u, '.ts'));
  try {
    await readFile(base);
    return base;
  } catch {
    const index = path.join(base.replace(/\.ts$/u, ''), 'index.ts');
    try {
      await readFile(index);
      return index;
    } catch {
      return null;
    }
  }
}

const selected = new Set((await Promise.all(graphRoots.map(filesUnder))).flat());
const queue = [...selected];
const visited = new Set();
const edges = [];
const violations = [];
const directRawImports = [];

while (queue.length > 0) {
  const importer = queue.shift();
  if (visited.has(importer)) continue;
  visited.add(importer);
  const source = await readFile(importer, 'utf8');
  for (const specifier of importsOf(source)) {
    edges.push({ importer, specifier });
    if (forbiddenDependency.test(specifier)) {
      violations.push(`${path.relative(root, importer)} -> ${specifier}`);
    }
    const local = await resolveLocal(importer, specifier);
    if (local !== null) {
      if (!selected.has(local)) selected.add(local);
      queue.push(local);
      if (!importer.includes(`${path.sep}comparison${path.sep}`) && rawComparison.test(specifier)) {
        directRawImports.push(`${path.relative(root, importer)} -> ${specifier}`);
      }
    }
  }
}

console.log(`G03c import graph selected=${visited.size} edges=${edges.length} forbidden=${violations.length} directRawComparison=${directRawImports.length}`);
if (violations.length > 0 || directRawImports.length > 0 || visited.size === 0) {
  for (const violation of violations) console.error(`forbidden dependency: ${violation}`);
  for (const violation of directRawImports) console.error(`direct raw comparison import: ${violation}`);
  process.exitCode = 1;
}
