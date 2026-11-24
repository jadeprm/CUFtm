/**
 * Automated Front-End / Back-End separation & architectural boundary check.
 *
 * Run via: npm run check:separation
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
let failed = 0;

function check(label, pass, detail = '') {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
  if (!pass) failed += 1;
}

function walkJs(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walkJs(full));
    else if (/\.(m?js)$/.test(name)) out.push(full);
  }
  return out;
}

console.log('Checking Front-End / Back-End separation boundaries...\n');

// 1. Vercel Serverless Function ceiling (<= 12 files under api/)
const apiFiles = walkJs(join(ROOT, 'api'));
check('api/ stays within Vercel 12-function limit', apiFiles.length <= 12, `${apiFiles.length} functions`);

// 2. Backend (api/, lib/) never imports from frontend (public/)
const backendFiles = [...apiFiles, ...walkJs(join(ROOT, 'lib'))];
const backendImportsPublic = backendFiles.filter((f) => {
  const src = readFileSync(f, 'utf8');
  return /(?:from|import\s*\()\s*['"][^'"]*public\//.test(src);
});
check('backend (api/, lib/) has zero imports from public/', backendImportsPublic.length === 0, backendImportsPublic.join(', '));

// 3. Frontend (public/) never imports from backend (api/, lib/, server/)
const frontendFiles = walkJs(join(ROOT, 'public')).filter((f) => !f.includes('/vendor/'));
const frontendImportsBackend = frontendFiles.filter((f) => {
  const src = readFileSync(f, 'utf8');
  return /(?:from|import\s*\()\s*['"][^'"]*(?:api|lib|server)\//.test(src);
});
check('frontend (public/) has zero imports from api/, lib/, or server/', frontendImportsBackend.length === 0, frontendImportsBackend.join(', '));

// 4. All frontend UI HTTP calls go through public/api-client.js (no raw fetch() in app.js)
const appJs = readFileSync(join(ROOT, 'public/app.js'), 'utf8');
const rawFetchCalls = [...appJs.matchAll(/\bfetch\s*\(/g)];
check('public/app.js has zero direct fetch() calls (routed via public/api-client.js)', rawFetchCalls.length === 0, `${rawFetchCalls.length} direct fetch() calls`);

const apiClientJs = readFileSync(join(ROOT, 'public/api-client.js'), 'utf8');
check('public/api-client.js exposes window.FairAPI with configurable base URL',
  /FAIR_API_BASE/.test(apiClientJs) && /global\.FairAPI\s*=/.test(apiClientJs));

// 5. API route handlers contain zero inline HTML documents (HTML templates live in lib/templates.js)
const apiInlineHtml = apiFiles.filter((f) => /<!doctype html/i.test(readFileSync(f, 'utf8')));
check('api/*.js route handlers contain zero inline HTML documents', apiInlineHtml.length === 0, apiInlineHtml.join(', '));

// 6. Version parity across backend & frontend boundary
const versionJs = readFileSync(join(ROOT, 'lib/version.js'), 'utf8');
const backendVersion = (versionJs.match(/APP_VERSION\s*=\s*'([^']+)'/) || [])[1];
const appVersion = (appJs.match(/var APP_VERSION = '([^']+)'/) || [])[1];
const apiClientVersion = (apiClientJs.match(/version:\s*'([^']+)'/) || [])[1];
const thVersion = (readFileSync(join(ROOT, 'public/i18n.js'), 'utf8').match(/STRINGS_VERSION = '([^']+)'/) || [])[1];
const enVersion = (readFileSync(join(ROOT, 'public/i18n-en.js'), 'utf8').match(/STRINGS_EN_VERSION = '([^']+)'/) || [])[1];
const indexHtml = readFileSync(join(ROOT, 'public/index.html'), 'utf8');
const htmlStamps = [...new Set([...indexHtml.matchAll(/\?v=([0-9a-z-]+)/g)].map((m) => m[1]))];

check('version matches across backend (lib/version.js) and all frontend files',
  Boolean(backendVersion) &&
  appVersion === backendVersion &&
  apiClientVersion === backendVersion &&
  thVersion === backendVersion &&
  enVersion === backendVersion &&
  htmlStamps.length === 1 && htmlStamps[0] === backendVersion,
  `be=${backendVersion}, app=${appVersion}, client=${apiClientVersion}, th=${thVersion}, en=${enVersion}, html=[${htmlStamps.join(',')}]`);

console.log('');
if (failed) {
  console.error(`${failed} boundary check(s) failed.`);
  process.exit(1);
}
console.log('All Front-End / Back-End separation checks passed.');
