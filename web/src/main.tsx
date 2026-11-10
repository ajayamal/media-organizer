import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  AlertTriangle,
  Check,
  Database,
  Film,
  FolderOpen,
  HardDrive,
  LogOut,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import './style.css';

type Item = {
  id: string;
  rel: string;
  bytes: number;
  category: string;
  issue: string;
  proposal: string | null;
  confidence: string;
};

type Op = {
  id: number;
  old_rel: string;
  new_rel: string;
  status: string;
  created_at: string;
};

type MatchCandidate = {
  id: number;
  mediaType: 'movie' | 'tv';
  title: string;
  originalTitle: string;
  year?: number;
  aliases: string[];
  score: number;
  titleSimilarity: number;
  explanations: string[];
  ambiguous: boolean;
};

type MetadataMatch = {
  inventoryId: string;
  rel: string;
  providerId: number | null;
  providerType: 'movie' | 'tv' | null;
  title: string | null;
  originalTitle: string | null;
  releaseYear: number | null;
  episodeTitle: string | null;
  confidenceScore: number;
  confidence: 'high' | 'medium' | 'low' | 'unmatched' | 'preserved';
  matchStatus: 'matched' | 'review' | 'unmatched' | 'preserved';
  explanations: string[];
  candidates: MatchCandidate[];
  season: number | null;
  episode: number | null;
  proposedRel: string | null;
  error: string | null;
  updatedAt: string;
};

type MatchRun = {
  id: number;
  status: 'queued' | 'running' | 'completed' | 'failed';
  total: number;
  processed: number;
  matched: number;
  review: number;
  unmatched: number;
  preserved: number;
  errors: number;
  error: string | null;
  started_at: string;
  completed_at: string | null;
};

type Tab = 'library' | 'metadata' | 'history';
type MatchFilter = 'all' | 'high' | 'medium' | 'low' | 'unmatched' | 'preserved';

type MetadataGroup = {
  key: string;
  title: string;
  year: number | null;
  mediaType: 'movie' | 'tv' | null;
  matches: MetadataMatch[];
};

