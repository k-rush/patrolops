import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { onAuthStateChanged, signInWithEmailAndPassword, signOut, type Auth, type User } from 'firebase/auth';
import { initializeIdentity } from './platform/firebase';
import DispatchMap from './DispatchMap';
import VitalsPanel from './VitalsPanel';
import { api, loadIncidents, readPendingIncident, resortTime, type Incident, type IncidentRequest } from './dispatch';

let identity: Promise<Auth> | undefined;
function getIdentity() {
  identity ??= fetch('/api/config').then(async response => {
    if (!response.ok) throw new Error('Sign-in configuration is unavailable.');
    const config = await response.json();
    if (!config.projectId || !config.apiKey) throw new Error('Firebase sign-in has not been configured.');
    return initializeIdentity(config, config.emulatorUrl ?? undefined);
  }).catch(error => { identity = undefined; throw error; });
  return identity;
}

export default function App() {
  const [auth, setAuth] = useState<Auth>();
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    let unsubscribe: (() => void) | undefined;
    getIdentity().then(instance => {
      if (!active) return;
      setAuth(instance);
      unsubscribe = onAuthStateChanged(instance, current => { setUser(current); setReady(true); });
    }).catch((failure: Error) => { if (active) { setError(failure.message); setReady(true); } });
    return () => { active = false; unsubscribe?.(); };
  }, []);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!auth) return;
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      await signInWithEmailAndPassword(auth, String(data.get('email')), String(data.get('password')));
    } catch {
      setError('Sign-in failed. Check your credentials and connection.');
    } finally { setBusy(false); }
  }

  if (user && auth) return <CommandCenter key={user.uid} user={user} onSignOut={() => signOut(auth)} />;
  return <main className="login">
    <div className="brand-symbol" aria-hidden="true">/▲</div>
    <p className="eyebrow">PatrolOps / Proof of concept</p>
    <h1>Dispatch command center</h1>
    <p className="muted">The Summit at Snoqualmie · Summit West</p>
    <form onSubmit={login}>
      <label>Email<input name="email" type="email" autoComplete="username" required /></label>
      <label>Password<input name="password" type="password" autoComplete="current-password" required /></label>
      <button className="primary" disabled={!ready || !auth || busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
    </form>
    {error && <p role="alert">{error}</p>}
    <p className="safety-note">Authorized POC dispatchers only. Use fictional incidents, never real patient or patrol data.</p>
  </main>;
}

