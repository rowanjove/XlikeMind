import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, readdir, mkdir, writeFile, mkdtemp, rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import JSZip from 'jszip';

const root = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
execFileSync(process.execPath, [path.join(root, 'scripts/verify-dist.mjs')], {stdio: 'inherit'});
const zip = new JSZip();
const date = new Date('2026-01-01T00:00:00Z');
async function addDirectory(directory, prefix) {
  for (const entry of (await readdir(directory, {withFileTypes: true})).sort((a,b)=>a.name.localeCompare(b.name))) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await addDirectory(file, `${prefix}${entry.name}/`);
    else zip.file(`${prefix}${entry.name}`, await readFile(file), {date, createFolders: false});
  }
}
await addDirectory(path.join(root, 'dist'), 'extension/');
zip.file('LICENSE', await readFile(path.join(root, 'LICENSE')), {date});
const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
const notices = ['XlikeMind third-party notices', 'Production dependency license texts; may include dependencies removed by bundling.', 'JSZip is used under its MIT licensing option.'];
for (const [location, metadata] of Object.entries(lock.packages).sort(([a],[b])=>a.localeCompare(b))) {
  if (!location.startsWith('node_modules/') || metadata.dev) continue;
  const directory = path.join(root, location);
  const info = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  const licenseFiles = (await readdir(directory)).filter(name => /^(?:license|copying|notice)(?:\.|$)/i.test(name)).sort();
  notices.push(`\n${'='.repeat(72)}\n${info.name}@${info.version} (${info.license || 'see license text'})`);
  if (!licenseFiles.length) {
    const readme = (await readdir(directory)).find(name => /^readme(?:\.|$)/i.test(name));
    const content = readme ? await readFile(path.join(directory, readme), 'utf8') : '';
    const section = content.match(/^#{1,6}\s+licen[cs]e\s*$/im);
    const license = section ? content.slice(section.index) : '';
    assert.ok(/Permission is hereby granted/i.test(license) && /copyright/i.test(license), `License text missing for ${info.name}`);
    notices.push(`\n--- ${readme} license section ---\n${license}`);
  }
  for (const name of licenseFiles) notices.push(`\n--- ${name} ---\n${await readFile(path.join(directory, name), 'utf8')}`);
}
const noticeText = notices.join('\n') + '\n';
zip.file('THIRD_PARTY_NOTICES.txt', noticeText, {date});
zip.file('INSTALL.md', await readFile(path.join(root, 'docs/releases/INSTALL.md')), {date});
const bytes = await zip.generateAsync({type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: {level: 6}});
const reopened = await JSZip.loadAsync(bytes, {checkCRC32: true});
assert.equal(Object.keys(reopened.files).length, Object.keys(zip.files).length);
const temporary = await mkdtemp(path.join(os.tmpdir(), 'xlikemind-release-'));
try {
  for (const [name, entry] of Object.entries(reopened.files)) {
    assert.ok(!entry.dir && !name.includes('..') && !name.includes('\\') && !name.startsWith('/'));
    const extracted = await entry.async('nodebuffer');
    const expected = await zip.file(name).async('nodebuffer');
    assert.ok(extracted.equals(expected), `ZIP bytes differ: ${name}`);
    const target = path.join(temporary, name);
    await mkdir(path.dirname(target), {recursive: true});
    await writeFile(target, extracted);
  }
  execFileSync(process.execPath, [path.join(root, 'scripts/verify-dist.mjs'), path.join(temporary, 'extension')], {stdio: 'inherit'});
  if (process.argv.includes('--smoke')) {
    execFileSync(process.execPath, [path.join(root, 'scripts/verify-native-popup.mjs')], {
      stdio: 'inherit', env: {...process.env, LIKEMIND_EXTENSION_DIST: path.join(temporary, 'extension')},
    });
  }
} finally {
  assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temporary).startsWith('xlikemind-release-'));
  await rm(temporary, {recursive: true});
}
const destination = path.join(root, 'release');
await mkdir(destination, {recursive: true});
const filename = `XlikeMind-v${pkg.version}-chrome.zip`;
const sha = createHash('sha256').update(bytes).digest('hex');
await writeFile(path.join(destination, filename), bytes);
await writeFile(path.join(destination, 'SHA256SUMS.txt'), `${sha}  ${filename}\n`);
await writeFile(path.join(destination, 'THIRD_PARTY_NOTICES.txt'), noticeText);
await writeFile(path.join(destination, 'RELEASE_NOTES.md'), await readFile(path.join(root, `docs/releases/v${pkg.version}.md`)));
console.log(JSON.stringify({archive: filename, bytes: bytes.length, sha256: sha, crcAndExtractedArtifact: 'PASS'}, null, 2));
