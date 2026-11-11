import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { findEmptyFolders, removeEmptyFolders } from '../src/services/empty-folders.js';

test('finds empty-only folder trees without listing roots or hidden folders', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'media-organizer-empty-folders-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'movies/Movies/Empty Series/Season 01'), { recursive: true });
  await mkdir(path.join(root, 'movies/Movies/Has Files/Empty Child'), { recursive: true });
  await mkdir(path.join(root, 'movies/Movies/.media-organizer-quarantine/Empty'), { recursive: true });
  await mkdir(path.join(root, 'shows/Tv Shows'), { recursive: true });
  await writeFile(path.join(root, 'movies/Movies/Has Files/movie.mkv'), 'content');

  const folders = await findEmptyFolders(root, ['movies/Movies', 'shows/Tv Shows']);

  assert.deepEqual(folders, [
    'movies/Movies/Empty Series',
    'movies/Movies/Empty Series/Season 01',
    'movies/Movies/Has Files/Empty Child',
  ]);
  assert.ok(!folders.includes('movies/Movies'));
  assert.ok(!folders.some(folder => folder.includes('.media-organizer-quarantine')));
});

test('removes only scanned empty folders, deepest first, and preserves files', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'media-organizer-empty-cleanup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const category = 'shows/Tv Shows';
  const emptyTree = path.join(root, category, 'Empty Show', 'Season 01');
  const nonEmpty = path.join(root, category, 'Still Here');
  await mkdir(emptyTree, { recursive: true });
  await mkdir(nonEmpty, { recursive: true });
  await writeFile(path.join(nonEmpty, 'episode.mkv'), 'keep');

  const folders = await findEmptyFolders(root, [category]);
  const result = await removeEmptyFolders(root, [category], folders);

  assert.deepEqual(result.removed, [
    'shows/Tv Shows/Empty Show/Season 01',
    'shows/Tv Shows/Empty Show',
  ]);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(await readdir(nonEmpty), ['episode.mkv']);
  await assert.rejects(readdir(path.join(root, category, 'Empty Show')), { code: 'ENOENT' });
});

test('rechecks candidate emptiness and rejects stale paths before removal', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'media-organizer-empty-stale-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = path.join(root, 'movies/Anime/Now Populated');
  await mkdir(folder, { recursive: true });
  const candidates = await findEmptyFolders(root, ['movies/Anime']);
  await writeFile(path.join(folder, 'keep.txt'), 'keep');

  await assert.rejects(
    removeEmptyFolders(root, ['movies/Anime'], candidates),
    /no longer empty/,
  );
  assert.deepEqual(await readdir(folder), ['keep.txt']);
});

test('finds and removes empty folders under the storage root', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'media-organizer-storage-empty-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const emptyFolder = path.join(root, 'storage/Unsorted/Empty Movie');
  await mkdir(emptyFolder, { recursive: true });

  const folders = await findEmptyFolders(root, ['storage']);
  assert.deepEqual(folders, ['storage/Unsorted', 'storage/Unsorted/Empty Movie']);
  const result = await removeEmptyFolders(root, ['storage'], folders);
  assert.deepEqual(result.removed, ['storage/Unsorted/Empty Movie', 'storage/Unsorted']);
  assert.deepEqual(result.failures, []);
});