export function CommandCenter({ user, onSignOut }: { user: User; onSignOut: () => Promise<void> }) {
  const [view, setView] = useState<'map' | 'incidents'>('map');
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pending, setPending] = useState<IncidentRequest | undefined>(() => readPendingIncident(user.uid));
  const [error, setError] = useState(() => readPendingIncident(user.uid)
    ? 'An earlier save was not confirmed. Retry uses the same incident ID.' : '');
  const [loadError, setLoadError] = useState('');
  const lock = useRef(false);
  const mounted = useRef(true);
  const selected = incidents.find(incident => incident.id === selectedId);
  const dirtyVitals = useRef(false);
  const onVitalsDirty = useCallback((dirty: boolean) => { dirtyVitals.current = dirty; }, []);
  function canLeaveVitals() {
    return !dirtyVitals.current || window.confirm('Discard unsaved vital changes? An unconfirmed save may already be recorded.');
  }
  function selectIncident(id?: string) {
    if (id === selectedId || canLeaveVitals()) setSelectedId(id);
  }
  function changeView(next: 'map' | 'incidents') {
    if (next === view || canLeaveVitals()) setView(next);
  }

  useEffect(() => {
    mounted.current = true;
    let active = true;
    loadIncidents(user).then(items => {
      if (active) { setIncidents(items); setLoaded(true); }
    }).catch((failure: Error) => { if (active) setLoadError(failure.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; mounted.current = false; };
  }, [user]);

  async function refresh() {
    setLoading(true);
    setLoadError('');
    try {
      const items = await loadIncidents(user);
      if (mounted.current) { setIncidents(items); setLoaded(true); }
    } catch (failure) {
      if (mounted.current) setLoadError((failure as Error).message);
    } finally { if (mounted.current) setLoading(false); }
  }

  async function save(request: IncidentRequest) {
    if (lock.current) return;
    lock.current = true;
    setSaving(true);
    setPending(request);
    setError('');
    try {
      try { sessionStorage.setItem(`dispatch-pending:${user.uid}`, JSON.stringify(request)); }
      catch { /* In-memory retry remains available if browser storage is disabled. */ }
      const saved = await api<Incident>(user, '', { method: 'POST', body: JSON.stringify(request) });
      if (!mounted.current) return;
      setIncidents(items => [saved, ...items.filter(item => item.id !== saved.id)]);
      setSelectedId(saved.id);
      setPending(undefined);
      try { sessionStorage.removeItem(`dispatch-pending:${user.uid}`); }
      catch { /* An already-saved request is safe to retry after a reload. */ }
    } catch (failure) {
      if (mounted.current) setError(`${(failure as Error).message} Save not confirmed. Retry uses the same incident ID.`);
    } finally {
      lock.current = false;
      if (mounted.current) setSaving(false);
    }
  }

  function create(latitude: number, longitude: number) {
    if (pending || !loaded || loading || loadError) return;
    if (!canLeaveVitals()) return;
    void save({ id: crypto.randomUUID(), latitude, longitude });
  }

  function open(id: string) { if (canLeaveVitals()) { setSelectedId(id); setView('map'); } }

  return <div className="app-shell">
    <aside className="sidebar">
      <a className="brand" href="#main"><span className="brand-symbol" aria-hidden="true">/▲</span><span><strong>PatrolOps</strong></span></a>
      <div className="resort-label"><span className="eyebrow">Command center</span><strong>Summit West</strong><span>Snoqualmie Pass, WA</span></div>
      <nav aria-label="Main views">
        <button aria-current={view === 'map' ? 'page' : undefined} onClick={() => changeView('map')}><span aria-hidden="true">⌖</span>Dispatch map</button>
        <button aria-current={view === 'incidents' ? 'page' : undefined} onClick={() => changeView('incidents')}><span aria-hidden="true">≡</span>Incidents <span className="nav-count">{incidents.length}</span></button>
      </nav>
      <div className="sidebar-footer"><span className="eyebrow">Dispatcher</span><span className="account">{user.email}</span>
        <button disabled={saving} onClick={() => {
          if (canLeaveVitals()) void onSignOut().catch(() => setError('Sign-out failed. Try again.'));
        }}>Sign out</button>
      </div>
    </aside>
    <main id="main" className="workspace">
      <header className="workspace-header">
        <div><p className="eyebrow">The Summit at Snoqualmie</p><h1>{view === 'map' ? 'Dispatch map' : 'Incidents'}</h1>
          <p className="muted">{view === 'map' ? 'Click the map to create an incident at that location.' : 'Shared incident records for Summit West.'}</p></div>
        <div className="header-actions"><span className="poc-badge">POC · Fictional data only</span><button disabled={loading || saving} onClick={() => void refresh()}>{loading ? 'Loading…' : 'Refresh incidents'}</button></div>
      </header>
      {loadError && <p className="error-banner" role="alert">{loadError} {loaded ? 'Showing previously loaded records.' : 'Incidents have not loaded.'} Use Refresh incidents to retry.</p>}
      {error && <div className="error-banner" role="alert">{error} {pending && <button disabled={saving} onClick={() => void save(pending)}>Retry save</button>}</div>}
      <div className="workspace-body">
        <section className="context-bar" aria-label="Resort context"><div><span className="location-dot" /> <strong>Summit West</strong><span className="muted">Washington, USA</span></div><span>{incidents.length} incident{incidents.length === 1 ? '' : 's'} loaded</span></section>
        {view === 'map' ? <section className="map-shell" aria-label="Dispatch workspace">
          <DispatchMap incidents={incidents} selected={selected} onSelect={selectIncident} onCreate={create}
            disabled={!loaded || loading || !!loadError || !!pending || saving} />
          {saving && <div className="map-status" role="status">Saving incident…</div>}
          {selected && <aside className="incident-popout" role="dialog" aria-modal="false" aria-labelledby="incident-heading">
            <header><span className="eyebrow">Incident details</span><button className="close" aria-label="Close incident popout" onClick={() => selectIncident(undefined)}>×</button></header>
            <h2 id="incident-heading">Incident <span>{selected.id.slice(0, 8).toUpperCase()}</span></h2>
            <p className="saved-label">Saved to Summit West</p>
            <dl><dt>Created · Pacific time</dt><dd>{resortTime(selected.createdAt)}</dd>
              <dt>Location</dt><dd>{selected.latitude.toFixed(5)}, {selected.longitude.toFixed(5)}</dd>
              <dt>Incident ID</dt><dd className="incident-id">{selected.id}</dd></dl>
            <p className="muted popout-hint">Close this panel to return to the map. Select its marker to reopen.</p>
            <p><a href="#incident-vitals">Record and review patient vitals</a></p>
          </aside>}
          {!selected && !saving && <div className="map-hint"><strong>Every response starts with a location.</strong><span>Click anywhere on the map to create an incident.</span></div>}
        </section> : <section className="incident-list" aria-label="Saved incidents">
          {!loading && loaded && !incidents.length && <div className="empty-state"><h2>No incidents yet</h2><p>Create your first fictional incident on the dispatch map.</p><button onClick={() => setView('map')}>Go to dispatch map</button></div>}
          {incidents.map(incident => <button className="incident-row" key={incident.id} onClick={() => open(incident.id)}>
            <span className="list-marker" aria-hidden="true">⌖</span><span><strong>Incident {incident.id.slice(0, 8).toUpperCase()}</strong><span className="muted">{resortTime(incident.createdAt)}</span></span>
            <span className="coordinates">{incident.latitude.toFixed(5)}, {incident.longitude.toFixed(5)}</span><span aria-hidden="true">→</span>
          </button>)}
        </section>}
        {view === 'map' && selected && <VitalsPanel key={selected.id} user={user}
          incidentId={selected.id} onDirtyChange={onVitalsDirty} />}
        <footer className="workspace-footer"><span>Proof of concept — not for operational dispatch</span><span>Times shown in America/Los_Angeles</span></footer>
      </div>
    </main>
  </div>;
}
