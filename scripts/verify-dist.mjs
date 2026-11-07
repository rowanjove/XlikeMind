import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, readdir, lstat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';

const root = path.resolve(process.argv[2] || fileURLToPath(new URL('../dist', import.meta.url)));
const files = new Map();
async function collect(directory) {
  for (const name of await readdir(directory)) {
    const absolute = path.join(directory, name);
    const info = await lstat(absolute);
    assert.ok(!info.isSymbolicLink(), 'Symbolic links are not allowed in the extension artifact');
    if (info.isDirectory()) {
      assert.ok(['assets', 'icons'].includes(path.relative(root, absolute)), 'Unexpected artifact directory');
      await collect(absolute);
    }
    else {
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      assert.match(relative, /^(?:(?:manifest\.json|background\.js|content\.js|dashboard\.html|popup\.html|local-library\.html|archive-sandbox\.html)|assets\/[\w-]+\.(?:js|css)|icons\/icon(?:16|32|48|128)\.png)$/,
        `Unexpected artifact file: ${relative}`);
      files.set(relative, await readFile(absolute));
    }
  }
}
await collect(root);
function reference(from, value) {
  assert.ok(typeof value === 'string' && value.length, `Missing reference in ${from}`);
  assert.ok(!/^(?:[a-z][\w+.-]*:|\/\/|\/)/i.test(value), `Non-local reference in ${from}`);
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(from), value));
  assert.ok(!resolved.startsWith('../') && files.has(resolved), `Missing artifact dependency: ${from} -> ${value}`);
}
assert.ok(files.has('manifest.json'), 'manifest.json missing');
const manifest = JSON.parse(files.get('manifest.json').toString('utf8'));
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.version, pkg.version);
assert.equal(manifest.background?.type, 'module');
assert.ok(!manifest.permissions?.some(permission => ['debugger', 'cookies', '<all_urls>'].includes(permission)), 'Unexpected production permission');
assert.ok(!manifest.host_permissions?.some(host => ['<all_urls>', 'https://*/*', 'http://*/*', '*://*/*'].includes(host)), 'Unbounded required host permission');
reference('manifest.json', manifest.background.service_worker);
reference('manifest.json', manifest.action.default_popup);
for (const icon of Object.values(manifest.icons || {})) reference('manifest.json', icon);
for (const icon of Object.values(manifest.action.default_icon || {})) reference('manifest.json', icon);
for (const entry of manifest.content_scripts || []) {
  assert.ok(!entry.world || entry.world === 'ISOLATED', 'Content scripts must use the isolated world');
  for (const script of entry.js || []) reference('manifest.json', script);
  for (const css of entry.css || []) reference('manifest.json', css);
}
for (const entry of manifest.sandbox?.pages || []) reference('manifest.json', entry);
for (const required of ['dashboard.html', 'local-library.html', 'archive-sandbox.html', 'content.js']) reference('manifest.json', required);

for (const [name, bytes] of files) {
  const text = bytes.toString('utf8');
  if (name.endsWith('.html')) {
    for (const match of text.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)=(["'])([\s\S]*?)\1/gi)) {
      const embeddedIcon = /^<link\b/i.test(match[0]) && /\brel=(["'])icon\1/i.test(match[0]) && /^data:image\/(?:svg\+xml|png)[;,]/i.test(match[2]);
      if (!embeddedIcon) reference(name, match[2]);
    }
    if (name !== 'archive-sandbox.html') {
      for (const match of text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
        assert.ok(/\bsrc=/.test(match[1]) || !match[2].trim(), `Inline script in privileged page: ${name}`);
      }
    }
  } else if (name.endsWith('.js')) {
    for (const marker of ['generateMockPosts', 'Offline fixture 901', '人工修订样本标题', 'disk script must not execute', '__fixtureCopiedReport']) {
      assert.ok(!text.includes(marker), `Test fixture marker in ${name}`);
    }
    const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const visit = node => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        reference(name, node.moduleSpecifier.text);
      }
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        assert.ok(node.arguments.length && ts.isStringLiteral(node.arguments[0]), `Non-static bundle import in ${name}`);
        reference(name, node.arguments[0].text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  } else if (name.endsWith('.css')) {
    for (const match of text.matchAll(/url\(\s*["']?([^"')\s]+)["']?\s*\)/g)) {
      if (!match[1].startsWith('data:')) reference(name, match[1]);
    }
  }
}
const digest = createHash('sha256');
let totalBytes = 0;
for (const [name, bytes] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
  totalBytes += bytes.length;
  digest.update(name).update('\0').update(createHash('sha256').update(bytes).digest('hex')).update('\n');
}
console.log(JSON.stringify({status: 'PASS', version: manifest.version, fileCount: files.size, totalBytes, artifactSha256: digest.digest('hex')}, null, 2));
