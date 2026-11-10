import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileAudit, classifyFile } from '../src/services/file-audit.js';

function createDatabase() {
  const files = new Map<string, Record<string, unknown>>();
  const runState: Record<string, unknown> = {};
  const db = {
    prepare(sql: string) {
      return {
        run(...values: unknown[]) {
          if (sql.includes('INSERT INTO file_audit_files')) {
            const [runId, rel, category, extension, kind, bytes] = values;
            files.set(String(rel), { run_id: runId, rel, category, extension, kind, bytes, sha256: null, error: null });
          } else if (sql.includes('UPDATE file_audit_files SET sha256')) {
            const [sha256, error, , rel] = values;
            const file = files.get(String(rel));
            if (file) Object.assign(file, { sha256, error });
          } else if (sql.includes('UPDATE file_audit_runs')) {
            Object.assign(runState, { sql, values });
          }
          return {};
        },
        get() {
          const groups = new Map<string, number>();
          for (const file of files.values()) {
            if (typeof file.sha256 === 'string') groups.set(file.sha256, (groups.get(file.sha256) ?? 0) + 1);
          }
          const duplicateGroups = [...groups.values()].filter(count => count > 1);
          return { groups: duplicateGroups.length, files: duplicateGroups.reduce((total, count) => total + count, 0) };
        },
      };
    },
    transaction(callback: () => void) {
      return callback;
    },
  };
  return { db, files, runState };
}

test('classifies media-related extensions and counts unknown files separately', () => {
  assert.deepEqual(classifyFile('episode.MKV'), { extension: '.mkv', kind: 'video' });
  assert.deepEqual(classifyFile('episode.srt'), { extension: '.srt', kind: 'subtitle' });
  assert.deepEqual(classifyFile('poster.webp'), { extension: '.webp', kind: 'artwork' });
  assert.deepEqual(classifyFile('movie.nfo'), { extension: '.nfo', kind: 'metadata' });
  assert.deepEqual(classifyFile('extras.zip'), { extension: '.zip', kind: 'archive' });
  assert.deepEqual(classifyFile('unknown.bin'), { extension: '.bin', kind: 'other' });
});

test('hashes only same-size candidates and reports exact duplicate content', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'media-organizer-audit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const movieDir = path.join(root, 'movies', 'Movies');
  const showDir = path.join(root, 'shows', 'Tv Shows');
  await mkdir(movieDir, { recursive: true });
  await mkdir(showDir, { recursive: true });
  const shared = Buffer.from('duplicate-content');
  await writeFile(path.join(movieDir, 'one.mkv'), shared);
  await writeFile(path.join(showDir, 'two.mkv'), shared);
  await writeFile(path.join(movieDir, 'caption.srt'), shared);
  await writeFile(path.join(movieDir, 'different.mkv'), Buffer.from('different-content'));
  await writeFile(path.join(movieDir, 'poster.jpg'), Buffer.from('image'));
  await writeFile(path.join(movieDir, 'unclassified.bin'), Buffer.from('unknown'));

  const { db, files, runState } = createDatabase();
  await new FileAudit(db as never, root, ['movies/Movies', 'shows/Tv Shows']).run(1);

  const duplicateFiles = [...files.values()].filter(file => typeof file.sha256 === 'string' && file.sha256 === files.get('movies/Movies/one.mkv')?.sha256);
  assert.equal(duplicateFiles.length, 3);
  assert.notEqual(files.get('movies/Movies/different.mkv')?.sha256, files.get('movies/Movies/one.mkv')?.sha256);
  assert.equal(files.get('movies/Movies/poster.jpg')?.kind, 'artwork');
  assert.equal(files.get('movies/Movies/unclassified.bin')?.kind, 'other');
  assert.equal(String(runState.sql).includes("status='completed'"), true);
});
