'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Only these public application files may reach hosting. Never copy the workspace.
const PUBLIC_FILES = Object.freeze([
  'app-config.js', 'medical-bills.js', 'bill-extraction.js', 'bill-export.js',
  'supabase-setup.sql', 'README.md',
]);

function isPublicKey(value) {
  if (typeof value !== 'string' || value.length < 20) return false;
  if (/^sb_publishable_[A-Za-z0-9_-]+$/.test(value)) return true;
  try { return JSON.parse(Buffer.from(value.split('.')[1], 'base64url').toString()).role === 'anon'; }
  catch (_) { return false; }
}

function readConfig(root, env = process.env, requireConfig = false) {
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'app-config.js'), 'utf8'), context, { timeout: 1000 });
  const config = Object.assign({ supabaseUrl: '', supabaseAnonKey: '', aiExtraction: false, extractionFunction: 'extract-bill' }, context.window.RXPX_CONFIG || {});
  if (env.RXPX_SUPABASE_URL !== undefined) config.supabaseUrl = env.RXPX_SUPABASE_URL.trim();
  if (env.RXPX_SUPABASE_ANON_KEY !== undefined) config.supabaseAnonKey = env.RXPX_SUPABASE_ANON_KEY.trim();
  if (env.RXPX_AI_EXTRACTION !== undefined) {
    if (!/^(true|false)$/.test(env.RXPX_AI_EXTRACTION)) throw new Error('RXPX_AI_EXTRACTION must be true or false.');
    config.aiExtraction = env.RXPX_AI_EXTRACTION === 'true';
  }
  config.supabaseUrl = String(config.supabaseUrl || '').trim().replace(/\/+$/, '');
  config.supabaseAnonKey = String(config.supabaseAnonKey || '').trim();
  if (!config.supabaseUrl || !config.supabaseAnonKey) {
    if (config.supabaseUrl || config.supabaseAnonKey || requireConfig) {
      throw new Error('Supabase connection is missing. Set both RXPX_SUPABASE_URL and RXPX_SUPABASE_ANON_KEY in the host build environment, or fill in app-config.js with your public project settings.');
    }
  } else {
    let url;
    try { url = new URL(config.supabaseUrl); } catch (_) { throw new Error('Use a valid HTTPS Supabase Project URL.'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('Use the HTTPS Supabase Project URL without credentials, a path, query, or hash.');
    }
    if (!isPublicKey(config.supabaseAnonKey)) throw new Error('Browser configuration requires a publishable/anon key. Secret and service-role keys must never enter a static build.');
  }
  if (typeof config.aiExtraction !== 'boolean' || !/^[a-z0-9][a-z0-9_-]{0,79}$/i.test(config.extractionFunction)) {
    throw new Error('Invalid AI reader configuration. Use a boolean aiExtraction and a function name such as extract-bill.');
  }
  // Strip unknown properties so secrets accidentally added to config are not published.
  return { supabaseUrl: config.supabaseUrl, supabaseAnonKey: config.supabaseAnonKey, aiExtraction: config.aiExtraction, extractionFunction: config.extractionFunction };
}

function build({ root = path.resolve(__dirname, '..'), env = process.env, requireConfig = false, checkOnly = false } = {}) {
  root = path.resolve(root);
  const html = fs.readFileSync(path.join(root, 'medical bills.html'), 'utf8');
  if (!/<meta charset="utf-8">/i.test(html)) throw new Error('The page must declare UTF-8 for rupees and hospital text.');
  // Two pasted pages make the second page's script fail and its styles override the first page.
  if ((html.match(/<!doctype html/gi) || []).length > 1 || (html.match(/<html\b/gi) || []).length > 1) {
    throw new Error('The page contains more than one HTML document. Keep a single <!doctype html> page.');
  }
  for (const match of html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
    try { new vm.Script(match[1], { filename: 'medical bills.html (inline script)' }); }
    catch (error) { throw new Error('The page script has a syntax error: ' + error.message); }
  }
  const localScripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/gi)].map(match => match[1]).filter(src => !/^https:\/\//.test(src));
  // Only the Supabase version of the page loads app-config.js; the browser-only page needs no connection settings.
  const usesConfig = localScripts.includes('app-config.js');
  const config = usesConfig ? readConfig(root, env, requireConfig) : null;
  const payload = new Map([['index.html', html], ['medical bills.html', html]]);
  if (usesConfig) for (const file of PUBLIC_FILES) payload.set(file, fs.readFileSync(path.join(root, file), 'utf8'));
  for (const src of localScripts) {
    if (!PUBLIC_FILES.includes(src) || !fs.existsSync(path.join(root, src))) throw new Error('A local browser script is missing from the public build.');
    if (!payload.has(src)) payload.set(src, fs.readFileSync(path.join(root, src), 'utf8'));
    new vm.Script(payload.get(src), { filename: src });
  }
  if (usesConfig) payload.set('app-config.js', '// Generated public browser configuration. No server secrets.\nwindow.RXPX_CONFIG = ' + JSON.stringify(config, null, 2) + ';\n');
  payload.set('_headers', '/*\n  Cache-Control: no-store\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n');
  if (!checkOnly) {
    const output = path.resolve(root, 'dist');
    // Validate the exact target before recursive removal; reject symlink/junction outputs.
    if (path.dirname(output) !== root || path.basename(output) !== 'dist') throw new Error('Invalid build output directory.');
    if (fs.existsSync(output)) {
      if (fs.lstatSync(output).isSymbolicLink() || fs.realpathSync(output).toLowerCase() !== output.toLowerCase()) throw new Error('Build output must be a real dist directory within this project.');
      fs.rmSync(output, { recursive: true, force: true });
    }
    fs.mkdirSync(output);
    for (const [name, content] of payload) fs.writeFileSync(path.join(output, name), content, 'utf8');
  }
  return { configured: !!config?.supabaseUrl, usesSupabase: usesConfig, aiExtraction: !!config?.aiExtraction, files: [...payload.keys()] };
}

if (require.main === module) {
  try {
    const result = build({ requireConfig: process.argv.includes('--require-config'), checkOnly: process.argv.includes('--check') });
    console.log((process.argv.includes('--check') ? 'Static preflight passed.' : 'Static build ready in dist/.') + ' ' + result.files.length + ' public files validated.');
    if (!result.usesSupabase) console.log('This page keeps bills and stock in the browser; it needs no Supabase settings.');
    else {
      if (!result.configured) console.log('SETUP REQUIRED: This preview opens the connection screen. Production builds require your public Supabase settings.');
      console.log('Live database migration, Auth redirects, and optional AI secrets/origins still need verification in your Supabase project.');
    }
  } catch (error) { console.error('Build blocked: ' + error.message); process.exitCode = 1; }
}
module.exports = { build, readConfig, PUBLIC_FILES };
