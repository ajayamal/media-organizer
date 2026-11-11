import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import staticPlugin from '@fastify/static';
import Database from 'better-sqlite3';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { promises as fs, constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MetadataMatcher } from './services/metadata-matcher.js';
import { LmStudioClient } from './services/lm-studio.js';
import { FileAudit } from './services/file-audit.js';
import { TmdbClient } from './services/tmdb.js';
import { createMetadataProposal, parseMediaPath, safeMetadataName } from './services/metadata-matching.js';

const ROOT = path.resolve(process.env.MEDIA_ROOT || '/media');
const DATA = path.resolve(process.env.DATA_DIR || '/app/data');
const WRITE_ENABLED = process.env.ENABLE_WRITES === 'true';
const AUTO_APPLY_HIGH_CONFIDENCE = process.env.AUTO_APPLY_HIGH_CONFIDENCE === 'true';
const videoExt=new Set(['.mkv','.mp4','.avi','.m4v','.mov','.webm']);
const subtitleExt=new Set(['.srt','.ass','.ssa','.sub','.idx','.vtt','.smi','.scc']);
const categories=['movies/Anime','movies/Movies','shows/Anime','shows/Tv Shows'];
const PASSWORD = process.env.ADMIN_PASSWORD || '';
if (PASSWORD.length < 16) throw new Error('ADMIN_PASSWORD must contain at least 16 characters');
await fs.mkdir(DATA, {recursive:true});
const db = new Database(path.join(DATA,'organizer.sqlite'));
db.pragma('journal_mode = WAL');
db.exec(`CREATE TABLE IF NOT EXISTS inventory (id TEXT PRIMARY KEY, rel TEXT NOT NULL UNIQUE, bytes INTEGER NOT NULL, category TEXT NOT NULL, issue TEXT NOT NULL, proposal TEXT, confidence TEXT NOT NULL, scanned_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS operations (id INTEGER PRIMARY KEY AUTOINCREMENT, old_rel TEXT NOT NULL, new_rel TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, undone_at TEXT, inventory_retained INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS metadata_cache (cache_key TEXT PRIMARY KEY, payload TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS metadata_matches (
 run_id INTEGER NOT NULL, inventory_id TEXT NOT NULL, rel TEXT NOT NULL, provider_id INTEGER, provider_type TEXT,
 title TEXT, original_title TEXT, release_year INTEGER, episode_title TEXT, confidence_score INTEGER NOT NULL,
 confidence TEXT NOT NULL, match_status TEXT NOT NULL, explanations TEXT NOT NULL,
 candidates TEXT NOT NULL, season INTEGER, episode INTEGER, proposed_rel TEXT, error TEXT,
 manual_correction INTEGER NOT NULL DEFAULT 0, ai_assisted INTEGER NOT NULL DEFAULT 0,
 auto_applied INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
 PRIMARY KEY (run_id,inventory_id)
);
CREATE TABLE IF NOT EXISTS metadata_match_runs (
 id INTEGER PRIMARY KEY AUTOINCREMENT, status TEXT NOT NULL, total INTEGER NOT NULL DEFAULT 0,
 processed INTEGER NOT NULL DEFAULT 0, matched INTEGER NOT NULL DEFAULT 0, review INTEGER NOT NULL DEFAULT 0,
 unmatched INTEGER NOT NULL DEFAULT 0, preserved INTEGER NOT NULL DEFAULT 0, errors INTEGER NOT NULL DEFAULT 0, error TEXT,
 started_at TEXT NOT NULL, completed_at TEXT
);
CREATE TABLE IF NOT EXISTS metadata_corrections (
 rel TEXT PRIMARY KEY, category TEXT NOT NULL, provider_id INTEGER NOT NULL, provider_type TEXT NOT NULL,
 provider_title TEXT NOT NULL, original_title TEXT NOT NULL, provider_year INTEGER, corrected_title TEXT NOT NULL,
 corrected_year INTEGER, aliases TEXT NOT NULL, candidate_set TEXT NOT NULL DEFAULT '[]', season INTEGER, episode INTEGER,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS file_audit_runs (
 id INTEGER PRIMARY KEY AUTOINCREMENT, status TEXT NOT NULL, total INTEGER NOT NULL DEFAULT 0,
 processed INTEGER NOT NULL DEFAULT 0, duplicate_groups INTEGER NOT NULL DEFAULT 0, duplicate_files INTEGER NOT NULL DEFAULT 0,
 media_related_files INTEGER NOT NULL DEFAULT 0, other_files INTEGER NOT NULL DEFAULT 0, errors INTEGER NOT NULL DEFAULT 0,
 error TEXT, started_at TEXT NOT NULL, completed_at TEXT
);
CREATE TABLE IF NOT EXISTS file_audit_files (
 run_id INTEGER NOT NULL, rel TEXT NOT NULL, category TEXT NOT NULL, extension TEXT NOT NULL, kind TEXT NOT NULL,
 bytes INTEGER NOT NULL, sha256 TEXT, error TEXT, quarantined INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (run_id,rel)
);
CREATE TABLE IF NOT EXISTS file_quarantine (
 id INTEGER PRIMARY KEY AUTOINCREMENT, audit_run_id INTEGER NOT NULL, original_rel TEXT NOT NULL,
 quarantine_rel TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL, status TEXT NOT NULL,
 error TEXT, created_at TEXT NOT NULL, restored_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_file_audit_hash ON file_audit_files(run_id,sha256);
CREATE INDEX IF NOT EXISTS idx_file_audit_kind ON file_audit_files(run_id,kind,rel);`);
const auditFileColumns=db.prepare('PRAGMA table_info(file_audit_files)').all() as Array<{name:string}>;
if(!auditFileColumns.some(column=>column.name==='quarantined'))db.exec('ALTER TABLE file_audit_files ADD COLUMN quarantined INTEGER NOT NULL DEFAULT 0');
const matchColumns=db.prepare('PRAGMA table_info(metadata_matches)').all() as Array<{name:string}>;
if(!matchColumns.some(column=>column.name==='manual_correction'))db.exec('ALTER TABLE metadata_matches ADD COLUMN manual_correction INTEGER NOT NULL DEFAULT 0');
if(!matchColumns.some(column=>column.name==='episode_title'))db.exec('ALTER TABLE metadata_matches ADD COLUMN episode_title TEXT');
if(!matchColumns.some(column=>column.name==='ai_assisted'))db.exec('ALTER TABLE metadata_matches ADD COLUMN ai_assisted INTEGER NOT NULL DEFAULT 0');
if(!matchColumns.some(column=>column.name==='auto_applied'))db.exec('ALTER TABLE metadata_matches ADD COLUMN auto_applied INTEGER NOT NULL DEFAULT 0');
const operationColumns=db.prepare('PRAGMA table_info(operations)').all() as Array<{name:string}>;
if(!operationColumns.some(column=>column.name==='inventory_retained'))db.exec('ALTER TABLE operations ADD COLUMN inventory_retained INTEGER NOT NULL DEFAULT 0');
const correctionColumns=db.prepare('PRAGMA table_info(metadata_corrections)').all() as Array<{name:string}>;
if(!correctionColumns.some(column=>column.name==='candidate_set'))db.exec("ALTER TABLE metadata_corrections ADD COLUMN candidate_set TEXT NOT NULL DEFAULT '[]'");
db.prepare("UPDATE metadata_match_runs SET status='failed',error='Server restarted before matching completed.',completed_at=? WHERE status IN ('queued','running')")
 .run(new Date().toISOString());
