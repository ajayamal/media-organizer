# Media Organizer MVP

A self-hosted React + TypeScript dashboard, Fastify API, SQLite inventory and rename journal. Scans existing SSD media; suggests safe filename changes; previews each change; supports one-by-one approval and undo.

## Safeguards and limitations

- **Read-only by default:** the Docker media mounts use `:ro`, and `ENABLE_WRITES=false` independently disables changes.
- **No deletion endpoint, no automatic bulk changes.** Each high-confidence rename requires an explicit confirmation. Ambiguous anime absolute-numbered episodes, extras, OVAs, and inconsistent season numbers are *review only*.
- **No subtitle renaming yet.** Subtitles are left intact; do not apply a rename to a video with sidecar subtitles until this feature is added. Embedded subtitles are unaffected.
- **TMDB matching is read-only.** It stores provider candidates, score explanations, and possible destinations in SQLite; it never changes media files. Matching results are not wired to a batch execution UI yet.
- **Collision protection:** exclusive hard-link creation prevents overwriting a destination. Moves remain within the same underlying filesystem; the app rejects cross-filesystem hard links.
- **Undo:** records successful operations in SQLite; undo fails safely if the old name is occupied or the renamed file is missing. A process crash between filesystem change and journal write can leave an unjournaled rename, so this is **best-effort rollback, not transactional backup**.
- **File scanning:** recursively enumerates video extensions, excludes symlink entries, skips macOS `._` metadata proposals. Scan replaces the current inventory snapshot but preserves operation history.
- **Security:** password login (scrypt), HTTP-only SameSite=Strict cookie, same-origin checks for writes, no Docker socket, no public port binding. No TLS built into app: use SSH tunnel or private HTTPS reverse proxy. No built-in login rate limiting; restrict access to trusted networks. Password must be >=16 characters.
- **Not production-hardened against malicious local users who can mutate the same folders concurrently.** Use a dedicated trusted server and avoid concurrent renames from other programs.
- **Folder renaming:** this version can create standardized movie/season folders; empty old folders are not removed automatically.

## Requirements

Ubuntu Server with Docker Engine and Compose plugin. Existing media at `/srv/data/movies` and `/srv/data/shows`. The app runs as UID 1000 (the default `node` user in the official Node image). On your server, UID 1000 corresponds to `sillygooze`. The named SQLite volume must be writable by UID 1000; Docker usually initializes its ownership from the image's `/app/data` directory.

## Build and launch (SSH on Ubuntu)

```bash
cd /srv/apps
# Transfer/extract media-organizer.zip here to create /srv/apps/media-organizer
cd /srv/apps/media-organizer
cp .env.example .env
nano .env # Set a unique strong ADMIN_PASSWORD (>=16 characters)
# Optionally set TMDB_READ_TOKEN to enable server-side metadata matching.
chmod 600 .env
docker compose up -d --build
docker compose logs -f organizer
```

**Secure access from Mac or Windows:** from your PC, open a terminal and run:

```bash
ssh -L 3100:127.0.0.1:3100 sillygooze@YOUR_SERVER_LAN_IP
```

Keep the SSH session open, then visit `http://localhost:3100` on that PC. This keeps the app off your public/LAN interfaces. You can alternatively use a trusted private HTTPS reverse proxy with access controls; set `COOKIE_SECURE=true` when the browser connects over HTTPS.

Click **Scan library**, review results. Scanning may take some time on large collections.

## Portainer deployment

1. Build the local image once on the Ubuntu host:

   ```bash
   cd /srv/apps/media-organizer
   docker build -t media-organizer:local .
   ```

