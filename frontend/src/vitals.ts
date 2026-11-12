import type { User } from 'firebase/auth';

export const resortZone = 'America/Los_Angeles';
export interface VitalValues {
  measuredAt: string;
  heartRate: number | null;
  respiratoryRate: number | null;
  spo2: number | null;
  reportingPatroller: string | null;
  note: string | null;
}
export interface VitalReport {
  id: string;
  value: VitalValues;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
  revision: number;
}
export interface VitalRevision {
  id: string;
  before: VitalValues | null;
  after: VitalValues;
  editor: string;
  editedAt: string;
  revision: number;
}
export class VitalApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export async function vitalApi<T>(user: User, incidentId: string, path = '', init?: RequestInit): Promise<T> {
  const token = await user.getIdToken();
  const response = await fetch(`/api/incidents/${incidentId}/vitals${path}`, {
    ...init,
    signal: AbortSignal.timeout(15000),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new VitalApiError(response.status === 401 ? 'Your session expired. Sign in again.'
      : response.status === 403 ? 'You do not have dispatcher access to this resort.'
        : body.message ?? body.title ?? 'The vital service is unavailable.', response.status);
  }
  return response.json();
}

export async function allVitals<T extends { id: string; revision: number }>(user: User, incidentId: string, path = '') {
  const items = new Map<string, T>();
  let cursor: string | null = null;
  do {
    const page: { items: T[]; cursor: string | null } = await vitalApi(user, incidentId,
      `${path}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
    for (const item of page.items) {
      if ((items.get(item.id)?.revision ?? 0) <= item.revision) items.set(item.id, item);
    }
    cursor = page.cursor;
  } while (cursor);
  return [...items.values()];
}

const partsFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: resortZone, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
export function localMinute(instant: string) {
  const parts = Object.fromEntries(partsFormat.formatToParts(new Date(instant)).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}
export function timeCandidates(local: string): string[] {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(local)) return [];
  const guess = Date.parse(`${local}:00Z`);
  if (!Number.isFinite(guess)) return [];
  const candidates: string[] = [];
  // Match actual zone rules, including gaps and repeated minutes, independently of device timezone.
  for (let minutes = -14 * 60; minutes <= 14 * 60; minutes += 15) {
    const instant = new Date(guess + minutes * 60_000).toISOString();
    if (localMinute(instant) === local) candidates.push(instant);
  }
  return candidates;
}
export const vitalTime = (instant: string) => new Intl.DateTimeFormat('en-US', {
  timeZone: resortZone, year: 'numeric', month: 'short', day: 'numeric',
  hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
}).format(new Date(instant));

export function orderVitals(reports: VitalReport[]) {
  return [...reports].sort((a, b) => Date.parse(b.value.measuredAt) - Date.parse(a.value.measuredAt)
    || Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id));
}
