import { afterEach, expect, test, vi } from 'vitest';
import type { User } from 'firebase/auth';
import { allVitals, localMinute, timeCandidates, orderVitals, type VitalReport } from './vitals';

afterEach(() => vi.unstubAllGlobals());

test('resort input uses minute precision regardless of device zone', () => {
  expect(localMinute('2026-07-12T19:23:59.123Z')).toBe('2026-07-12T12:23');
  expect(timeCandidates('2026-07-12T12:23')).toEqual(['2026-07-12T19:23:00.000Z']);
});

test('nonexistent local minutes are rejected and repeated minutes require an offset', () => {
  expect(timeCandidates('2026-03-08T02:30')).toEqual([]);
  expect(timeCandidates('2026-11-01T01:30')).toEqual(['2026-11-01T08:30:00.000Z', '2026-11-01T09:30:00.000Z']);
  expect(timeCandidates('not a time')).toEqual([]);
  expect(timeCandidates('2026-02-30T12:00')).toEqual([]);
});

test('history orders backfill by measurement instant and breaks ties by entry then identity', () => {
  const report = (id: string, measuredAt: string, createdAt: string) =>
    ({ id, value: { measuredAt }, createdAt }) as VitalReport;
  const first = report('a', '2026-01-01T12:00Z', '2026-01-01T12:01Z');
  const backfill = report('z', '2026-01-01T11:00Z', '2026-01-01T12:02Z');
  const second = report('b', first.value.measuredAt, first.createdAt);
  expect(orderVitals([backfill, second, first]).map(item => item.id)).toEqual(['a', 'b', 'z']);
});

test('all pages are loaded and a report moving between pages is not duplicated or regressed', async () => {
  const fetch = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ id: 'a', revision: 3 }], cursor: 'next+/=' })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ id: 'a', revision: 2 }, { id: 'b', revision: 1 }], cursor: null })));
  vi.stubGlobal('fetch', fetch);
  const user = { getIdToken: async () => 'test-token' } as User;
  expect(await allVitals(user, 'incident-id')).toEqual([{ id: 'a', revision: 3 }, { id: 'b', revision: 1 }]);
  expect(fetch.mock.calls[1][0]).toContain('?cursor=next%2B%2F%3D');
});
