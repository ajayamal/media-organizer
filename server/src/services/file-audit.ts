import { createReadStream } from 'node:fs';
import { lstat, mkdir, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type Database from 'better-sqlite3';

const videoExtensions = new Set(['.mkv', '.mp4', '.avi', '.m4v', '.mov', '.webm']);
const fileKinds: Record<string, Set<string>> = {
  subtitle: new Set(['.srt', '.ass', '.ssa', '.sub', '.idx', '.vtt', '.smi', '.scc']),
  artwork: new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tif', '.tiff', '.avif']),
  metadata: new Set(['.nfo', '.xml', '.json', '.txt', '.cue', '.m3u', '.m3u8', '.sfv']),
  archive: new Set(['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz']),
};

interface AuditFile {
  rel: string;
  category: string;
  extension: string;
  kind: string;
  bytes: number;
  modifiedAt: number;
}

export function classifyFile(filename: string): { extension: string; kind: string } {
  const extension = path.posix.extname(filename).toLowerCase() || '[no extension]';
  if (videoExtensions.has(extension)) return { extension, kind: 'video' };
  for (const [kind, extensions] of Object.entries(fileKinds)) {
    if (extensions.has(extension)) return { extension, kind };
  }
  return { extension, kind: 'other' };
}

async function hashFile(filePath: string, expected: AuditFile): Promise<string> {
  const before = await lstat(filePath);
  if (!before.isFile() || before.isSymbolicLink() || before.size !== expected.bytes || before.mtimeMs !== expected.modifiedAt) {
    throw new Error('File changed during audit; run the audit again.');
  }

  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);

  const after = await lstat(filePath);
  if (!after.isFile() || after.isSymbolicLink() || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
    throw new Error('File changed during audit; run the audit again.');
  }
  return hash.digest('hex');
}

export class FileAudit {
  constructor(
    private readonly db: Database.Database,
    private readonly root: string,
    private readonly categories: string[],
  ) {}

  async verifyFile(rel: string, expectedHash: string): Promise<{ absolutePath: string; bytes: number; device: number; inode: number }> {
    if (!this.isManagedPath(rel)) throw new Error('File path is outside the audited media folders.');
    const absolutePath = path.resolve(this.root, rel);
    const relative = path.relative(this.root, absolutePath);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('File path escaped the media root.');
    }