db.prepare("UPDATE file_audit_runs SET status='failed',error='Server restarted before the file audit completed.',completed_at=? WHERE status IN ('queued','running')")
 .run(new Date().toISOString());
const app = Fastify({logger:true, bodyLimit:64*1024, trustProxy:false});
await app.register(cookie);
const lmStudioBaseUrl = process.env.LM_STUDIO_BASE_URL?.trim() || '';
const lmStudioModel = process.env.LM_STUDIO_MODEL?.trim() || '';
if (Boolean(lmStudioBaseUrl) !== Boolean(lmStudioModel)) {
  throw new Error('Configure both LM_STUDIO_BASE_URL and LM_STUDIO_MODEL, or leave both unset.');
}
const lmStudioClient = lmStudioBaseUrl
  ? new LmStudioClient(lmStudioBaseUrl, lmStudioModel, process.env.LM_STUDIO_API_TOKEN?.trim() || '')
  : null;
const metadataMatcher = new MetadataMatcher(
 db,
 process.env.TMDB_READ_TOKEN || '',
 lmStudioClient,
 AUTO_APPLY_HIGH_CONFIDENCE && WRITE_ENABLED ? applyMetadataProposal : null,
);
const fileAudit = new FileAudit(db, ROOT, categories);
const tmdbClient = new TmdbClient(db, process.env.TMDB_READ_TOKEN || '');
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
app.get('/api/status',async(req,reply)=>({
 authenticated:auth(req),
 writesEnabled:WRITE_ENABLED,
 aiMatchingEnabled:lmStudioClient!==null,
 autoApplyHighConfidenceEnabled:AUTO_APPLY_HIGH_CONFIDENCE&&WRITE_ENABLED,
}));
app.post('/api/metadata/match',{preHandler:[requireOrigin,requireAuth]},async(_req,reply)=>{
 if(!process.env.TMDB_READ_TOKEN?.trim())return reply.code(503).send({error:'Metadata matching is unavailable: TMDB_READ_TOKEN is not configured.'});
 if(AUTO_APPLY_HIGH_CONFIDENCE&&!WRITE_ENABLED)return reply.code(403).send({error:'AUTO_APPLY_HIGH_CONFIDENCE requires ENABLE_WRITES=true and read-write media mounts.'});
 if(scanning||auditing||quarantining||metadataMatching)return reply.code(409).send({error:'A scan, audit, cleanup, or metadata matching run is already in progress.'});
 const active=db.prepare("SELECT id FROM metadata_match_runs WHERE status IN ('queued','running') LIMIT 1").get() as {id:number}|undefined;
 if(active)return reply.code(409).send({error:'A metadata matching run is already in progress.',runId:active.id});
 const count=(db.prepare('SELECT COUNT(*) AS count FROM inventory').get() as {count:number}).count;
 const startedAt=new Date().toISOString();
 const info=db.prepare("INSERT INTO metadata_match_runs (status,total,started_at) VALUES ('queued',?,?)").run(count,startedAt);
 const runId=Number(info.lastInsertRowid);
 metadataMatching=true;
 setImmediate(()=>{
  void metadataMatcher.run(runId).catch(error=>{
   const message=error instanceof Error?error.message:'Unknown metadata matching failure.';
   app.log.error({err:error,runId},'Metadata matching run failed');
   metadataMatcher.fail(runId,message);
  }).finally(()=>{metadataMatching=false;});
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
  confidence,match_status AS matchStatus,explanations,candidates,season,episode,proposed_rel AS proposedRel,error,
  manual_correction AS manualCorrection,ai_assisted AS aiAssisted,auto_applied AS autoApplied,updated_at AS updatedAt
  FROM metadata_matches WHERE run_id=? AND inventory_id IN (SELECT id FROM inventory) ORDER BY rel LIMIT 2000`).all(id);
 return {run,matches:matches.map((row:any)=>({...row,manualCorrection:Boolean(row.manualCorrection),aiAssisted:Boolean(row.aiAssisted),autoApplied:Boolean(row.autoApplied),explanations:JSON.parse(row.explanations),candidates:JSON.parse(row.candidates)}))};
});
app.patch('/api/metadata/match/:runId/:inventoryId',{preHandler:[requireOrigin,requireAuth]},async(req:any,reply)=>{
 const runId=Number(req.params?.runId);
 const inventoryId=String(req.params?.inventoryId||'');
 if(!Number.isSafeInteger(runId)||runId<1||!inventoryId)return reply.code(400).send({error:'Invalid review target.'});
 const runRow=db.prepare('SELECT status FROM metadata_match_runs WHERE id=?').get(runId) as {status:string}|undefined;
 if(!runRow)return reply.code(404).send({error:'Metadata matching run not found.'});
 if(runRow.status!=='completed')return reply.code(409).send({error:'Wait for metadata matching to finish before reviewing results.'});
 const match=db.prepare(`SELECT candidates FROM metadata_matches WHERE run_id=? AND inventory_id=?`)
  .get(runId,inventoryId) as {candidates:string}|undefined;
 const item=db.prepare('SELECT id,rel,category FROM inventory WHERE id=?').get(inventoryId) as {id:string,rel:string,category:string}|undefined;
 if(!match||!item)return reply.code(404).send({error:'Match or inventory item not found.'});
 const parsed=parseMediaPath(item.rel,item.category);
 if(parsed.preservedReason)return reply.code(400).send({error:'Preserved files and specials cannot be proposed for renaming.'});

 const body=req.body||{};
 const candidateId=body.candidateId;
 const candidates=JSON.parse(match.candidates) as Array<{id:number,mediaType:'movie'|'tv',title:string,originalTitle:string,year?:number,aliases:string[]}>;
 const candidate=candidates.find(entry=>entry.id===candidateId);
 if(!candidate)return reply.code(400).send({error:'Select a candidate from this match result.'});
 if(candidate.mediaType!==parsed.type)return reply.code(400).send({error:'Candidate type does not match the library category.'});
 if(typeof body.title!=='string'||!body.title.trim()||body.title.length>180)return reply.code(400).send({error:'Enter a title of 1–180 characters.'});
 const title=safeMetadataName(body.title);
 const year=body.year===''||body.year===null||body.year===undefined?candidate.year??null:Number(body.year);
 if(year!==null&&(!Number.isInteger(year)||year<1870||year>new Date().getFullYear()+10))return reply.code(400).send({error:'Enter a valid release year.'});
 let season:number|null=null,episode:number|null=null,episodeTitle:string|null=null;
 const categoryType=item.category.startsWith('movies/')?'movie':'tv';
 if(categoryType==='movie'){
  if(year===null)return reply.code(400).send({error:'A release year is required to propose a movie destination.'});
 }else{
  season=body.season===''||body.season===null||body.season===undefined?null:Number(body.season);
  episode=body.episode===''||body.episode===null||body.episode===undefined?null:Number(body.episode);
  if(season===null||episode===null||!Number.isInteger(season)||season<0||season>99||!Number.isInteger(episode)||episode<1||episode>999){
   return reply.code(400).send({error:'Enter a valid season (0–99) and episode (1–999) mapping.'});
  }
  try{
   const episodes=await tmdbClient.season(candidate.id,season);
   const providerEpisode=episodes.find(entry=>entry.episode_number===episode);
   if(!providerEpisode)return reply.code(400).send({error:`TMDB has no episode ${season}x${episode} for the selected series.`});
   episodeTitle=providerEpisode.name;
  }catch(error){
   req.log.error({err:error,runId,inventoryId},'Failed to validate manually selected episode');
   return reply.code(502).send({error:error instanceof Error?`Could not verify episode mapping: ${error.message}`:'Could not verify episode mapping.'});
  }
 }
 const proposal=createMetadataProposal({category:item.category,type:categoryType,title,year,season,episode,extension:path.posix.extname(item.rel)});
 if(!proposal)return reply.code(400).send({error:'Unable to create a safe destination from the supplied correction.'});
 const now=new Date().toISOString();
 const explanations=[
  'Provider candidate and title were manually selected by the user.',
  categoryType==='tv'?'Season and episode were manually selected and verified against TMDB.':'Release year was manually confirmed.',
 ];
 const update=db.transaction(()=>{
  db.prepare(`INSERT INTO metadata_corrections
   (rel,category,provider_id,provider_type,provider_title,original_title,provider_year,corrected_title,corrected_year,aliases,candidate_set,season,episode,created_at,updated_at)
   VALUES (@rel,@category,@providerId,@providerType,@providerTitle,@originalTitle,@providerYear,@title,@year,@aliases,@candidateSet,@season,@episode,@now,@now)
   ON CONFLICT(rel) DO UPDATE SET category=excluded.category,provider_id=excluded.provider_id,provider_type=excluded.provider_type,
    provider_title=excluded.provider_title,original_title=excluded.original_title,provider_year=excluded.provider_year,
    corrected_title=excluded.corrected_title,corrected_year=excluded.corrected_year,aliases=excluded.aliases,candidate_set=excluded.candidate_set,
    season=excluded.season,episode=excluded.episode,updated_at=excluded.updated_at`)
   .run({rel:item.rel,category:item.category,providerId:candidate.id,providerType:candidate.mediaType,providerTitle:candidate.title,
    originalTitle:candidate.originalTitle,providerYear:candidate.year??null,title,year,aliases:JSON.stringify(candidate.aliases),
    candidateSet:JSON.stringify(candidates),season,episode,now});
  db.prepare(`UPDATE metadata_matches SET provider_id=?,provider_type=?,title=?,original_title=?,release_year=?,episode_title=?,
   confidence_score=100,confidence='high',match_status='matched',explanations=?,season=?,episode=?,proposed_rel=?,error=NULL,
   manual_correction=1,updated_at=? WHERE run_id=? AND inventory_id=?`)
   .run(candidate.id,candidate.mediaType,title,candidate.originalTitle,year,episodeTitle,JSON.stringify(explanations),season,episode,proposal,now,runId,inventoryId);
  const counts=db.prepare(`SELECT
   SUM(CASE WHEN match_status='matched' THEN 1 ELSE 0 END) AS matched,
   SUM(CASE WHEN match_status='review' THEN 1 ELSE 0 END) AS review,
   SUM(CASE WHEN match_status='unmatched' THEN 1 ELSE 0 END) AS unmatched,
   SUM(CASE WHEN match_status='preserved' THEN 1 ELSE 0 END) AS preserved
   FROM metadata_matches WHERE run_id=?`).get(runId) as {matched:number,review:number,unmatched:number,preserved:number};
  db.prepare('UPDATE metadata_match_runs SET matched=?,review=?,unmatched=?,preserved=? WHERE id=?')
   .run(counts.matched||0,counts.review||0,counts.unmatched||0,counts.preserved||0,runId);
 });
 update();
 const updated=db.prepare(`SELECT inventory_id AS inventoryId,rel,provider_id AS providerId,provider_type AS providerType,
  title,original_title AS originalTitle,release_year AS releaseYear,episode_title AS episodeTitle,confidence_score AS confidenceScore,
  confidence,match_status AS matchStatus,explanations,candidates,season,episode,proposed_rel AS proposedRel,error,
  manual_correction AS manualCorrection,ai_assisted AS aiAssisted,auto_applied AS autoApplied,updated_at AS updatedAt
  FROM metadata_matches WHERE run_id=? AND inventory_id=?`).get(runId,inventoryId) as any;
 const updatedRun=db.prepare('SELECT * FROM metadata_match_runs WHERE id=?').get(runId);
 return {run:updatedRun,match:{...updated,manualCorrection:Boolean(updated.manualCorrection),aiAssisted:Boolean(updated.aiAssisted),autoApplied:Boolean(updated.autoApplied),explanations:JSON.parse(updated.explanations),candidates:JSON.parse(updated.candidates)}};
});

const extraNames=/^(extras?|specials?|featurettes?|behind the scenes)$/i;
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
async function moveWithoutOverwrite(src:string,dst:string){
 await fs.link(src,dst);
 try{await fs.unlink(src);}catch(error){
  try{await fs.unlink(dst);}catch(cleanupError){
   app.log.error({err:cleanupError,source:src,destination:dst},'Failed to remove an incomplete rename destination');
   throw new Error('Could not remove the source after creating the destination, and destination cleanup also failed.');
  }
  throw error;
 }
}
async function applyMetadataProposal(record:{inventoryId:string,rel:string,proposedRel:string,bytes:number}):Promise<{ok:boolean,inventoryId?:string,rel?:string,reason?:string}>{
 if(!WRITE_ENABLED||!AUTO_APPLY_HIGH_CONFIDENCE)return {ok:false,reason:'Automatic matching writes are disabled.'};
 const item=db.prepare('SELECT * FROM inventory WHERE id=?').get(record.inventoryId) as any;
 if(!item||item.rel!==record.rel||item.bytes!==record.bytes)return {ok:false,reason:'The inventory entry changed; scan and match again.'};
 if(!record.proposedRel.startsWith(`${item.category}/`)
  ||path.posix.extname(record.proposedRel).toLowerCase()!==path.posix.extname(record.rel).toLowerCase()){
  return {ok:false,reason:'The proposed destination does not preserve the media category and file type.'};
 }
 if(record.proposedRel===record.rel)return {ok:false,reason:'The file is already at the proposed path.'};
 const src=await verifiedPath(record.rel),dst=await verifiedPath(record.proposedRel);
 const stat=await fs.lstat(src);
 if(!stat.isFile()||stat.isSymbolicLink())return {ok:false,reason:'Source is not a regular file.'};
 if(stat.size!==record.bytes)return {ok:false,reason:'Source changed since scanning; scan again.'};
 const siblings=await fs.readdir(path.dirname(src),{withFileTypes:true});
 if(siblings.some(entry=>(entry.isFile()||entry.isSymbolicLink())&&subtitleExt.has(path.extname(entry.name).toLowerCase()))){
  return {ok:false,reason:'A sidecar subtitle is present; automatic rename is blocked to keep it aligned with the video.'};
 }
 try{await fs.lstat(dst);return {ok:false,reason:'Destination already exists.'};}
 catch(error:any){if(error.code!=='ENOENT')throw error;}
 await fs.mkdir(path.dirname(dst),{recursive:true});
 await verifiedPath(record.proposedRel);
 await moveWithoutOverwrite(src,dst);

 const newId=sha(record.proposedRel);
 try{
  db.transaction(()=>{
   const update=db.prepare(`UPDATE inventory SET id=?,rel=?,issue=?,proposal=NULL,confidence='high',scanned_at=?
    WHERE id=? AND rel=? AND bytes=?`).run(newId,record.proposedRel,'Automatically renamed by metadata matching',new Date().toISOString(),
     record.inventoryId,record.rel,record.bytes);
   if(update.changes!==1)throw new Error('Inventory entry changed before the automatic rename could be recorded.');
   db.prepare(`INSERT INTO operations (old_rel,new_rel,status,created_at,inventory_retained)
    VALUES (?,?,'applied',?,1)`).run(record.rel,record.proposedRel,new Date().toISOString());
  })();
 }catch(error){
  try{
   try{await fs.lstat(src);throw new Error('Original path is occupied; automatic rollback was not possible.');}
   catch(checkError:any){if(checkError.code!=='ENOENT')throw checkError;}
   await moveWithoutOverwrite(dst,src);
  }catch(rollbackError){
   app.log.error({err:rollbackError,source:record.rel,destination:record.proposedRel},'Failed to roll back automatic metadata rename');
   throw new Error(`Metadata rename reached "${record.proposedRel}", but its database record failed and automatic rollback was unsuccessful.`);
  }
  throw error;
 }
 return {ok:true,inventoryId:newId,rel:record.proposedRel};
}
let scanning=false;
let auditing=false;
let quarantining=false;
let metadataMatching=false;
function updateAuditDuplicateSummary(runId:number){
 const summary=db.prepare(`SELECT COUNT(*) AS groups,COALESCE(SUM(file_count),0) AS files FROM (
  SELECT COUNT(*) AS file_count FROM file_audit_files WHERE run_id=? AND sha256 IS NOT NULL AND quarantined=0
  GROUP BY sha256 HAVING COUNT(*)>1
 )`).get(runId) as {groups:number,files:number};
 db.prepare('UPDATE file_audit_runs SET duplicate_groups=?,duplicate_files=? WHERE id=?')
  .run(summary.groups,summary.files,runId);
}
app.post('/api/audit/:id/quarantine',{preHandler:[requireOrigin,requireAuth]},async(req:any,reply)=>{
 if(!WRITE_ENABLED)return error(reply,'Write mode is disabled; duplicate cleanup requires explicit write mode.',403);
 if(scanning||auditing||quarantining||metadataMatching)return error(reply,'A library scan, audit, cleanup, or metadata matching run is already running.',409);
 const runId=Number(req.params?.id);
 if(!Number.isSafeInteger(runId)||runId<1)return error(reply,'Invalid file audit run id.');
 const run=db.prepare('SELECT status FROM file_audit_runs WHERE id=?').get(runId) as {status:string}|undefined;
 if(!run)return error(reply,'File audit run not found.',404);
 if(run.status!=='completed')return error(reply,'Wait for the file audit to complete before cleaning up duplicates.',409);
 const {keepRel,removeRels}=req.body||{};
 if(typeof keepRel!=='string'||!Array.isArray(removeRels)||removeRels.length===0
  ||removeRels.length>100||!removeRels.every((rel:unknown)=>typeof rel==='string')
  ||new Set(removeRels).size!==removeRels.length||removeRels.includes(keepRel)){
  return error(reply,'Select one copy to keep and between 1 and 100 non-video copies to quarantine.');
 }
 const keep=db.prepare(`SELECT sha256,kind FROM file_audit_files WHERE run_id=? AND rel=? AND quarantined=0 AND sha256 IS NOT NULL`)
  .get(runId,keepRel) as {sha256:string,kind:string}|undefined;
 if(!keep)return error(reply,'The selected copy is not part of this verified duplicate group. Run the audit again.',409);
 const files=(removeRels as string[]).map(rel=>db.prepare(`SELECT sha256,kind,bytes FROM file_audit_files
  WHERE run_id=? AND rel=? AND quarantined=0 AND sha256 IS NOT NULL`).get(runId,rel) as {sha256:string,kind:string,bytes:number}|undefined);
 if(files.some(file=>!file||file.sha256!==keep.sha256||file.kind==='video')){
  return error(reply,'Only verified identical non-video copies can be quarantined. Run the audit again.',409);
 }
 quarantining=true;
 try{
  const verified=[];
  try{
   for(let index=0;index<removeRels.length;index++){
    const rel=removeRels[index] as string;
    const file=files[index]!;
    const source=await fileAudit.verifyFile(rel,keep.sha256);
    const target=fileAudit.quarantinePath(runId,rel);
    try{await fs.lstat(target);return error(reply,`Quarantine destination already exists for ${rel}.`,409);}
    catch(e:any){if(e.code!=='ENOENT')throw e;}
    verified.push({rel,bytes:source.bytes,device:source.device,inode:source.inode,target,source:source.absolutePath});
   }
   await fileAudit.ensureQuarantineDirectory(runId);
  }catch(e){
   return error(reply,e instanceof Error?e.message:'Unable to verify selected files.',409);
  }
  const moved:string[]=[];
  const failures:Array<{rel:string,error:string}>=[];
  for(const file of verified){
   const now=new Date().toISOString();
   const info=db.prepare(`INSERT INTO file_quarantine
    (audit_run_id,original_rel,quarantine_rel,sha256,bytes,status,created_at)
    VALUES (?,?,?,?,?,'moving',?)`).run(runId,file.rel,path.relative(ROOT,file.target).split(path.sep).join('/'),keep.sha256,file.bytes,now);
   const quarantineId=Number(info.lastInsertRowid);
   let linked=false;
   let sourceRemoved=false;
   try{
    const sourceBefore=await fs.lstat(file.source);
    if(!sourceBefore.isFile()||sourceBefore.isSymbolicLink()||sourceBefore.dev!==file.device||sourceBefore.ino!==file.inode){
     throw new Error('Source file changed after verification; run the audit again.');
    }
    await fs.link(file.source,file.target);
    linked=true;
    const quarantineRel=path.relative(ROOT,file.target).split(path.sep).join('/');
    const quarantined=await fileAudit.verifyQuarantineFile(quarantineRel,keep.sha256);
    const sourceAfter=await fs.lstat(file.source);
    if(sourceAfter.dev!==quarantined.device||sourceAfter.ino!==quarantined.inode){
     throw new Error('Source file changed during quarantine; original was left in place.');
    }
    await fs.unlink(file.source);
    sourceRemoved=true;
    db.prepare('UPDATE file_quarantine SET status=\'quarantined\' WHERE id=?').run(quarantineId);
    db.prepare('UPDATE file_audit_files SET quarantined=1 WHERE run_id=? AND rel=?').run(runId,file.rel);
    moved.push(file.rel);
   }catch(e){
    if(linked&&!sourceRemoved)await fs.unlink(file.target).catch(cleanupError=>{
     req.log.error({err:cleanupError,rel:file.rel},'Failed to remove incomplete quarantine link');
    });
    const message=e instanceof Error?e.message:'Unable to quarantine file.';
    if(sourceRemoved){
     db.prepare("UPDATE file_quarantine SET status='quarantined',error=? WHERE id=?").run(message,quarantineId);
     db.prepare('UPDATE file_audit_files SET quarantined=1 WHERE run_id=? AND rel=?').run(runId,file.rel);
     moved.push(file.rel);
     failures.push({rel:file.rel,error:`Moved to quarantine, but status recording reported: ${message}`});
     continue;
    }
    db.prepare('UPDATE file_quarantine SET status=\'failed\',error=? WHERE id=?').run(message,quarantineId);
    failures.push({rel:file.rel,error:message});
   }
  }
  updateAuditDuplicateSummary(runId);
  return {moved,failures};
 }finally{quarantining=false;}
});
app.post('/api/quarantine/:id/restore',{preHandler:[requireOrigin,requireAuth]},async(req:any,reply)=>{
 if(!WRITE_ENABLED)return error(reply,'Write mode is disabled; restoring quarantined files requires explicit write mode.',403);
 if(scanning||auditing||quarantining||metadataMatching)return error(reply,'A library scan, audit, cleanup, or metadata matching run is already running.',409);
 const id=Number(req.params?.id);
 if(!Number.isSafeInteger(id)||id<1)return error(reply,'Invalid quarantine record id.');
 const item=db.prepare('SELECT * FROM file_quarantine WHERE id=?').get(id) as any;
 if(!item||!['quarantined','moving'].includes(item.status))return error(reply,'Quarantined file is not available to restore.',404);
 quarantining=true;
 try{
  try{
   const source=await fileAudit.verifyQuarantineFile(item.quarantine_rel,item.sha256);
   const target=await fileAudit.ensureRestoreDirectory(item.original_rel);
   try{await fs.lstat(target);return error(reply,'Original path is already occupied; restore was not performed.',409);}
   catch(e:any){if(e.code!=='ENOENT')throw e;}
   db.prepare("UPDATE file_quarantine SET status='restoring',error=NULL WHERE id=?").run(id);
   await fs.link(source.absolutePath,target);
   const restored=await fs.lstat(target);
   const quarantineAfter=await fs.lstat(source.absolutePath);
   if(restored.dev!==source.device||restored.ino!==source.inode
    ||quarantineAfter.dev!==restored.dev||quarantineAfter.ino!==restored.ino){
    await fs.unlink(target).catch(()=>{});
    throw new Error('Quarantined file changed during restore; no file was removed.');
   }
   try{await fs.unlink(source.absolutePath);}catch(e){await fs.unlink(target).catch(()=>{});throw e;}
   db.prepare("UPDATE file_quarantine SET status='restored',restored_at=? WHERE id=?").run(new Date().toISOString(),id);
   db.prepare('UPDATE file_audit_files SET quarantined=0 WHERE run_id=? AND rel=?').run(item.audit_run_id,item.original_rel);
   updateAuditDuplicateSummary(item.audit_run_id);
   return {ok:true,originalRel:item.original_rel};
  }catch(e){
   req.log.error({err:e,id},'Failed to restore quarantined file');
   return error(reply,e instanceof Error?e.message:'Unable to restore quarantined file.',409);
  }
 }finally{quarantining=false;}
});
app.post('/api/audit',{preHandler:[requireOrigin,requireAuth]},async(_req,reply)=>{
 if(scanning||auditing||quarantining||metadataMatching)return reply.code(409).send({error:'A library scan, audit, cleanup, or metadata matching run is already running.'});
 const startedAt=new Date().toISOString();
 const info=db.prepare("INSERT INTO file_audit_runs (status,started_at) VALUES ('queued',?)").run(startedAt);
 const runId=Number(info.lastInsertRowid);
 db.prepare(`DELETE FROM file_audit_files WHERE run_id IN (
  SELECT id FROM file_audit_runs WHERE id NOT IN (SELECT id FROM file_audit_runs ORDER BY id DESC LIMIT 5)
 )`).run();
 db.prepare('DELETE FROM file_audit_runs WHERE id NOT IN (SELECT id FROM file_audit_runs ORDER BY id DESC LIMIT 5)').run();
 auditing=true;
 setImmediate(()=>{
  void fileAudit.run(runId).catch(error=>{
   const message=error instanceof Error?error.message:'Unknown file audit failure.';
   app.log.error({err:error,runId},'File audit failed');
   fileAudit.fail(runId,message);
  }).finally(()=>{auditing=false;});
 });
 return reply.code(202).send({runId,status:'queued'});
});
app.get('/api/audit/:id',{preHandler:requireAuth},async(req:any,reply)=>{
 const id=Number(req.params?.id);
 if(!Number.isSafeInteger(id)||id<1)return reply.code(400).send({error:'Invalid file audit run id.'});
 const run=db.prepare('SELECT * FROM file_audit_runs WHERE id=?').get(id) as any;
 if(!run)return reply.code(404).send({error:'File audit run not found.'});
 if(run.status!=='completed')return {run,duplicateGroups:[],mediaRelatedFiles:[],otherTypes:[],hashErrors:[]};
 const duplicateGroups=db.prepare(`SELECT sha256 AS hash,MIN(bytes) AS bytes,COUNT(*) AS count
  FROM file_audit_files WHERE run_id=? AND sha256 IS NOT NULL AND quarantined=0 GROUP BY sha256 HAVING COUNT(*)>1
  ORDER BY bytes DESC,hash LIMIT 500`).all(id) as Array<{hash:string,bytes:number,count:number}>;
 const duplicates=db.prepare(`SELECT rel,category,kind,bytes,sha256 AS hash FROM file_audit_files
  WHERE run_id=? AND quarantined=0 AND sha256 IN (SELECT sha256 FROM file_audit_files WHERE run_id=? AND sha256 IS NOT NULL AND quarantined=0
   GROUP BY sha256 HAVING COUNT(*)>1 ORDER BY MIN(bytes) DESC,sha256 LIMIT 500)
  ORDER BY sha256,rel LIMIT 5000`).all(id,id) as Array<{rel:string,category:string,kind:string,bytes:number,hash:string}>;
 const duplicateMap=new Map<string,{hash:string,bytes:number,count:number,files:Array<{rel:string,category:string,kind:string}>}>();
 for(const group of duplicateGroups)duplicateMap.set(group.hash,{...group,files:[]});
 for(const file of duplicates)duplicateMap.get(file.hash)?.files.push({rel:file.rel,category:file.category,kind:file.kind});
 const mediaRelatedFiles=db.prepare(`SELECT rel,category,extension,kind,bytes,error FROM file_audit_files
  WHERE run_id=? AND kind IN ('subtitle','artwork','metadata','archive') ORDER BY kind,rel LIMIT 2000`).all(id);
 const otherTypes=db.prepare(`SELECT extension,COUNT(*) AS count,COALESCE(SUM(bytes),0) AS bytes FROM file_audit_files
  WHERE run_id=? AND kind='other' GROUP BY extension ORDER BY count DESC,extension`).all(id);
 const hashErrors=db.prepare('SELECT rel,error FROM file_audit_files WHERE run_id=? AND error IS NOT NULL ORDER BY rel LIMIT 200').all(id);
 return {run,duplicateGroups:[...duplicateMap.values()],mediaRelatedFiles,otherTypes,hashErrors};
});
app.get('/api/quarantine',{preHandler:requireAuth},async()=>({
 items:db.prepare(`SELECT id,audit_run_id AS auditRunId,original_rel AS originalRel,quarantine_rel AS quarantineRel,
  bytes,status,error,created_at AS createdAt FROM file_quarantine WHERE status IN ('quarantined','moving','failed')
  ORDER BY id DESC`).all(),
}));
app.post('/api/scan',{preHandler:[requireOrigin,requireAuth]},async(_req,reply)=>{
 if(scanning||auditing||quarantining||metadataMatching)return reply.code(409).send({error:'A library scan, audit, cleanup, or metadata matching run is already running.'});
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
 if(metadataMatching)return error(reply,'Wait for metadata matching to finish before applying a rename.',409);
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
  await moveWithoutOverwrite(src,dst);
  const info=db.prepare('INSERT INTO operations (old_rel,new_rel,status,created_at) VALUES (?,?,?,?)').run(item.rel,item.proposal,'applied',new Date().toISOString());
  db.prepare('DELETE FROM inventory WHERE id=?').run(id);
  return {ok:true,operationId:info.lastInsertRowid};
 }catch(e:any){req.log.error(e);return error(reply,`Operation failed: ${e.code||e.message}`,409);}
});
app.post('/api/undo',{preHandler:[requireOrigin,requireAuth]},async(req:any,reply)=>{
 if(!WRITE_ENABLED)return error(reply,'Write mode is disabled',403);
 if(metadataMatching)return error(reply,'Wait for metadata matching to finish before undoing a rename.',409);
 const id=req.body?.id;
 if(!Number.isSafeInteger(id))return error(reply,'Invalid operation id');
 const op=db.prepare('SELECT * FROM operations WHERE id=?').get(id) as any;
 if(!op||op.status!=='applied')return error(reply,'Operation is not undoable',409);
 try{
  const src=await verifiedPath(op.new_rel),dst=await verifiedPath(op.old_rel);
  const st=await fs.lstat(src);if(!st.isFile())return error(reply,'Renamed file is missing',409);
  try{await fs.lstat(dst);return error(reply,'Original path is occupied',409);}catch(e:any){if(e.code!=='ENOENT')throw e;}
  await fs.mkdir(path.dirname(dst),{recursive:true});await verifiedPath(op.old_rel);
  await moveWithoutOverwrite(src,dst);
  try{
   db.transaction(()=>{
    if(op.inventory_retained){
     const suggestion=suggest(op.old_rel);
     const restored=db.prepare(`UPDATE inventory SET id=?,rel=?,issue=?,proposal=?,confidence=?,scanned_at=?
      WHERE id=? AND rel=?`).run(sha(op.old_rel),op.old_rel,suggestion.issue,suggestion.proposal,suggestion.confidence,
       new Date().toISOString(),sha(op.new_rel),op.new_rel);
     if(restored.changes!==1)throw new Error('The retained inventory entry is missing; rescan is required before this operation can be recorded as undone.');
    }
    db.prepare('UPDATE operations SET status=?,undone_at=? WHERE id=?').run('undone',new Date().toISOString(),id);
   })();
  }catch(error){
   try{
    try{await fs.lstat(src);throw new Error('Renamed path is occupied; automatic rollback was not possible.');}
    catch(checkError:any){if(checkError.code!=='ENOENT')throw checkError;}
    await moveWithoutOverwrite(dst,src);
   }catch(rollbackError){
    req.log.error({err:rollbackError,id,source:op.old_rel,destination:op.new_rel},'Failed to roll back an incomplete undo');
    throw new Error('Undo changed the media path, but its database update failed and automatic rollback was unsuccessful.');
   }
   throw error;
  }
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
