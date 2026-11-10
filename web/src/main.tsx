import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  AlertTriangle,
  Check,
  Copy,
  Database,
  Files,
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
  manualCorrection: boolean;
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

type Tab = 'library' | 'audit' | 'metadata' | 'history';
type MatchFilter = 'all' | 'review' | 'high' | 'medium' | 'low' | 'unmatched' | 'preserved';

type AuditRun = {
  id: number;
  status: 'queued' | 'running' | 'completed' | 'failed';
  total: number;
  processed: number;
  duplicate_groups: number;
  duplicate_files: number;
  media_related_files: number;
  other_files: number;
  errors: number;
  error: string | null;
  started_at: string;
  completed_at: string | null;
};

type AuditReport = {
  run: AuditRun;
  duplicateGroups: Array<{
    hash: string;
    bytes: number;
    count: number;
    files: Array<{ rel: string; category: string; kind: string }>;
  }>;
  mediaRelatedFiles: Array<{
    rel: string;
    category: string;
    extension: string;
    kind: string;
    bytes: number;
    error: string | null;
  }>;
  otherTypes: Array<{ extension: string; count: number; bytes: number }>;
  hashErrors: Array<{ rel: string; error: string }>;
};

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

function getStoredAuditId(): number | null {
  const value = Number(window.sessionStorage.getItem('media-organizer-audit-run'));
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
  const [auditRunId, setAuditRunId] = useState<number | null>(getStoredAuditId);
  const [auditReport, setAuditReport] = useState<AuditReport | null>(null);
  const [auditBusy, setAuditBusy] = useState(false);
  const [auditError, setAuditError] = useState('');
  const [auditQuery, setAuditQuery] = useState('');

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

  useEffect(() => {
    if (!authed || auditRunId === null || auditReport?.run.status === 'completed' || auditReport?.run.status === 'failed') return;
    let active = true;
    const poll = async () => {
      try {
        const result = await api<AuditReport>(`/audit/${auditRunId}`);
        if (!active) return;
        setAuditReport(result);
        setAuditError('');
      } catch (error) {
        if (active) setAuditError(error instanceof Error ? error.message : 'Unable to load file audit results.');
      }
    };
    void poll();
    const interval = window.setInterval(() => void poll(), 1500);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [authed, auditRunId, auditReport?.run.status]);

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

  const startAudit = async () => {
    setAuditBusy(true);
    setAuditError('');
    try {
      const result = await api<{ runId: number; status: AuditRun['status'] }>('/audit', 'POST');
      window.sessionStorage.setItem('media-organizer-audit-run', String(result.runId));
      setAuditRunId(result.runId);
      setAuditReport({
        run: {
          id: result.runId,
          status: result.status,
          total: 0,
          processed: 0,
          duplicate_groups: 0,
          duplicate_files: 0,
          media_related_files: 0,
          other_files: 0,
          errors: 0,
          error: null,
          started_at: new Date().toISOString(),
          completed_at: null,
        },
        duplicateGroups: [],
        mediaRelatedFiles: [],
        otherTypes: [],
        hashErrors: [],
      });
    } catch (error) {
      setAuditError(error instanceof Error ? error.message : 'Unable to start the file audit.');
    } finally {
      setAuditBusy(false);
    }
  };

  const saveCorrection = async (
    match: MetadataMatch,
    correction: { candidateId: number; title: string; year: number | null; season: number | null; episode: number | null },
  ) => {
    if (!matchRun) throw new Error('No matching run is selected.');
    const result = await api<{ run: MatchRun; match: MetadataMatch }>(
      `/metadata/match/${matchRun.id}/${encodeURIComponent(match.inventoryId)}`,
      'PATCH',
      correction,
    );
    setMatchRun(result.run);
    setMatches(current => current.map(item => item.inventoryId === result.match.inventoryId ? result.match : item));
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
    setAuditRunId(null);
    setAuditReport(null);
    window.sessionStorage.removeItem('media-organizer-metadata-run');
    window.sessionStorage.removeItem('media-organizer-audit-run');
  });

  const visible = items.filter(item =>
    (filter === 'all' || item.confidence === filter)
    && `${item.rel} ${item.issue}`.toLowerCase().includes(query.toLowerCase()),
  );
  const totalBytes = items.reduce((total, item) => total + item.bytes, 0);
  const high = items.filter(item => item.confidence === 'high' && item.proposal).length;
  const review = items.filter(item => item.confidence === 'review').length;
  const filteredMatches = matches.filter(match =>
    matchFilter === 'all'
    || (matchFilter === 'review' ? match.matchStatus === 'review' : match.confidence === matchFilter),
  );
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
          <button className={tab === 'audit' ? 'active' : ''} onClick={() => setTab('audit')}><Files size={18} />File audit</button>
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
            <h1>{tab === 'library' ? 'Your media library' : tab === 'audit' ? 'File audit' : tab === 'metadata' ? 'Metadata matching' : 'Operation history'}</h1>
            <p>{tab === 'library'
              ? 'Scan, review, and organize your existing files safely.'
              : tab === 'audit'
                ? 'Find exact duplicate files and review media-related files without changing anything.'
                : tab === 'metadata'
                  ? 'Find provider matches and review safe rename proposals.'
                  : 'Review applied changes and undo eligible renames.'}</p>
          </div>
          {tab === 'library' && <button className="primary" disabled={busy} onClick={scan}><RefreshCw size={16} />{busy ? 'Working...' : 'Scan library'}</button>}
          {tab === 'audit' && <button className="primary" disabled={auditBusy || auditReport?.run.status === 'queued' || auditReport?.run.status === 'running'} onClick={startAudit}><RefreshCw size={16} />{auditBusy ? 'Starting...' : auditReport ? 'Run audit again' : 'Start file audit'}</button>}
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
            runId={matchRun?.id ?? null}
            onStart={startMatching}
            onFilter={setMatchFilter}
            onSaveCorrection={saveCorrection}
          />
        )}

        {tab === 'audit' && (
          <FileAuditPanel
            report={auditReport}
            error={auditError}
            query={auditQuery}
            onQuery={setAuditQuery}
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

        <div className="footnote"><ShieldCheck size={15} />{tab === 'audit'
          ? 'File audits are read-only. Exact duplicate groups are SHA-256 verified; files are never moved or deleted.'
          : 'Only video files are scanned for rename suggestions. Extras and AppleDouble files are preserved; subtitles are never deleted.'}</div>
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

function FileAuditPanel({
  report,
  error,
  query,
  onQuery,
}: {
  report: AuditReport | null;
  error: string;
  query: string;
  onQuery: (value: string) => void;
}) {
  if (!report) {
    return (
      <>
        <section className="metadata-intro panel">
          <div className="metadata-intro-icon"><Copy size={21} /></div>
          <div className="metadata-intro-copy">
            <h2>Read-only duplicate and file inventory</h2>
            <p>SHA-256 hashes are computed only for files sharing a size, then compared exactly. Common subtitles, artwork, metadata, and archives are listed; other file types are summarized by extension.</p>
          </div>
        </section>
        {error && <div className="notice"><AlertTriangle size={16} />{error}</div>}
        <div className="empty panel-empty">Start an audit to scan files in the configured media folders.</div>
      </>
    );
  }

  const { run } = report;
  const active = run.status === 'queued' || run.status === 'running';
  const progress = run.total > 0
    ? Math.min(100, Math.round(run.processed / run.total * 100))
    : run.status === 'completed' ? 100 : 0;
  const visibleMediaFiles = report.mediaRelatedFiles.filter(file =>
    `${file.rel} ${file.kind} ${file.extension}`.toLowerCase().includes(query.toLowerCase()),
  );
  const visibleDuplicateGroups = report.duplicateGroups.filter(group =>
    group.files.some(file => `${file.rel} ${file.kind}`.toLowerCase().includes(query.toLowerCase())),
  );

  return (
    <>
      {error && <div className="notice"><AlertTriangle size={16} />{error}</div>}
      <section className="match-progress panel">
        <div className="match-progress-heading">
          <div><span className="eyebrow">AUDIT #{run.id}</span><h2>{auditStatusLabel(run.status)}</h2></div>
          {active && run.total > 0 && <span className="progress-percent">{progress}%</span>}
        </div>
        <div className="progress-track"><div className="progress-value" style={{ width: `${progress}%` }} /></div>
        <div className="progress-summary">
          <span>{active && run.total === 0 ? 'Scanning file paths…' : `${run.processed.toLocaleString()} of ${run.total.toLocaleString()} files checked`}</span>
          {run.completed_at && <span>Completed {new Date(run.completed_at).toLocaleString()}</span>}
        </div>
        {run.error && <p className="error-text">{run.error}</p>}
        <div className="match-stats">
          <div><strong>{run.duplicate_groups.toLocaleString()}</strong><span>Exact duplicate groups</span></div>
          <div><strong>{run.duplicate_files.toLocaleString()}</strong><span>Files in duplicate groups</span></div>
          <div><strong>{run.media_related_files.toLocaleString()}</strong><span>Non-video media files</span></div>
          <div><strong>{run.other_files.toLocaleString()}</strong><span>Other file types</span></div>
        </div>
        {run.errors > 0 && <p className="match-note">{run.errors} candidate file(s) could not be hashed because they changed or became inaccessible.</p>}
      </section>

      <section className="panel audit-results">
        <div className="panel-top metadata-results-top">
          <div><h2>Audit details</h2><p>Duplicate candidates are compared by exact SHA-256 content. Search filters duplicate paths and listed media-related files.</p></div>
          <div className="search"><Search size={16} /><input value={query} onChange={event => onQuery(event.target.value)} placeholder="Search audit results..." /></div>
        </div>

        <section className="audit-section">
          <h3>Exact duplicate groups <span>{run.duplicate_groups.toLocaleString()}</span></h3>
          {active
            ? <div className="empty audit-empty">Duplicate groups will be available when hashing is complete.</div>
            : visibleDuplicateGroups.length === 0
              ? <div className="empty audit-empty">{run.duplicate_groups === 0 ? 'No exact duplicates found.' : 'No duplicate paths match your search.'}</div>
              : <div className="audit-list">
              {visibleDuplicateGroups.map(group => (
                <details className="audit-group" key={group.hash}>
                  <summary><strong>{group.count} identical files</strong><span>{formatBytes(group.bytes)} each</span></summary>
                  <ul>{group.files.map(file => <li key={file.rel}><code>{file.rel}</code><span>{file.kind}</span></li>)}</ul>
                  {group.files.length < group.count && <p className="audit-limit">Showing {group.files.length.toLocaleString()} of {group.count.toLocaleString()} identical paths.</p>}
                </details>
              ))}
              {run.duplicate_groups > report.duplicateGroups.length && <p className="audit-limit">Showing the first {report.duplicateGroups.length} duplicate groups.</p>}
            </div>}
        </section>

        <section className="audit-section">
          <h3>Media-related non-video files <span>{run.media_related_files.toLocaleString()}</span></h3>
          {active
            ? <div className="empty audit-empty">File inventory will be available when the audit completes.</div>
            : visibleMediaFiles.length === 0
              ? <div className="empty audit-empty">{run.media_related_files === 0 ? 'No subtitles, artwork, metadata, or archives found.' : 'No files match your search.'}</div>
            : <div className="table-wrap">
              <table>
                <thead><tr><th>Path</th><th>Type</th><th>Size</th></tr></thead>
                <tbody>{visibleMediaFiles.map(file => (
                  <tr key={file.rel}><td className="file-path">{file.rel}</td><td>{file.kind} · {file.extension}</td><td>{formatBytes(file.bytes)}</td></tr>
                ))}</tbody>
              </table>
              {run.media_related_files > report.mediaRelatedFiles.length && <p className="audit-limit">Showing {report.mediaRelatedFiles.length.toLocaleString()} of {run.media_related_files.toLocaleString()} media-related files.</p>}
            </div>}
        </section>

        <section className="audit-section">
          <h3>Other file types <span>{run.other_files.toLocaleString()}</span></h3>
          {active
            ? <div className="empty audit-empty">Extension counts will be available when the audit completes.</div>
            : report.otherTypes.length === 0
              ? <div className="empty audit-empty">No unclassified file types found.</div>
            : <div className="table-wrap">
              <table>
                <thead><tr><th>Extension</th><th>Files</th><th>Total size</th></tr></thead>
                <tbody>{report.otherTypes.map(type => (
                  <tr key={type.extension}><td>{type.extension}</td><td>{type.count.toLocaleString()}</td><td>{formatBytes(type.bytes)}</td></tr>
                ))}</tbody>
              </table>
            </div>}
        </section>
        {run.errors > 0 && (
          <section className="audit-section">
            <h3>Files not verified <span>{run.errors.toLocaleString()}</span></h3>
            <ul className="audit-errors">{report.hashErrors.map(file => <li key={file.rel}><code>{file.rel}</code><span>{file.error}</span></li>)}</ul>
            {run.errors > report.hashErrors.length && <p className="audit-limit">Showing {report.hashErrors.length.toLocaleString()} of {run.errors.toLocaleString()} hash errors.</p>}
          </section>
        )}
        <footer>Read-only audit · No files are modified</footer>
      </section>
    </>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit++;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value.toFixed(1)} ${units[unit]}`;
}

function auditStatusLabel(status: AuditRun['status']): string {
  if (status === 'queued') return 'Audit queued';
  if (status === 'running') return 'Audit in progress';
  if (status === 'failed') return 'Audit failed';
  return 'Audit complete';
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
  runId,
  onStart,
  onFilter,
  onSaveCorrection,
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
  runId: number | null;
  onStart: () => void;
  onFilter: (filter: MatchFilter) => void;
  onSaveCorrection: (
    match: MetadataMatch,
    correction: { candidateId: number; title: string; year: number | null; season: number | null; episode: number | null },
  ) => Promise<void>;
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
                <option value="review">Review queue</option>
                <option value="high">High confidence</option>
                <option value="medium">Medium confidence</option>
                <option value="low">Low confidence</option>
                <option value="unmatched">Unmatched</option>
                <option value="preserved">Preserved</option>
              </select>
            </div>
            {matches.length === 0
              ? <div className="empty">{matchingActive ? 'Waiting for matching results...' : 'No results for this filter.'}</div>
              : <div className="match-groups">{groups.map(group => <MetadataGroupCard key={group.key} group={group} runId={runId} onSaveCorrection={onSaveCorrection} />)}</div>}
            <footer>{matches.length} result(s) shown · Metadata matching is read-only</footer>
          </section>
        </>
      )}
    </>
  );
}

function MetadataGroupCard({
  group,
  runId,
  onSaveCorrection,
}: {
  group: MetadataGroup;
  runId: number | null;
  onSaveCorrection: (
    match: MetadataMatch,
    correction: { candidateId: number; title: string; year: number | null; season: number | null; episode: number | null },
  ) => Promise<void>;
}) {
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
        {group.matches.map(match => <MetadataMatchRow key={`${runId}:${match.inventoryId}`} match={match} runId={runId} onSaveCorrection={onSaveCorrection} />)}
      </div>
    </details>
  );
}

function MetadataMatchRow({
  match,
  runId,
  onSaveCorrection,
}: {
  match: MetadataMatch;
  runId: number | null;
  onSaveCorrection: (
    match: MetadataMatch,
    correction: { candidateId: number; title: string; year: number | null; season: number | null; episode: number | null },
  ) => Promise<void>;
}) {
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
        {match.manualCorrection && <span className="manual-badge">Verified by you</span>}
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
      {match.candidates.length > 0 && match.matchStatus !== 'preserved' && runId !== null && (
        <ReviewEditor key={`${runId}:${match.inventoryId}`} match={match} onSave={onSaveCorrection} />
      )}
    </article>
  );
}

function ReviewEditor({
  match,
  onSave,
}: {
  match: MetadataMatch;
  onSave: (
    match: MetadataMatch,
    correction: { candidateId: number; title: string; year: number | null; season: number | null; episode: number | null },
  ) => Promise<void>;
}) {
  const initialCandidate = match.candidates.find(candidate => candidate.id === match.providerId) ?? match.candidates[0];
  const [candidateId, setCandidateId] = useState(String(initialCandidate?.id ?? ''));
  const [title, setTitle] = useState(match.title ?? initialCandidate?.title ?? '');
  const [year, setYear] = useState(String(match.releaseYear ?? initialCandidate?.year ?? ''));
  const [season, setSeason] = useState(String(match.season ?? ''));
  const [episode, setEpisode] = useState(String(match.episode ?? ''));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const selected = match.candidates.find(candidate => String(candidate.id) === candidateId);
  const isTv = selected?.mediaType === 'tv';

  const selectCandidate = (value: string) => {
    setCandidateId(value);
    const candidate = match.candidates.find(item => String(item.id) === value);
    if (!candidate) return;
    setTitle(candidate.title);
    setYear(String(candidate.year ?? ''));
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      await onSave(match, {
        candidateId: selected.id,
        title,
        year: year.trim() ? Number(year) : null,
        season: isTv && season.trim() ? Number(season) : null,
        episode: isTv && episode.trim() ? Number(episode) : null,
      });
      setSaved(true);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Unable to save this correction.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <details className="review-editor">
      <summary>{match.manualCorrection ? 'Edit saved correction' : match.matchStatus === 'review' ? 'Review & correct' : 'Edit match'}</summary>
      <form className="review-form" onSubmit={submit}>
        <label>
          Metadata candidate
          <select value={candidateId} onChange={event => selectCandidate(event.target.value)}>
            {match.candidates.map(candidate => (
              <option key={`${candidate.mediaType}-${candidate.id}`} value={candidate.id}>
                {candidate.title} ({candidate.year ?? 'year unknown'}) · {candidate.score}/100
              </option>
            ))}
          </select>
        </label>
        <div className="review-fields">
          <label>Corrected title<input value={title} maxLength={180} required onChange={event => setTitle(event.target.value)} /></label>
          <label>Release year<input type="number" min={1870} max={new Date().getFullYear() + 10} value={year} onChange={event => setYear(event.target.value)} /></label>
        </div>
        {isTv && (
          <div className="review-fields">
            <label>Season (0–99)<input type="number" min={0} max={99} value={season} required onChange={event => setSeason(event.target.value)} /></label>
            <label>Episode (1–999)<input type="number" min={1} max={999} value={episode} required onChange={event => setEpisode(event.target.value)} /></label>
          </div>
        )}
        {error && <p className="review-error">{error}</p>}
        {saved && <p className="review-success">Correction saved and will be reused on future matching runs.</p>}
        <button className="small-button" type="submit" disabled={saving || !selected}>{saving ? 'Verifying...' : 'Save correction'}</button>
        {isTv && <small>Season and episode are checked against TMDB before saving.</small>}
      </form>
    </details>
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
