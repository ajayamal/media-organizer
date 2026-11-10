import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import staticPlugin from '@fastify/static';
import Database from 'better-sqlite3';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { promises as fs, constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MetadataMatcher } from './services/metadata-matcher.js';

const ROOT = path.resolve(process.env.MEDIA_ROOT || '/media');
const DATA = path.resolve(process.env.DATA_DIR || '/app/data');
const WRITE_ENABLED = process.env.ENABLE_WRITES === 'true';
const PASSWORD = process.env.ADMIN_PASSWORD || '';
if (PASSWORD.length < 16) throw new Error('ADMIN_PASSWORD must contain at least 16 characters');
await fs.mkdir(DATA, {recursive:true});
const db = new Database(path.join(DATA,'organizer.sqlite'));
db.pragma('journal_mode = WAL');
db.exec(`CREATE TABLE IF NOT EXISTS inventory (id TEXT PRIMARY KEY, rel TEXT NOT NULL UNIQUE, bytes INTEGER NOT NULL, category TEXT NOT NULL, issue TEXT NOT NULL, proposal TEXT, confidence TEXT NOT NULL, scanned_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS operations (id INTEGER PRIMARY KEY AUTOINCREMENT, old_rel TEXT NOT NULL, new_rel TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, undone_at TEXT);
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS metadata_cache (cache_key TEXT PRIMARY KEY, payload TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS metadata_matches (
 run_id INTEGER NOT NULL, inventory_id TEXT NOT NULL, rel TEXT NOT NULL, provider_id INTEGER, provider_type TEXT,
 title TEXT, original_title TEXT, release_year INTEGER, episode_title TEXT, confidence_score INTEGER NOT NULL,
 confidence TEXT NOT NULL, match_status TEXT NOT NULL, explanations TEXT NOT NULL,
 candidates TEXT NOT NULL, season INTEGER, episode INTEGER, proposed_rel TEXT, error TEXT, updated_at TEXT NOT NULL,
 PRIMARY KEY (run_id,inventory_id)
);
CREATE TABLE IF NOT EXISTS metadata_match_runs (
 id INTEGER PRIMARY KEY AUTOINCREMENT, status TEXT NOT NULL, total INTEGER NOT NULL DEFAULT 0,
 processed INTEGER NOT NULL DEFAULT 0, matched INTEGER NOT NULL DEFAULT 0, review INTEGER NOT NULL DEFAULT 0,
 unmatched INTEGER NOT NULL DEFAULT 0, preserved INTEGER NOT NULL DEFAULT 0, errors INTEGER NOT NULL DEFAULT 0, error TEXT,
 started_at TEXT NOT NULL, completed_at TEXT
);`);
db.prepare("UPDATE metadata_match_runs SET status='failed',error='Server restarted before matching completed.',completed_at=? WHERE status IN ('queued','running')")
 .run(new Date().toISOString());
