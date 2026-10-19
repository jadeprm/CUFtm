import http from 'node:http'; import { readFileSync, existsSync } from 'node:fs';
/**
 * Everything is resolved against the repository, not the shell's directory.
 *
 * This file lives in dev-tests/ but serves api/, public/ and test/ from the
 * root, so `./api/...` and a bare 'test/sheet.csv' only worked from exactly
 * one place and failed everywhere else. ROOT makes `node dev-tests/srv2.mjs`
 * work from anywhere.
 */
const ROOT = new URL('../', import.meta.url);
const at = (rel) => new URL(rel, ROOT);
process.env.DATABASE_URL='postgres://postgres:pw@127.0.0.1:5432/fairv2';
// Points the Neon driver at the Postgres on this machine — see neon-local.mjs.
await import('./neon-local.mjs');
process.env.LINE_CHANNEL_SECRET='dev_secret';
process.env.LINE_CHANNEL_ACCESS_TOKEN='dev_token';
const SHEET=readFileSync(at('test/sheet.csv'),'utf8'); const rf=globalThis.fetch;
globalThis.fetch=async(u,i)=>String(u).includes('docs.google.com')?new Response(SHEET,{status:200}):rf(u,i);
const R={'/api/auth':'auth','/api/users':'users','/api/tasks':'tasks','/api/meta':'meta','/api/notifications':'notifications','/api/import':'import','/api/calendar':'calendar','/api/push':'push','/api/cron':'cron','/api/events':'events','/api/line':'line','/api/documents':'documents'};
const routes={}; for(const [p,f] of Object.entries(R)) routes[p]=(await import(at(`api/${f}.js`).href)).default;
const T={html:'text/html',js:'text/javascript',css:'text/css',json:'application/json',png:'image/png'};
http.createServer(async(req,res)=>{let p=req.url.split('?')[0];
 // Mirrors the vercel.json rewrite, so short links work in development too.
 const short=p.match(/^\/s\/([A-Za-z0-9_-]+)$/);
 if(short){req.url='/api/meta?go='+encodeURIComponent(short[1]);p='/api/meta';}
 const fn=routes[p];
 if(fn){let raw='';for await(const c of req)raw+=c;
  if(raw&&(req.headers['content-type']||'').includes('json')){try{req.body=JSON.parse(raw);}catch{}}
  return void await fn(req,res);}
 const f=at('public'+(p==='/'?'/index.html':p));
 if(existsSync(f)){res.writeHead(200,{'content-type':(T[f.pathname.split('.').pop()]||'text/plain')+'; charset=utf-8'});return res.end(readFileSync(f));}
 res.writeHead(404);res.end();}).listen(4700,()=>console.log('up'));