    let current = this.root;
    for (const part of rel.split('/')) {
      current = path.join(current, part);
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) throw new Error('Symlink path blocked.');
      if (current !== absolutePath && !stat.isDirectory()) throw new Error('File path contains a non-directory parent.');
    }

    const stat = await lstat(absolutePath);
    if (!stat.isFile()) throw new Error('Only regular files can be quarantined.');
    const { extension, kind } = classifyFile(path.posix.basename(rel));
    if (kind === 'video') throw new Error('Video files cannot be removed by duplicate cleanup.');
    const actualHash = await hashFile(absolutePath, {
      rel,
      category: this.categoryFor(rel),
      extension,
      kind,
      bytes: stat.size,
      modifiedAt: stat.mtimeMs,
    });
    if (actualHash !== expectedHash) throw new Error('File contents changed since the audit; run the audit again.');
    return { absolutePath, bytes: stat.size, device: stat.dev, inode: stat.ino };
  }

  async verifyQuarantineFile(rel: string, expectedHash: string): Promise<{ absolutePath: string; bytes: number; device: number; inode: number }> {
    const parts = rel.split('/');
    if (parts.length !== 3 || parts[0] !== '.media-organizer-quarantine'
      || !/^audit-\d+$/.test(parts[1]) || !/^[a-f0-9]{64}$/.test(parts[2])) {
      throw new Error('Invalid quarantine file path.');
    }
    const absolutePath = path.resolve(this.root, rel);
    let current = this.root;
    for (const part of parts) {
      current = path.join(current, part);
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) throw new Error('Symlink quarantine path blocked.');
      if (current !== absolutePath && !stat.isDirectory()) throw new Error('Quarantine path contains a non-directory parent.');
    }
    const stat = await lstat(absolutePath);
    if (!stat.isFile()) throw new Error('Quarantine entry is not a regular file.');
    const actualHash = await hashFile(absolutePath, {
      rel,
      category: 'quarantine',
      extension: path.extname(absolutePath),
      kind: 'quarantine',
      bytes: stat.size,
      modifiedAt: stat.mtimeMs,
    });
    if (actualHash !== expectedHash) throw new Error('Quarantined file contents changed; restore was blocked.');
    return { absolutePath, bytes: stat.size, device: stat.dev, inode: stat.ino };
  }

  quarantinePath(runId: number, rel: string): string {
    if (!this.isManagedPath(rel)) throw new Error('File path is outside the audited media folders.');
    const pathHash = createHash('sha256').update(rel).digest('hex');
    return path.join(this.root, '.media-organizer-quarantine', `audit-${runId}`, pathHash);
  }

  async ensureQuarantineDirectory(runId: number): Promise<string> {
    const directory = path.join(this.root, '.media-organizer-quarantine', `audit-${runId}`);
    const rootDirectory = path.dirname(directory);
    await mkdir(rootDirectory, { recursive: true });
    const rootStat = await lstat(rootDirectory);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Quarantine directory is not a safe directory.');
    await mkdir(directory, { recursive: true });
    const directoryStat = await lstat(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error('Quarantine directory is not a safe directory.');
    return directory;
  }

  async ensureRestoreDirectory(rel: string): Promise<string> {
    if (!this.isManagedPath(rel)) throw new Error('Restore path is outside the audited media folders.');
    let current = this.root;
    const parts = rel.split('/');
    for (const part of parts.slice(0, -1)) {
      current = path.join(current, part);
      try {
        await mkdir(current);
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      }
      const stat = await lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Restore path contains an unsafe directory.');
    }
    return path.resolve(this.root, rel);
  }

  async run(runId: number): Promise<void> {
    this.db.prepare("UPDATE file_audit_runs SET status='running' WHERE id=?").run(runId);
    const files: AuditFile[] = [];
    for (const category of this.categories) {
      const directory = path.join(this.root, category);
      let directoryStat;
      try {
        directoryStat = await lstat(directory);
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
        throw error;
      }
      if (directoryStat.isDirectory() && !directoryStat.isSymbolicLink()) await this.walk(directory, category, files);
    }

    this.db.prepare("UPDATE file_audit_runs SET status='running',total=? WHERE id=?").run(files.length, runId);
    const insert = this.db.prepare(`INSERT INTO file_audit_files
      (run_id,rel,category,extension,kind,bytes,sha256,error) VALUES (?,?,?,?,?,?,NULL,NULL)`);
    const saveFiles = this.db.transaction(() => {
      this.db.prepare('DELETE FROM file_audit_files WHERE run_id=?').run(runId);
      for (const file of files) insert.run(runId, file.rel, file.category, file.extension, file.kind, file.bytes);
    });
    saveFiles();

    const sameSize = new Map<number, AuditFile[]>();
    for (const file of files) {
      const group = sameSize.get(file.bytes) ?? [];
      group.push(file);
      sameSize.set(file.bytes, group);
    }
    const candidates = [...sameSize.values()].filter(group => group.length > 1).flat();
    let processed = files.length - candidates.length;
    let errors = 0;
    const saveHash = this.db.prepare('UPDATE file_audit_files SET sha256=?,error=? WHERE run_id=? AND rel=?');
    const updateProgress = this.db.prepare('UPDATE file_audit_runs SET processed=?,errors=? WHERE id=?');
    updateProgress.run(processed, errors, runId);

    for (const file of candidates) {
      let digest: string | null = null;
      let errorMessage: string | null = null;
      try {
        const absolute = path.resolve(this.root, file.rel);
        const relative = path.relative(this.root, absolute);
        if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
          throw new Error('File path escaped the media root.');
        }
        digest = await hashFile(absolute, file);
      } catch (error) {
        errors++;
        errorMessage = error instanceof Error ? error.message : 'Unable to hash file.';
      }
      saveHash.run(digest, errorMessage, runId, file.rel);
      processed++;
      if (processed % 10 === 0 || processed === files.length) updateProgress.run(processed, errors, runId);
    }
    updateProgress.run(files.length, errors, runId);

    const duplicateSummary = this.db.prepare(`SELECT COUNT(*) AS groups,COALESCE(SUM(file_count),0) AS files FROM (
      SELECT COUNT(*) AS file_count FROM file_audit_files WHERE run_id=? AND sha256 IS NOT NULL GROUP BY sha256 HAVING COUNT(*)>1
    )`).get(runId) as { groups: number; files: number };
    const mediaRelated = files.filter(file => file.kind !== 'video' && file.kind !== 'other').length;
    const otherFiles = files.filter(file => file.kind === 'other').length;
    this.db.prepare(`UPDATE file_audit_runs SET status='completed',duplicate_groups=?,duplicate_files=?,
      media_related_files=?,other_files=?,completed_at=? WHERE id=?`)
      .run(duplicateSummary.groups, duplicateSummary.files, mediaRelated, otherFiles, new Date().toISOString(), runId);
  }

  fail(runId: number, message: string): void {
    this.db.prepare("UPDATE file_audit_runs SET status='failed',error=?,completed_at=? WHERE id=?")
      .run(message, new Date().toISOString(), runId);
  }

  private async walk(directory: string, category: string, files: AuditFile[]): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (category === 'storage' && entry.name.startsWith('.')) continue;
      const full = path.join(directory, entry.name);
      const stat = await lstat(full);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        await this.walk(full, category, files);
      } else if (stat.isFile()) {
        const rel = path.relative(this.root, full).split(path.sep).join('/');
        const { extension, kind } = classifyFile(entry.name);
        files.push({ rel, category, extension, kind, bytes: stat.size, modifiedAt: stat.mtimeMs });
      }
    }
  }

  private isManagedPath(rel: string): boolean {
    return typeof rel === 'string'
      && rel.length > 0
      && !rel.includes('\\')
      && !rel.includes('\0')
      && !path.posix.isAbsolute(rel)
      && rel.split('/').every(part => part !== '' && part !== '.' && part !== '..')
      && this.categories.some(category => rel.startsWith(`${category}/`));
  }

  private categoryFor(rel: string): string {
    return this.categories.find(category => rel.startsWith(`${category}/`))!;
  }
}