2. In Portainer, select the **local** Docker environment, then **Stacks > Add stack > Web editor**. Name it `media-organizer`.
3. Paste the contents of `portainer-stack.yaml`. Add the environment variable `ADMIN_PASSWORD` in Portainer's stack environment variables section (strong, unique password, >=16 characters). Do not paste the password into the YAML.
4. Deploy. Portainer uses the image built on the same local Docker host. Use the SSH tunnel described above to access it.
5. To update the image later, rebuild on the host and recreate the service using Portainer's redeploy/pull-disabled options or `docker compose up -d --force-recreate` if using CLI deployment. **Do not deploy both CLI Compose and Portainer stacks simultaneously**, since they use the same container name/port.

## Enabling approved renames (later)

**Do not enable write mode until you have reviewed the proposals and backed up the SQLite volume and important media metadata.** In particular, avoid applying renames to movies with external subtitle files in this MVP.

### CLI Compose

```bash
cd /srv/apps/media-organizer
docker compose -f compose.yaml -f compose.write.yaml up -d
```

This overrides the media mounts to `:rw` and sets `ENABLE_WRITES=true`. Confirm `docker inspect media-organizer` shows the expected mounts. Approve only individual high-confidence proposals in the UI. The backend rechecks source size and destination existence before each rename.

Return to read-only mode:

```bash
docker compose -f compose.yaml up -d --force-recreate
```

### Portainer

In the existing stack editor, explicitly change **both** media volume modes from `:ro` to `:rw` and set `ENABLE_WRITES: "true"`. Redeploy. To return to read-only mode, revert both settings and redeploy. Keep `/app/data` as a persistent named volume, or undo history will be lost.

**Permissions:** `sillygooze` owns the media on this server (UID 1000). Docker's `node` user is UID 1000. If ownership differs, do not `chmod -R 777`; instead investigate permissions first.

## API endpoints

- `GET /api/status` — authentication and write-mode status
- `POST /api/login` — password login
- `POST /api/logout` — logout
- `POST /api/scan` — scan library (authenticated)
- `POST /api/metadata/match` — start an asynchronous metadata-matching run (requires `TMDB_READ_TOKEN`)
- `GET /api/metadata/match/:id` — get run progress and its matching results (authenticated)
- `GET /api/inventory` — inventory and proposals
- `GET /api/operations` — journal
- `POST /api/apply` — `{ "id": "<inventory-id>", "expectedProposal": "<proposed-relative-path>" }`
- `POST /api/undo` — `{ "id": 123 }`

## Development

### TMDB metadata matching

Set `TMDB_READ_TOKEN` in `.env` to a TMDB API Read Access Token. The token stays on the server and is sent only to TMDB; do not put it in frontend code or commit it. If unset, the application starts normally and the matching endpoint returns a clear `503` response.

After scanning, an authenticated `POST /api/metadata/match` starts a background run and returns a run ID. Poll `GET /api/metadata/match/:id` for progress, candidate titles, confidence explanations, and proposed destinations. Movie and TV searches are separate. Search, alternative-title, and season/episode responses are cached in SQLite; requests have timeouts, retries, and rate spacing.

Scores are deterministic (title similarity, year evidence, and media type): 90–100 is high, 70–89 medium, and below 70 low. These are heuristic scores, not probabilities. Ambiguity, year conflicts, and episode safety checks can prevent high-confidence classification regardless of score.

Episode proposals require a standard `SxxEyy` filename and a matching TMDB season/episode. Absolute anime episode numbers, specials, conflicting season folders, ambiguous candidates, and year mismatches remain in review. This phase only writes matching metadata to the app database; it never renames files.

```bash
cd server && npm install && ADMIN_PASSWORD='replace-with-a-long-random-password' MEDIA_ROOT=/srv/data DATA_DIR=./dev-data npm run dev
# separate terminal:
cd web && npm install && npm run dev
```

Vite runs on port 5173 and proxies `/api` to Fastify port 3100. Use only on a trusted development machine; avoid exposing the dev server publicly.

## What to add next

Frontend matching dashboard, review corrections, dry-run batch preview, and safe grouped rename execution remain future work. This MVP does not perform them automatically.
