'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { build, readConfig, PUBLIC_FILES } = require('../scripts/build-static.cjs');
const workspace = path.resolve(__dirname, '..');
const publicSettings = { RXPX_SUPABASE_URL: 'https://example.supabase.co', RXPX_SUPABASE_ANON_KEY: 'sb_publishable_test_public_key_only' };

// A page that loads the Supabase scripts (app-config.js and friends), for the connection-settings checks.
const SUPABASE_PAGE = '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>RxPx Bills</title></head><body><div id="app"></div>\n'
  + '<script src="app-config.js"></script><script src="bill-extraction.js"></script><script src="bill-export.js"></script><script src="medical-bills.js"></script>\n</body></html>\n';

function fixture(t, page) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rxpx-static-test-'));
  for (const file of ['medical bills.html', ...PUBLIC_FILES]) fs.copyFileSync(path.join(workspace, file), path.join(root, file));
  if (page) fs.writeFileSync(path.join(root, 'medical bills.html'), page);
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('rxpx-static-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test('static output has a working index, every local script and only public application files', t => {
  const root = fixture(t, SUPABASE_PAGE);
  fs.writeFileSync(path.join(root, 'private-record.txt'), 'Never publish private workspace contents');
  fs.mkdirSync(path.join(root, 'dist'));
  fs.writeFileSync(path.join(root, 'dist', 'stale-private.txt'), 'Never keep stale output');
  const result = build({ root, env: publicSettings, requireConfig: true });
  const output = path.join(root, 'dist');
  assert.deepEqual(fs.readdirSync(output).sort(), result.files.slice().sort());
  assert.equal(result.configured, true);
  const html = fs.readFileSync(path.join(output, 'index.html'), 'utf8');
  assert.equal(html, fs.readFileSync(path.join(output, 'medical bills.html'), 'utf8'));
  for (const match of html.matchAll(/<script[^>]*src="([^"]+)"/g)) {
    if (!match[1].startsWith('https://')) assert.ok(fs.existsSync(path.join(output, match[1])));
  }
  assert.ok(!result.files.some(file => /private|backup|test|\.env|\.pdf|\.png|\.jpg/.test(file)));
  assert.match(fs.readFileSync(path.join(output, 'medical-bills.js'), 'utf8'), /₹/);
  assert.match(fs.readFileSync(path.join(output, '_headers'), 'utf8'), /Cache-Control: no-store/);
});

test('preview supports setup but production preflight blocks empty or partial connection settings', t => {
  const root = fixture(t, SUPABASE_PAGE);
  assert.equal(build({ root, env: {}, checkOnly: true }).configured, false);
  assert.throws(() => build({ root, env: {}, requireConfig: true, checkOnly: true }), /Supabase connection is missing/);
  assert.throws(() => readConfig(root, { RXPX_SUPABASE_URL: publicSettings.RXPX_SUPABASE_URL }), /Supabase connection is missing/);
  assert.equal(fs.existsSync(path.join(root, 'dist')), false, 'Preflight must not write build output');
});

test('production emits public configuration, accepts anon JWTs and never emits server environment secrets', t => {
  const root = fixture(t, SUPABASE_PAGE);
  const serverSecret = 'server-only-value-never-put-in-browser';
  const env = { ...publicSettings, RXPX_AI_EXTRACTION: 'true', OPENAI_API_KEY: serverSecret, SUPABASE_SERVICE_ROLE_KEY: serverSecret };
  build({ root, env, requireConfig: true });
  const generated = fs.readFileSync(path.join(root, 'dist', 'app-config.js'), 'utf8');
  assert.match(generated, /"aiExtraction": true/);
  assert.ok(!generated.includes(serverSecret));
  const anon = ['eyJhbGciOiJIUzI1NiJ9', Buffer.from(JSON.stringify({ role: 'anon' })).toString('base64url'), 'test-signature'].join('.');
  assert.equal(readConfig(root, { ...publicSettings, RXPX_SUPABASE_ANON_KEY: anon }).supabaseAnonKey, anon);
});

test('invalid origins, secret/service-role keys and invalid AI flags block builds without printing key values', t => {
  const root = fixture(t);
  for (const url of ['http://example.supabase.co', 'https://user:pass@example.supabase.co', 'https://example.supabase.co/rest/v1', 'https://example.supabase.co?key=anything']) {
    assert.throws(() => readConfig(root, { ...publicSettings, RXPX_SUPABASE_URL: url }), /HTTPS Supabase Project URL/);
  }
  const serviceKey = ['header', Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url'), 'test-signature'].join('.');
  for (const key of ['sb_secret_this_must_stay_on_the_server', serviceKey]) {
    assert.throws(() => readConfig(root, { ...publicSettings, RXPX_SUPABASE_ANON_KEY: key }), error => /publishable\/anon/.test(error.message) && !error.message.includes(key));
  }
  assert.throws(() => readConfig(root, { ...publicSettings, RXPX_AI_EXTRACTION: 'yes' }), /true or false/);
});

test('a junction or symlink at dist cannot redirect the build into another directory', t => {
  const root = fixture(t), elsewhere = fixture(t);
  fs.writeFileSync(path.join(elsewhere, 'keep.txt'), 'Preserve outside data');
  const output = path.join(root, 'dist');
  fs.symlinkSync(elsewhere, output, process.platform === 'win32' ? 'junction' : 'dir');
  t.after(() => { if (fs.existsSync(output)) fs.unlinkSync(output); });
  assert.throws(() => build({ root, env: publicSettings }), /real dist directory/);
  assert.equal(fs.readFileSync(path.join(elsewhere, 'keep.txt'), 'utf8'), 'Preserve outside data');
  fs.unlinkSync(output);
});

test('the browser-only page builds for production without connection settings and ships only the page', t => {
  const root = fixture(t);
  const result = build({ root, env: {}, requireConfig: true });
  assert.equal(result.usesSupabase, false);
  assert.deepEqual(fs.readdirSync(path.join(root, 'dist')).sort(), ['_headers', 'index.html', 'medical bills.html']);
  assert.equal(fs.readFileSync(path.join(root, 'dist', 'index.html'), 'utf8'), fs.readFileSync(path.join(root, 'medical bills.html'), 'utf8'));
});

test('a page with two pasted documents or a broken inline script is rejected', t => {
  const root = fixture(t);
  const page = fs.readFileSync(path.join(root, 'medical bills.html'), 'utf8');
  fs.writeFileSync(path.join(root, 'medical bills.html'), page + '\n' + page);
  assert.throws(() => build({ root, env: {}, checkOnly: true }), /more than one HTML document/);
  fs.writeFileSync(path.join(root, 'medical bills.html'), page.replace('</script></body>', 'const = ;</script></body>'));
  assert.throws(() => build({ root, env: {}, checkOnly: true }), /syntax error/);
});

test('host configurations use the static output and authenticated AI function entrypoint', () => {
  const vercel = JSON.parse(fs.readFileSync(path.join(workspace, 'vercel.json'), 'utf8'));
  assert.equal(vercel.framework, null);
  assert.equal(vercel.outputDirectory, 'dist');
  assert.equal(vercel.buildCommand, 'npm run build:production');
  assert.match(fs.readFileSync(path.join(workspace, 'netlify.toml'), 'utf8'), /publish = "dist"/);
  assert.match(fs.readFileSync(path.join(workspace, 'supabase/config.toml'), 'utf8'), /verify_jwt = true/);
});
