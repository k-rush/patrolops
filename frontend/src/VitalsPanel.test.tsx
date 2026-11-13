import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { User } from 'firebase/auth';
import { afterEach, expect, test, vi } from 'vitest';
import VitalsPanel from './VitalsPanel';
import { localMinute, type VitalReport } from './vitals';

const user = { uid: 'fictional-dispatcher', getIdToken: async () => 'test-token' } as User;
const report: VitalReport = { id: 'report-id', value: { measuredAt: '2026-01-01T12:03:45.123Z',
  heartRate: 80, respiratoryRate: null, spo2: null, reportingPatroller: null, note: null },
createdBy: user.uid, createdAt: '2026-01-01T12:04:59.123Z', updatedAt: '2026-01-01T12:04:59.123Z',
updatedBy: user.uid, revision: 1 };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
afterEach(() => { vi.unstubAllGlobals(); });

test('a correction preserves hidden timestamp seconds, retains rejected input, and saves only on confirmation', async () => {
  const fetch = vi.fn().mockImplementation((_url, init) => {
    if (!init?.method) return Promise.resolve(json({ items: [report], cursor: null }));
    return Promise.resolve(json({ message: 'Rejected test correction' }, 400));
  });
  vi.stubGlobal('fetch', fetch);
  render(<VitalsPanel user={user} incidentId="incident-id" onDirtyChange={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Correct' }));
  expect(screen.getByLabelText(/Measurement time/)).toHaveValue(localMinute(report.value.measuredAt));
  fireEvent.change(screen.getByLabelText('Note (optional)'), { target: { value: 'Fictional correction' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save correction' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Not saved');
  expect(screen.getByLabelText('Note (optional)')).toHaveValue('Fictional correction');
  const request = fetch.mock.calls.find(([, init]) => init.method === 'PUT')![1];
  expect(JSON.parse(request.body).value.measuredAt).toBe(report.value.measuredAt);
  expect(screen.getByRole('status')).not.toHaveTextContent('saved');
});

test('a lost correction response retries the same identity and shows a newer authoritative version', async () => {
  const bodies: string[] = [];
  vi.stubGlobal('fetch', vi.fn().mockImplementation((_url, init) => {
    if (!init?.method) return Promise.resolve(json({ items: [report], cursor: null }));
    bodies.push(init.body);
    if (bodies.length === 1) return Promise.reject(new Error('Lost response'));
    return Promise.resolve(json({ report: { ...report, revision: 3, value: { ...report.value, heartRate: 83 } },
      acceptedRevision: 2 }));
  }));
  render(<VitalsPanel user={user} incidentId="incident-id" onDirtyChange={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Correct' }));
  fireEvent.change(screen.getByLabelText('Heart rate (beats/min)'), { target: { value: '81' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save correction' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Save not confirmed');
  expect(screen.getByLabelText('Heart rate (beats/min)')).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Retry vital save' }));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('A later correction'));
  expect(bodies[1]).toBe(bodies[0]);
  expect(screen.getByRole('cell', { name: '83' })).toBeVisible();
});

test('a failed history refresh labels retained data stale instead of showing an empty success', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(json({ items: [report], cursor: null }))
    .mockRejectedValue(new Error('Offline'));
  vi.stubGlobal('fetch', fetch);
  render(<VitalsPanel user={user} incidentId="incident-id" onDirtyChange={() => {}} />);
  await screen.findByRole('button', { name: 'Correct' });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh vitals' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Showing previously loaded vitals');
  expect(screen.getByRole('cell', { name: '80' })).toBeVisible();
});
