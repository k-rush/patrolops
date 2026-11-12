import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { User } from 'firebase/auth';
import { allVitals, localMinute, orderVitals, resortZone, timeCandidates, vitalApi, VitalApiError,
  vitalTime, type VitalReport, type VitalRevision, type VitalValues } from './vitals';

const fields = [
  ['heartRate', 'Heart rate', 'beats/min'],
  ['respiratoryRate', 'Respiratory rate', 'breaths/min'],
  ['spo2', 'SpO2', '%'],
] as const;
type FormValues = { time: string; instant: string; heartRate: string; respiratoryRate: string;
  spo2: string; reportingPatroller: string; note: string };
const emptyForm = (): FormValues => {
  const instant = new Date(Math.floor(Date.now() / 60000) * 60000).toISOString();
  return { time: localMinute(instant), instant, heartRate: '', respiratoryRate: '', spo2: '', reportingPatroller: '', note: '' };
};
type Pending = { reportId: string; method: 'POST' | 'PUT'; body: string };

export default function VitalsPanel({ user, incidentId, onDirtyChange }: {
  user: User; incidentId: string; onDirtyChange: (dirty: boolean) => void;
}) {
  const [reports, setReports] = useState<VitalReport[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [form, setForm] = useState(emptyForm);
  const [editing, setEditing] = useState<VitalReport>();
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState<Pending>();
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [saveError, setSaveError] = useState('');
  const [historyId, setHistoryId] = useState<string>();
  const [history, setHistory] = useState<VitalRevision[]>([]);
  const [historyError, setHistoryError] = useState('');
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const mounted = useRef(true);
  const saveLock = useRef(false);
  const refreshLock = useRef(false);
  const refreshGeneration = useRef(0);
  const refreshAction = useRef<() => Promise<void>>(async () => {});

  async function refresh() {
    if (saveLock.current || refreshLock.current) return;
    refreshLock.current = true;
    const generation = ++refreshGeneration.current;
    try {
      const items = await allVitals<VitalReport>(user, incidentId);
      if (!mounted.current || generation !== refreshGeneration.current) return;
      setReports(previous => orderVitals(items.map(item => {
        const known = previous.find(report => report.id === item.id);
        return known && known.revision > item.revision ? known : item;
      }).concat(previous.filter(report => !items.some(item => item.id === report.id)))));
      setLoaded(true);
      setLoadError('');
    } catch (failure) {
      if (mounted.current && generation === refreshGeneration.current) setLoadError((failure as Error).message);
    } finally { refreshLock.current = false; }
  }

  useEffect(() => { refreshAction.current = refresh; });
  useEffect(() => {
    mounted.current = true;
    void refreshAction.current();
    const timer = window.setInterval(() => { void refreshAction.current(); }, 10000);
    return () => { mounted.current = false; window.clearInterval(timer); };
  }, [incidentId, user]);

  useEffect(() => {
    onDirtyChange(dirty);
    function warn(event: BeforeUnloadEvent) {
      if (dirty) { event.preventDefault(); event.returnValue = ''; }
    }
    window.addEventListener('beforeunload', warn);
    return () => { window.removeEventListener('beforeunload', warn); onDirtyChange(false); };
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    if (!historyId) return;
    let active = true;
    let reading = false;
    async function read() {
      if (reading) return;
      reading = true;
      try {
        const items = await allVitals<VitalRevision>(user, incidentId, `/${historyId}/history`);
        if (active) { setHistory(items); setHistoryError(''); setHistoryLoaded(true); }
      } catch (failure) { if (active) setHistoryError((failure as Error).message); }
      finally { reading = false; }
    }
    void read();
    const timer = window.setInterval(() => { void read(); }, 10000);
    return () => { active = false; window.clearInterval(timer); };
  }, [user, incidentId, historyId, reports]);

  function change(key: keyof FormValues, value: string) {
    setForm(current => ({ ...current, [key]: value, ...(key === 'time' ? { instant: '' } : {}) }));
    setDirty(true);
    setMessage('');
    setSaveError('');
  }
  function reset() {
    setForm(emptyForm()); setEditing(undefined); setDirty(false); setPending(undefined);
  }
  function edit(report: VitalReport) {
    if (dirty && !window.confirm('Discard unsaved vital changes?')) return;
    const value = report.value;
    setForm({ time: localMinute(value.measuredAt), instant: new Date(value.measuredAt).toISOString(),
      heartRate: value.heartRate?.toString() ?? '', respiratoryRate: value.respiratoryRate?.toString() ?? '',
      spo2: value.spo2?.toString() ?? '', reportingPatroller: value.reportingPatroller ?? '', note: value.note ?? '' });
    setEditing(report); setPending(undefined); setDirty(false); setMessage(''); setSaveError('');
  }
  async function send(operation: Pending) {
    if (saveLock.current) return;
    saveLock.current = true;
    ++refreshGeneration.current;
    setSaving(true); setPending(operation); setSaveError(''); setMessage(''); setDirty(true);
    try {
      const result = await vitalApi<{ report: VitalReport; acceptedRevision: number }>(user, incidentId,
        `/${operation.reportId}`, { method: operation.method, body: operation.body });
      if (!mounted.current) return;
      setReports(items => orderVitals([result.report, ...items.filter(item => item.id !== result.report.id)]));
      setMessage(result.acceptedRevision < result.report.revision
        ? 'Save confirmed. A later correction is shown in the history.' : 'Vital report saved.');
      reset();
    } catch (failure) {
      if (!mounted.current) return;
      const rejected = failure instanceof VitalApiError && [400, 401, 403, 404, 409].includes(failure.status);
      if (rejected) setPending(undefined);
      setSaveError(`${(failure as Error).message} ${rejected ? 'Not saved. Your input is retained.'
        : 'Save not confirmed. Retry uses the same operation; input is retained.'}`);
    } finally {
      saveLock.current = false;
      if (mounted.current) setSaving(false);
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (pending) { void send(pending); return; }
    const candidates = timeCandidates(form.time);
    const selected = form.instant || (candidates.length === 1 ? candidates[0] : '');
    if (!selected || !candidates.some(candidate => localMinute(selected) === form.time
      && Math.floor(Date.parse(candidate) / 60000) === Math.floor(Date.parse(selected) / 60000))) {
      setSaveError(candidates.length ? 'Choose the offset for this repeated local time.'
        : 'Enter a valid local measurement time; this time may not exist during a daylight-saving change.');
      return;
    }
    if (Date.parse(selected) > Date.now()) { setSaveError('Measurement time cannot be in the future.'); return; }
    if (fields.every(([key]) => form[key] === '')) { setSaveError('Enter at least one vital.'); return; }
    const value: VitalValues = { measuredAt: selected,
      heartRate: form.heartRate === '' ? null : Number(form.heartRate),
      respiratoryRate: form.respiratoryRate === '' ? null : Number(form.respiratoryRate),
      spo2: form.spo2 === '' ? null : Number(form.spo2),
      reportingPatroller: form.reportingPatroller || null, note: form.note || null };
    void send({ reportId: editing?.id ?? crypto.randomUUID(), method: editing ? 'PUT' : 'POST',
      body: JSON.stringify({ operationId: crypto.randomUUID(), value }) });
  }
  const candidates = timeCandidates(form.time);
  return <section id="incident-vitals" className="vitals-panel" aria-label="Incident vitals">
    <header className="vitals-heading"><div><h2>Patient vitals</h2>
      <p className="muted">Incident {incidentId} · {resortZone} · refreshes every 10 seconds</p></div>
      <button disabled={saving} onClick={() => void refresh()}>Refresh vitals</button></header>
    <p className="safety-note">Radio-reported observations only. No clinical interpretation. Fictional data only.</p>
    {loadError && <p role="alert">{loadError} {loaded ? 'Showing previously loaded vitals.' : 'Vitals have not loaded.'}</p>}
    <form onSubmit={submit} aria-label="Record vitals">
      <h3>{editing ? 'Correct report' : 'New report'}</h3>
      {editing && <p className="muted">Editing version {editing.revision}. Saving replaces the current report; all previous versions remain in audit history.</p>}
      <fieldset disabled={saving || !!pending || !loaded}>
        <div className="vital-inputs">{fields.map(([key, label, unit]) => <label key={key}>{label} ({unit})
          <input type="number" step="1" min={key === 'spo2' ? 0 : 1} max={key === 'spo2' ? 100 : 2147483647}
            value={form[key]} onChange={event => change(key, event.target.value)} />
        </label>)}</div>
        <label>Measurement time ({resortZone})
          <input type="datetime-local" step="60" required value={form.time} onChange={event => change('time', event.target.value)} />
        </label>
        {candidates.length > 1 && <label>Time offset (repeated local time)
          <select value={candidates.find(candidate => Math.floor(Date.parse(candidate) / 60000)
            === Math.floor(Date.parse(form.instant) / 60000)) ?? ''}
            required onChange={event => change('instant', event.target.value)}>
            <option value="">Choose offset</option>
            {candidates.map(candidate => <option key={candidate} value={candidate}>{vitalTime(candidate)}</option>)}
          </select>
        </label>}
        <label>Reporting patroller (optional)<input maxLength={100} value={form.reportingPatroller}
          onChange={event => change('reportingPatroller', event.target.value)} /></label>
        <label>Note (optional)<textarea maxLength={2000} value={form.note} onChange={event => change('note', event.target.value)} /></label>
      </fieldset>
      <div className="vital-actions"><button className="primary" disabled={saving || !loaded}>
        {saving ? 'Saving vitals...' : pending ? 'Retry vital save' : editing ? 'Save correction' : 'Save vitals'}</button>
        {(dirty || editing) && <button type="button" disabled={saving} onClick={() => {
          if (!dirty || window.confirm('Discard unsaved vital changes? An unconfirmed save may already be recorded.')) {
            reset(); setSaveError(''); setMessage('');
          }
        }}>Cancel changes</button>}</div>
    </form>
    {saveError && <p role="alert">{saveError}</p>}
    <p role="status">{saving ? 'Saving vitals...' : message}</p>
    {!loaded && !loadError && <p>Loading vitals...</p>}
    {loaded && !reports.length && <p>No vital reports recorded.</p>}
    {!!reports.length && <>
      <div className="vital-table"><table><caption>Vital history - newest measurement first</caption>
        <thead><tr><th>Measurement time</th>{fields.map(([, label, unit]) => <th key={label}>{label} ({unit})</th>)}
          <th>Reporting patroller / note</th><th>Actions</th></tr></thead>
        <tbody>{reports.map(report => <tr key={report.id} data-report-id={report.id}>
          <td>{vitalTime(report.value.measuredAt)}</td>
          {fields.map(([key]) => <td key={key}>{report.value[key] ?? '-'}</td>)}
          <td>{report.value.reportingPatroller || '-'}{report.value.note && <p>{report.value.note}</p>}</td>
          <td><button disabled={saving} onClick={() => edit(report)}>Correct</button>{' '}
            <button onClick={() => {
              if (historyId !== report.id) {
                setHistory([]); setHistoryLoaded(false); setHistoryError(''); setHistoryId(report.id);
              }
            }}>Audit history</button></td>
        </tr>)}</tbody>
      </table></div>
      <div className="vital-charts">{fields.map(([key, label, unit]) =>
        <VitalChart key={key} reports={reports} field={key} label={`${label} (${unit})`} />)}</div>
    </>}
    {historyId && <section aria-label="Vital audit history" className="vital-audit">
      <h3>Audit history</h3><button onClick={() => setHistoryId(undefined)}>Close audit history</button>
      {historyError && <p role="alert">{historyError} Audit history could not be refreshed.</p>}
      {!historyLoaded && !historyError && <p>Loading audit history...</p>}
      {history.map(revision => <article key={revision.id}>
        <h4>Version {revision.revision} - {revision.before ? 'Correction' : 'Initial recording'}</h4>
        <p>By {revision.editor} · {vitalTime(revision.editedAt)}</p>
        <dl>{(Object.keys(revision.after) as (keyof VitalValues)[]).filter(key => !revision.before
          || revision.before[key] !== revision.after[key]).map(key => <div key={key}>
          <dt>{key}</dt><dd>{revision.before ? `${displayValue(key, revision.before[key])} → ` : ''}
            {displayValue(key, revision.after[key])}</dd></div>)}</dl>
      </article>)}
    </section>}
  </section>;
}

function displayValue(key: keyof VitalValues, value: string | number | null) {
  return value == null ? '(not reported)' : key === 'measuredAt' ? vitalTime(String(value)) : String(value);
}

function VitalChart({ reports, field, label }: {
  reports: VitalReport[]; field: 'heartRate' | 'respiratoryRate' | 'spo2'; label: string;
}) {
  const points = reports.filter(report => report.value[field] !== null);
  if (!points.length) return <section><h3>{label}</h3><p>No measurements reported.</p></section>;
  const times = points.map(report => Date.parse(report.value.measuredAt));
  const values = points.map(report => report.value[field]!);
  const minTime = Math.min(...times), maxTime = Math.max(...times);
  const min = Math.min(...values), max = Math.max(...values);
  return <section><h3>{label}</h3>
    <svg viewBox="0 0 360 180" role="img" aria-label={`${label} over measurement time; values in the history table`}>
      <line x1="40" y1="15" x2="40" y2="145" stroke="currentColor" />
      <line x1="40" y1="145" x2="340" y2="145" stroke="currentColor" />
      <text x="3" y="25">{max}</text><text x="3" y="140">{min === max ? '' : min}</text>
      {points.map((report, index) => <circle key={report.id}
        cx={minTime === maxTime ? 190 : 50 + (times[index] - minTime) / (maxTime - minTime) * 280}
        cy={min === max ? 80 : 135 - (values[index] - min) / (max - min) * 110} r="4" fill="currentColor">
        <title>{vitalTime(report.value.measuredAt)}: {values[index]}</title>
      </circle>)}
      <text x="40" y="170">Measurement time</text>
    </svg>
    <p className="muted">{vitalTime(new Date(minTime).toISOString())} - {vitalTime(new Date(maxTime).toISOString())}</p>
  </section>;
}