const app = Fastify({logger:true, bodyLimit:64*1024, trustProxy:false});
await app.register(cookie);
const metadataMatcher = new MetadataMatcher(db, process.env.TMDB_READ_TOKEN || '');
app.addHook('onRequest', async (req, reply) => {
  reply.header('X-Content-Type-Options','nosniff');
  reply.header('X-Frame-Options','DENY');
  reply.header('Referrer-Policy','no-referrer');
  reply.header('Cache-Control','no-store');
  reply.header('Content-Security-Policy',"default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
});
function sha(s:string){return createHash('sha256').update(s).digest('hex');}
function safeEqual(a:string,b:string){const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length && timingSafeEqual(x,y);}
const salt = process.env.PASSWORD_SALT || 'media-organizer-v1';
const passHash = scryptSync(PASSWORD,salt,64).toString('hex');
function auth(req:any){
 const token=req.cookies?.mo_session;
 if(typeof token!=='string'||!token) return false;
 const found=db.prepare('SELECT expires FROM sessions WHERE token_hash=?').get(sha(token)) as {expires:number}|undefined;
 return !!found && found.expires>Date.now();
}
async function requireAuth(req:any,reply:any){if(!auth(req)) return reply.code(401).send({error:'Sign in required'});}
async function requireOrigin(req:any,reply:any){
 const origin=req.headers.origin;
 const host=req.headers.host;
 if(origin){try{if(new URL(origin).host!==host) return reply.code(403).send({error:'Invalid origin'});}catch{return reply.code(403).send({error:'Invalid origin'});}}
 const fetchSite=req.headers['sec-fetch-site'];
 if(fetchSite && !['same-origin','none'].includes(String(fetchSite))) return reply.code(403).send({error:'Cross-site request blocked'});
}
app.post('/api/login',{preHandler:requireOrigin,config:{rateLimit:false}},async(req:any,reply)=>{
 const supplied=typeof req.body?.password==='string'?req.body.password:'';
 const candidate=scryptSync(supplied,salt,64).toString('hex');
 if(!safeEqual(candidate,passHash)) {await new Promise(r=>setTimeout(r,350));return reply.code(401).send({error:'Invalid password'});}
 const token=randomBytes(32).toString('hex');
 db.prepare('INSERT INTO sessions VALUES (?,?)').run(sha(token),Date.now()+12*60*60*1000);
 reply.setCookie('mo_session',token,{httpOnly:true,sameSite:'strict',secure:process.env.COOKIE_SECURE==='true',path:'/',maxAge:43200});
 return {ok:true};
});
app.post('/api/logout',{preHandler:[requireOrigin,requireAuth]},async(req:any,reply)=>{
 if(req.cookies.mo_session) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha(req.cookies.mo_session));
 reply.clearCookie('mo_session',{path:'/'});return {ok:true};
});
app.get('/api/status',async(req,reply)=>({authenticated:auth(req),writesEnabled:WRITE_ENABLED}));
app.post('/api/metadata/match',{preHandler:[requireOrigin,requireAuth]},async(_req,reply)=>{
 if(!process.env.TMDB_READ_TOKEN?.trim())return reply.code(503).send({error:'Metadata matching is unavailable: TMDB_READ_TOKEN is not configured.'});
 const active=db.prepare("SELECT id FROM metadata_match_runs WHERE status IN ('queued','running') LIMIT 1").get() as {id:number}|undefined;
 if(active)return reply.code(409).send({error:'A metadata matching run is already in progress.',runId:active.id});
 const count=(db.prepare('SELECT COUNT(*) AS count FROM inventory').get() as {count:number}).count;
 const startedAt=new Date().toISOString();
 const info=db.prepare("INSERT INTO metadata_match_runs (status,total,started_at) VALUES ('queued',?,?)").run(count,startedAt);
 const runId=Number(info.lastInsertRowid);
 setImmediate(()=>{
  void metadataMatcher.run(runId).catch(error=>{
   const message=error instanceof Error?error.message:'Unknown metadata matching failure.';
   app.log.error({err:error,runId},'Metadata matching run failed');
   metadataMatcher.fail(runId,message);
  });
 });
 return reply.code(202).send({runId,status:'queued',total:count});
});
app.get('/api/metadata/match/:id',{preHandler:requireAuth},async(req:any,reply)=>{
 const id=Number(req.params?.id);
 if(!Number.isSafeInteger(id)||id<1)return reply.code(400).send({error:'Invalid metadata run id.'});
 const run=db.prepare('SELECT * FROM metadata_match_runs WHERE id=?').get(id);
 if(!run)return reply.code(404).send({error:'Metadata matching run not found.'});
 const matches=db.prepare(`SELECT inventory_id AS inventoryId,rel,provider_id AS providerId,provider_type AS providerType,
  title,original_title AS originalTitle,release_year AS releaseYear,episode_title AS episodeTitle,confidence_score AS confidenceScore,
  confidence,match_status AS matchStatus,explanations,candidates,season,episode,proposed_rel AS proposedRel,error,updated_at AS updatedAt
  FROM metadata_matches WHERE run_id=? AND inventory_id IN (SELECT id FROM inventory) ORDER BY rel LIMIT 2000`).all(id);
 return {run,matches:matches.map((row:any)=>({...row,explanations:JSON.parse(row.explanations),candidates:JSON.parse(row.candidates)}))};
});