async function api<T>(url: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch('/api' + url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw Error(data.error || 'Request failed');
  return data;
}

function getStoredRunId(): number | null {
  const value = Number(window.sessionStorage.getItem('media-organizer-metadata-run'));
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function App() {
  const [authed, setAuthed] = useState(false);
  const [password, setPassword] = useState('');
  const [writes, setWrites] = useState(false);
  const [items, setItems] = useState<Item[]>([]);
  const [ops, setOps] = useState<Op[]>([]);
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<Tab>('library');
  const [busy, setBusy] = useState(false);
  const [matchingBusy, setMatchingBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [matchError, setMatchError] = useState('');
  const [filter, setFilter] = useState('all');
  const [matchFilter, setMatchFilter] = useState<MatchFilter>('all');
  const [matchRunId, setMatchRunId] = useState<number | null>(getStoredRunId);
  const [matchRun, setMatchRun] = useState<MatchRun | null>(null);
  const [matches, setMatches] = useState<MetadataMatch[]>([]);

  const load = async () => {
    const [inventory, history] = await Promise.all([
      api<{ items: Item[] }>('/inventory'),
      api<{ items: Op[] }>('/operations'),
    ]);
    setItems(inventory.items);
    setOps(history.items);
  };

  useEffect(() => {
    api<{ authenticated: boolean; writesEnabled: boolean }>('/status')
      .then(status => {
        setAuthed(status.authenticated);
        setWrites(status.writesEnabled);
        if (status.authenticated) load().catch(error => setMsg(error.message));
      })
      .catch(error => setMsg(error.message));
  }, []);

  useEffect(() => {
    if (!authed || matchRunId === null || matchRun?.status === 'completed' || matchRun?.status === 'failed') return;
    let active = true;
    const poll = async () => {
      try {
        const result = await api<{ run: MatchRun; matches: MetadataMatch[] }>(`/metadata/match/${matchRunId}`);
        if (!active) return;
        setMatchRun(result.run);
        setMatches(result.matches);
        setMatchError('');
      } catch (error) {
        if (active) setMatchError(error instanceof Error ? error.message : 'Unable to load metadata matching results.');
      }
    };
    void poll();
    const interval = window.setInterval(() => void poll(), 1500);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [authed, matchRunId, matchRun?.status]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setMsg('');
    try {
      await fn();
      await load();
    } catch (error) {
      setMsg(error instanceof Error ? error.message : 'Request failed');
    } finally {
      setBusy(false);
    }
  };

  const login = async (event: React.FormEvent) => {
    event.preventDefault();
    await run(async () => {
      await api('/login', 'POST', { password });
      setAuthed(true);
      setPassword('');
    });
  };

  const scan = () => run(async () => {
    const result = await api<{ count: number }>('/scan', 'POST');
    setMsg(`Scanned ${result.count} media files.`);
  });

  const startMatching = async () => {
    setMatchingBusy(true);
    setMatchError('');
    setMsg('');
    try {
      const result = await api<{ runId: number; status: MatchRun['status']; total: number }>('/metadata/match', 'POST');
      window.sessionStorage.setItem('media-organizer-metadata-run', String(result.runId));
      setMatchRunId(result.runId);
      setMatches([]);
      setMatchRun({
        id: result.runId,
        status: result.status,
        total: result.total,
        processed: 0,
        matched: 0,
        review: 0,
        unmatched: 0,
        preserved: 0,
        errors: 0,
        error: null,
        started_at: new Date().toISOString(),
        completed_at: null,
      });
    } catch (error) {
      setMatchError(error instanceof Error ? error.message : 'Unable to start metadata matching.');
    } finally {
      setMatchingBusy(false);
    }
  };

  const apply = (item: Item) => {
    if (!item.proposal || !window.confirm(`Rename this file?\n\nFROM: ${item.rel}\n\nTO: ${item.proposal}\n\nNo files will be deleted.`)) return;
    void run(() => api('/apply', 'POST', { id: item.id, expectedProposal: item.proposal }));
  };

  const undo = (op: Op) => {
    if (!window.confirm(`Undo rename?\n\nFROM: ${op.new_rel}\n\nBACK TO: ${op.old_rel}`)) return;
    void run(() => api('/undo', 'POST', { id: op.id }));
  };

  const logout = () => run(async () => {
    await api('/logout', 'POST');
    setAuthed(false);
    setItems([]);
    setOps([]);
    setMatchRunId(null);
    setMatchRun(null);
    setMatches([]);
    window.sessionStorage.removeItem('media-organizer-metadata-run');
  });

  const visible = items.filter(item =>
    (filter === 'all' || item.confidence === filter)
    && `${item.rel} ${item.issue}`.toLowerCase().includes(query.toLowerCase()),
  );
  const totalBytes = items.reduce((total, item) => total + item.bytes, 0);
  const high = items.filter(item => item.confidence === 'high' && item.proposal).length;
  const review = items.filter(item => item.confidence === 'review').length;
  const filteredMatches = matches.filter(match => matchFilter === 'all' || match.confidence === matchFilter);
  const groups = groupMatches(filteredMatches);
  const progress = matchRun && matchRun.total > 0
    ? Math.min(100, Math.round((matchRun.processed / matchRun.total) * 100))
    : matchRun?.status === 'completed' ? 100 : 0;
  const matchingActive = matchRun?.status === 'queued' || matchRun?.status === 'running';

  if (!authed) {
    return (
      <main className="login">
        <div className="login-card">
          <div className="brand-icon"><HardDrive size={25} /></div>
          <h1>Media Organizer</h1>
          <p>Private dashboard for your home media server</p>
          <form onSubmit={login}>
            <label>Admin password</label>
            <input type="password" value={password} onChange={event => setPassword(event.target.value)} autoFocus required minLength={16} />
            <button disabled={busy} type="submit">Unlock dashboard</button>
          </form>
          {msg && <p className="error">{msg}</p>}
          <small>Keep this application on your LAN or Tailscale network.</small>
        </div>
      </main>
    );
  }

  return (
    <div className="app">
      <aside>
        <div className="logo">
          <div className="brand-icon"><HardDrive size={21} /></div>
          <div><strong>Media Organizer</strong><span>HOME SERVER</span></div>
        </div>
        <nav>
          <button className={tab === 'library' ? 'active' : ''} onClick={() => setTab('library')}><FolderOpen size={18} />Library</button>
          <button className={tab === 'metadata' ? 'active' : ''} onClick={() => setTab('metadata')}><Sparkles size={18} />Metadata matching</button>
          <button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}><RotateCcw size={18} />Operation history</button>
        </nav>
        <div className="aside-bottom">
          <div className="mode">
            <ShieldCheck size={17} />
            <div><strong>{writes ? 'Write-enabled' : 'Read-only mode'}</strong><small>{writes ? 'Approvals required' : 'Media protected'}</small></div>
          </div>
          <button className="logout" onClick={logout}><LogOut size={16} />Sign out</button>
        </div>
      </aside>
      <main className="main">
        <header>
          <div>
            <span className="eyebrow">MEDIA MANAGEMENT</span>
            <h1>{tab === 'library' ? 'Your media library' : tab === 'metadata' ? 'Metadata matching' : 'Operation history'}</h1>
            <p>{tab === 'library'
              ? 'Scan, review, and organize your existing files safely.'
              : tab === 'metadata'
                ? 'Find provider matches and review safe rename proposals.'
                : 'Review applied changes and undo eligible renames.'}</p>
          </div>
          {tab === 'library' && <button className="primary" disabled={busy} onClick={scan}><RefreshCw size={16} />{busy ? 'Working...' : 'Scan library'}</button>}
        </header>

        {msg && <div className="notice"><AlertTriangle size={16} />{msg}<button onClick={() => setMsg('')}>×</button></div>}

        {tab === 'library' && (
          <>
            <section className="stats">
              <article><div className="stat-icon"><Film size={19} /></div><span>Media files</span><strong>{items.length.toLocaleString()}</strong><small>Video files indexed</small></article>
              <article><div className="stat-icon"><HardDrive size={19} /></div><span>Media size</span><strong>{(totalBytes / 1024 ** 3).toFixed(1)} GB</strong><small>Indexed videos only</small></article>
              <article><div className="stat-icon green"><Check size={19} /></div><span>Ready to rename</span><strong>{high}</strong><small>High-confidence suggestions</small></article>
              <article><div className="stat-icon amber"><AlertTriangle size={19} /></div><span>Needs review</span><strong>{review}</strong><small>Ambiguous or special files</small></article>
            </section>
            <section className="panel">
              <div className="panel-top">
                <div><h2>File inventory</h2><p>Suggestions never execute until you explicitly approve them.</p></div>
                <div className="controls">
                  <div className="search"><Search size={16} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search files..." /></div>
                  <select value={filter} onChange={event => setFilter(event.target.value)}>
                    <option value="all">All files</option><option value="high">Ready</option><option value="review">Review</option><option value="none">Preserved</option>
                  </select>
                </div>
              </div>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Current file</th><th>Proposed destination / issue</th><th>Confidence</th><th>Action</th></tr></thead>
                  <tbody>{visible.map(item => (
                    <tr key={item.id}>
                      <td><div className="file-name">{item.rel.split('/').at(-1)}</div><div className="file-path">{item.rel.slice(0, -item.rel.split('/').at(-1)!.length)}</div></td>
                      <td><div className="proposal">{item.proposal ? item.proposal.split('/').at(-1) : item.issue}</div>{item.proposal && <div className="file-path">{item.proposal.slice(0, -item.proposal.split('/').at(-1)!.length)}</div>}</td>
                      <td><ConfidencePill confidence={item.confidence === 'high' ? 'high' : item.confidence === 'review' ? 'medium' : 'preserved'} /></td>
                      <td>{item.proposal && item.confidence === 'high' ? <button className="small-button" disabled={!writes || busy} title={!writes ? 'Enable write mode in Docker configuration first' : ''} onClick={() => apply(item)}>Approve</button> : <span className="dash">—</span>}</td>
                    </tr>
                  ))}</tbody>
                </table>
                {visible.length === 0 && <div className="empty">{items.length === 0 ? 'No files indexed yet. Click “Scan library” to begin.' : 'No files match your filters.'}</div>}
              </div>
              <footer>{visible.length} matching files · No automatic changes</footer>
            </section>
          </>
        )}

        {tab === 'metadata' && (
          <MetadataPanel
            itemsCount={items.length}
            matchRun={matchRun}
            matchingActive={Boolean(matchingActive)}
            matchingBusy={matchingBusy}
            matches={filteredMatches}
            groups={groups}
            filter={matchFilter}
            progress={progress}
            error={matchError}
            onStart={startMatching}
            onFilter={setMatchFilter}
          />
        )}

        {tab === 'history' && (
          <section className="panel">
            <div className="panel-top"><div><h2>Rename journal</h2><p>Only operations performed by this application are shown.</p></div></div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Original path</th><th>New path</th><th>Status</th><th>Action</th></tr></thead>
                <tbody>{ops.map(op => (
                  <tr key={op.id}>
                    <td className="file-path">{op.old_rel}</td><td className="file-path">{op.new_rel}</td>
                    <td><span className={`pill ${op.status === 'applied' ? 'high' : 'none'}`}>{op.status}</span></td>
                    <td>{op.status === 'applied' ? <button className="small-button" disabled={!writes || busy} onClick={() => undo(op)}>Undo</button> : '—'}</td>
                  </tr>
                ))}</tbody>
              </table>
              {ops.length === 0 && <div className="empty">No rename operations have been applied yet.</div>}
            </div>
          </section>
        )}

        <div className="footnote"><ShieldCheck size={15} />Only video files are scanned. Extras and AppleDouble files are flagged or preserved. Subtitles are never deleted.</div>
      </main>
    </div>
  );
}

function groupMatches(matches: MetadataMatch[]): MetadataGroup[] {
  const grouped = new Map<string, MetadataGroup>();
  for (const match of matches) {
    const key = match.providerType === 'tv' && match.providerId !== null
      ? `tv:${match.providerId}`
      : `file:${match.inventoryId}`;
    let group = grouped.get(key);
    if (!group) {
      group = {
        key,
        title: match.title || 'No metadata match',
        year: match.releaseYear,
        mediaType: match.providerType,
        matches: [],
      };
      grouped.set(key, group);
    }
    group.matches.push(match);
  }
  return [...grouped.values()].sort((a, b) => a.title.localeCompare(b.title));
}

function MetadataPanel({
  itemsCount,
  matchRun,
  matchingActive,
  matchingBusy,
  matches,
  groups,
  filter,
  progress,
  error,
  onStart,
  onFilter,
}: {
  itemsCount: number;
  matchRun: MatchRun | null;
  matchingActive: boolean;
  matchingBusy: boolean;
  matches: MetadataMatch[];
  groups: MetadataGroup[];
  filter: MatchFilter;
  progress: number;
  error: string;
  onStart: () => void;
  onFilter: (filter: MatchFilter) => void;
}) {
  return (
    <>
      <section className="metadata-intro panel">
        <div className="metadata-intro-icon"><Database size={21} /></div>
        <div className="metadata-intro-copy">
          <h2>Match your library with TMDB</h2>
          <p>Matching looks up movie and series metadata, scores candidate titles, and verifies standard episode numbers. It never renames or modifies media files.</p>
        </div>
        <button className="primary" disabled={matchingActive || matchingBusy || itemsCount === 0} onClick={onStart}>
          <Sparkles size={16} />{matchingBusy ? 'Starting...' : matchingActive ? 'Matching...' : matchRun ? 'Run matching again' : 'Start matching'}
        </button>
      </section>

      {itemsCount === 0 && <div className="empty panel-empty">Scan the library before starting metadata matching.</div>}
      {error && <div className="notice"><AlertTriangle size={16} />{error}</div>}

      {matchRun && (
        <>
          <section className="match-progress panel">
            <div className="match-progress-heading">
              <div><span className="eyebrow">RUN #{matchRun.id}</span><h2>{runStatusLabel(matchRun.status)}</h2></div>
              {matchingActive && <span className="progress-percent">{progress}%</span>}
            </div>
            <div className="progress-track"><div className="progress-value" style={{ width: `${progress}%` }} /></div>
            <div className="progress-summary">
              <span>{matchRun.processed.toLocaleString()} of {matchRun.total.toLocaleString()} files processed</span>
              {matchRun.status === 'completed' && <span>Completed {matchRun.completed_at ? new Date(matchRun.completed_at).toLocaleString() : ''}</span>}
            </div>
            {matchRun.error && <p className="error-text">{matchRun.error}</p>}
            <div className="match-stats">
              <div><strong>{matchRun.matched}</strong><span>High confidence</span></div>
              <div><strong>{matchRun.review}</strong><span>Needs review</span></div>
              <div><strong>{matchRun.unmatched}</strong><span>Unmatched</span></div>
              <div><strong>{matchRun.preserved}</strong><span>Preserved</span></div>
            </div>
            {matchRun.errors > 0 && <p className="match-note">{matchRun.errors} file(s) encountered a provider or metadata lookup error.</p>}
          </section>

          <section className="panel metadata-results">
            <div className="panel-top metadata-results-top">
              <div><h2>Match results</h2><p>Scores are heuristic, not probabilities. Review every proposed destination before acting.</p></div>
              <select value={filter} onChange={event => onFilter(event.target.value as MatchFilter)} aria-label="Filter match confidence">
                <option value="all">All results</option>
                <option value="high">High confidence</option>
                <option value="medium">Medium confidence</option>
                <option value="low">Low confidence</option>
                <option value="unmatched">Unmatched</option>
                <option value="preserved">Preserved</option>
              </select>
            </div>
            {matches.length === 0
              ? <div className="empty">{matchingActive ? 'Waiting for matching results...' : 'No results for this filter.'}</div>
              : <div className="match-groups">{groups.map(group => <MetadataGroupCard key={group.key} group={group} />)}</div>}
            <footer>{matches.length} result(s) shown · Metadata matching is read-only</footer>
          </section>
        </>
      )}
    </>
  );
}

function MetadataGroupCard({ group }: { group: MetadataGroup }) {
  const average = Math.round(group.matches.reduce((total, match) => total + match.confidenceScore, 0) / group.matches.length);
  const matchedEpisodes = group.matches.filter(match => match.providerType === 'tv' && match.episodeTitle).length;
  const isSeries = group.mediaType === 'tv';
  return (
    <details className="match-group" open={group.matches.length === 1}>
      <summary>
        <div className="group-heading">
          <span className="group-kind">{isSeries ? 'SERIES' : group.mediaType === 'movie' ? 'MOVIE' : 'FILE'}</span>
          <strong>{group.title}{group.year ? ` (${group.year})` : ''}</strong>
          <span className="group-count">{isSeries ? `${matchedEpisodes}/${group.matches.length} episodes verified` : `${group.matches.length} file${group.matches.length === 1 ? '' : 's'}`}</span>
        </div>
        <div className="group-score"><ConfidencePill confidence={group.matches.some(match => match.confidence === 'high') ? 'high' : group.matches[0].confidence} /><span>{average}/100 avg.</span></div>
      </summary>
      <div className="match-rows">
        {group.matches.map(match => <MetadataMatchRow key={match.inventoryId} match={match} />)}
      </div>
    </details>
  );
}

function MetadataMatchRow({ match }: { match: MetadataMatch }) {
  return (
    <article className="match-row">
      <div className="match-row-main">
        <div className="match-path">{match.rel}</div>
        {match.episodeTitle && <div className="episode-title">{match.season != null && match.episode != null ? `S${String(match.season).padStart(2, '0')}E${String(match.episode).padStart(2, '0')} · ` : ''}{match.episodeTitle}</div>}
        {match.proposedRel && <div className="match-proposal"><span>Proposed</span><code>{match.proposedRel}</code></div>}
      </div>
      <div className="match-row-score">
        <ConfidencePill confidence={match.confidence} />
        <strong>{match.confidenceScore}/100</strong>
      </div>
      <details className="match-explanation">
        <summary>Why?</summary>
        <ul>{match.explanations.map((explanation, index) => <li key={`${match.inventoryId}-ex-${index}`}>{explanation}</li>)}</ul>
        {match.candidates.length > 1 && (
          <div className="candidate-list">
            <strong>Other candidates</strong>
            {match.candidates.slice(1).map(candidate => <div key={candidate.id}>{candidate.title} ({candidate.year || 'year unknown'}) · {candidate.score}/100</div>)}
          </div>
        )}
      </details>
    </article>
  );
}

function ConfidencePill({ confidence }: { confidence: string }) {
  const label = confidence === 'high' ? 'High' : confidence === 'medium' ? 'Review' : confidence === 'low' ? 'Low' : confidence === 'unmatched' ? 'Unmatched' : 'Preserved';
  return <span className={`pill confidence-${confidence}`}>{label}</span>;
}

function runStatusLabel(status: MatchRun['status']): string {
  if (status === 'queued') return 'Matching queued';
  if (status === 'running') return 'Matching in progress';
  if (status === 'failed') return 'Matching failed';
  return 'Matching complete';
}

createRoot(document.getElementById('root')!).render(<App />);