const videoExt=new Set(['.mkv','.mp4','.avi','.m4v','.mov','.webm']);
const extraNames=/^(extras?|specials?|featurettes?|behind the scenes)$/i;
const categories=['movies/Anime','movies/Movies','shows/Anime','shows/Tv Shows'];
function normalizeName(s:string){return s.replace(/[._]+/g,' ').replace(/\s+/g,' ').trim();}
function suggest(rel:string):{proposal:string|null,issue:string,confidence:string}{
 const parts=rel.split('/');const base=parts.at(-1)!;const stem=base.slice(0,-path.extname(base).length);const ext=path.extname(base);
 if(base.startsWith('._')) return {proposal:null,issue:'AppleDouble metadata (review only)',confidence:'none'};
 if(parts.some(p=>extraNames.test(p))) return {proposal:null,issue:'Extra or special (preserved)',confidence:'none'};
 const show=parts[0]==='shows';
 if(show){
  const showName=parts[2];
  let season=Number(parts.find(p=>/^Season\s+\d+$/i.test(p))?.match(/\d+/)?.[0]||'0');
  const standard=stem.match(/\bS(\d{1,2})E(\d{1,3})\b/i);
  if(standard){
   if(season && season!==Number(standard[1])) return {proposal:null,issue:'Season folder disagrees with episode filename',confidence:'review'};
   if(/OVA|special/i.test(stem)) return {proposal:null,issue:'OVA/special numbering requires review',confidence:'review'};
   season=season||Number(standard[1]);
   const ep=Number(standard[2]);
   const title=showName.replace(/\s*\[(?:BD|ENHANCED).*$/i,'').trim();
   const dest=[...parts.slice(0,3),`Season ${String(season).padStart(2,'0')}`,`${title} - S${String(season).padStart(2,'0')}E${String(ep).padStart(2,'0')}${ext}`].join('/');
   return {proposal:dest===rel?null:dest,issue:dest===rel?'Already standardized':'Release tags or season folder formatting',confidence:'high'};
  }
  if(/OVA|special/i.test(stem)) return {proposal:null,issue:'OVA/special requires review',confidence:'review'};
  const numbered=stem.match(/(?:\s-\s|_-_)(\d{1,3})(?:\b|_)/);
  if(numbered && (season===1 || !season)){
   const title=showName.replace(/\s*\[(?:BD|ENHANCED).*$/i,'').trim();
   const ep=Number(numbered[1]);
   if(ep<1||ep>99) return {proposal:null,issue:'Unusual episode number',confidence:'review'};
   const dest=[...parts.slice(0,3),'Season 01',`${title} - S01E${String(ep).padStart(2,'0')}${ext}`].join('/');
   return {proposal:dest===rel?null:dest,issue:'Absolute-numbered episode (verify season mapping)',confidence:'review'};
  }
  return {proposal:null,issue:'Unrecognized series episode',confidence:'review'};
 }
 // Only high-confidence movie proposals from a folder that already contains a title and year.
 const movieFolder=parts[2];
 const match=movieFolder?.match(/^(.+?)\s*\((19\d{2}|20\d{2})\)/);
 if(!match) return {proposal:null,issue:'Movie title/year needs review',confidence:'review'};
 const title=match[1].replace(/^\[[^\]]+\]\s*/,'').trim();
 const movie=`${title} (${match[2]})`;
 if(parts.length!==4) return {proposal:null,issue:'Nested movie content (preserved)',confidence:'review'};
 const dest=[...parts.slice(0,2),movie,`${movie}${ext}`].join('/');
 return {proposal:dest===rel?null:dest,issue:dest===rel?'Already standardized':'Movie release naming',confidence:'high'};
}
async function walk(dir:string,emit:(file:string,bytes:number)=>void){
 const entries=await fs.readdir(dir,{withFileTypes:true});
 for(const entry of entries){
  if(entry.isSymbolicLink())continue;
  const full=path.join(dir,entry.name);
  if(entry.isDirectory()) await walk(full,emit);
  else if(entry.isFile() && videoExt.has(path.extname(entry.name).toLowerCase())){
   const stat=await fs.stat(full);emit(full,stat.size);
  }
 }
}
function validRel(rel:string){
 if(typeof rel!=='string'||!rel||rel.includes('\\')||rel.includes('\0')||path.posix.isAbsolute(rel))return false;
 const parts=rel.split('/');return parts.every(p=>p!==''&&p!=='.'&&p!=='..') && categories.some(c=>rel.startsWith(c+'/'));
}
async function verifiedPath(rel:string){
 if(!validRel(rel))throw new Error('Invalid media path');
 const full=path.resolve(ROOT,rel);
 if(!full.startsWith(ROOT+path.sep))throw new Error('Outside media root');
 // Existing ancestors must not contain symlinks (protect against symlink escapes).
 let current=ROOT;
 for(const part of rel.split('/')){
  current=path.join(current,part);
  try{const stat=await fs.lstat(current);if(stat.isSymbolicLink())throw new Error('Symlink path blocked');}
  catch(e:any){if(e.code==='ENOENT')break;throw e;}
 }
 return full;
}
let scanning=false;
app.post('/api/scan',{preHandler:[requireOrigin,requireAuth]},async(_req,reply)=>{
 if(scanning)return reply.code(409).send({error:'Scan already running'});
 scanning=true;
 try{
  const rows:Array<{id:string,rel:string,bytes:number,category:string,issue:string,proposal:string|null,confidence:string,scanned_at:string}>=[];
  const now=new Date().toISOString();
  for(const cat of categories){
   const dir=path.join(ROOT,cat);
   try{await walk(dir,(full,bytes)=>{
    const rel=path.relative(ROOT,full).split(path.sep).join('/');const s=suggest(rel);
    rows.push({id:sha(rel),rel,bytes,category:cat,issue:s.issue,proposal:s.proposal,confidence:s.confidence,scanned_at:now});
   });}catch(e:any){if(e.code!=='ENOENT')throw e;}
  }
  const save=db.transaction(()=>{
   db.prepare('DELETE FROM inventory').run();
   const insert=db.prepare('INSERT INTO inventory VALUES (@id,@rel,@bytes,@category,@issue,@proposal,@confidence,@scanned_at)');
   for(const row of rows)insert.run(row);
  });save();
  return {count:rows.length};
 }finally{scanning=false;}
});
app.get('/api/inventory',{preHandler:requireAuth},async(req:any)=>{
 const search=String(req.query?.q||'').slice(0,200).toLowerCase();
 const all=db.prepare('SELECT * FROM inventory ORDER BY category,rel').all() as any[];
 const filtered=search?all.filter(r=>r.rel.toLowerCase().includes(search)||r.issue.toLowerCase().includes(search)):all;
 return {items:filtered.slice(0,2000),total:filtered.length};
});
app.get('/api/operations',{preHandler:requireAuth},async()=>({items:db.prepare('SELECT * FROM operations ORDER BY id DESC LIMIT 200').all()}));
function error(reply:any,msg:string,status=400){return reply.code(status).send({error:msg});}
app.post('/api/apply',{preHandler:[requireOrigin,requireAuth]},async(req:any,reply)=>{
 if(!WRITE_ENABLED)return error(reply,'Write mode is disabled',403);
 const {id,expectedProposal}=req.body||{};
 if(typeof id!=='string'||typeof expectedProposal!=='string')return error(reply,'Invalid request');
 const item=db.prepare('SELECT * FROM inventory WHERE id=?').get(id) as any;
 if(!item||!item.proposal||item.confidence!=='high'||item.proposal!==expectedProposal)return error(reply,'Proposal is stale or requires manual review',409);
 try{
  const src=await verifiedPath(item.rel),dst=await verifiedPath(item.proposal);
  const st=await fs.lstat(src);if(!st.isFile())return error(reply,'Source is not a regular file',409);
  if(st.size!==item.bytes)return error(reply,'Source changed since scan; rescan first',409);
  try{await fs.lstat(dst);return error(reply,'Destination already exists',409);}catch(e:any){if(e.code!=='ENOENT')throw e;}
  await fs.mkdir(path.dirname(dst),{recursive:true});
  await verifiedPath(item.proposal);
  // Exclusive hard-link then unlink avoids overwriting an existing destination.
  await fs.link(src,dst);
  try{await fs.unlink(src);}catch(e){await fs.unlink(dst).catch(()=>{});throw e;}
  const info=db.prepare('INSERT INTO operations (old_rel,new_rel,status,created_at) VALUES (?,?,?,?)').run(item.rel,item.proposal,'applied',new Date().toISOString());
  db.prepare('DELETE FROM inventory WHERE id=?').run(id);
  return {ok:true,operationId:info.lastInsertRowid};
 }catch(e:any){req.log.error(e);return error(reply,`Operation failed: ${e.code||e.message}`,409);}
});
app.post('/api/undo',{preHandler:[requireOrigin,requireAuth]},async(req:any,reply)=>{
 if(!WRITE_ENABLED)return error(reply,'Write mode is disabled',403);
 const id=req.body?.id;
 if(!Number.isSafeInteger(id))return error(reply,'Invalid operation id');
 const op=db.prepare('SELECT * FROM operations WHERE id=?').get(id) as any;
 if(!op||op.status!=='applied')return error(reply,'Operation is not undoable',409);
 try{
  const src=await verifiedPath(op.new_rel),dst=await verifiedPath(op.old_rel);
  const st=await fs.lstat(src);if(!st.isFile())return error(reply,'Renamed file is missing',409);
  try{await fs.lstat(dst);return error(reply,'Original path is occupied',409);}catch(e:any){if(e.code!=='ENOENT')throw e;}
  await fs.mkdir(path.dirname(dst),{recursive:true});await verifiedPath(op.old_rel);
  await fs.link(src,dst);
  try{await fs.unlink(src);}catch(e){await fs.unlink(dst).catch(()=>{});throw e;}
  db.prepare('UPDATE operations SET status=?,undone_at=? WHERE id=?').run('undone',new Date().toISOString(),id);
  return {ok:true};
 }catch(e:any){req.log.error(e);return error(reply,`Undo failed: ${e.code||e.message}`,409);}
});
const here=path.dirname(fileURLToPath(import.meta.url));
const publicDir=path.resolve(here,'../public');
await app.register(staticPlugin,{root:publicDir,prefix:'/',wildcard:false});
app.setNotFoundHandler(async(req,reply)=>{
 if(req.url.startsWith('/api/'))return reply.code(404).send({error:'Not found'});
 return reply.sendFile('index.html');
});
await app.listen({port:Number(process.env.PORT||3100),host:'0.0.0.0'});
