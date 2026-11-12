import { randomUUID } from 'node:crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';

const authUrl = process.env.AUTH_EMULATOR_URL ?? 'http://127.0.0.1:29099';
const projectId = 'demo-patroller-audit-local';
const accounts: string[] = [];

async function dispatcher(request: APIRequestContext, claims: Record<string, unknown> = {
  dispatcher: true, resortId: 'summit-west',
}) {
  // Never run identity fixtures against a cloud project or non-loopback emulator.
  const url = new URL(authUrl);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname))
    throw new Error('Acceptance requires a loopback Firebase emulator.');
  const email = `fictional-dispatch-${randomUUID()}@example.test`;
  const password = randomUUID();
  const created = await request.post(`${authUrl}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=local-emulator`, {
    data: { email, password, returnSecureToken: true },
  });
  expect(created.ok()).toBeTruthy();
  const { localId } = await created.json();
  accounts.push(localId);
  const update = await request.post(`${authUrl}/identitytoolkit.googleapis.com/v1/projects/${projectId}/accounts:update`, {
    headers: { Authorization: 'Bearer owner' },
    data: { localId, customAttributes: JSON.stringify(claims) },
  });
  expect(update.ok()).toBeTruthy();
  const login = await request.post(`${authUrl}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=local-emulator`, {
    data: { email, password, returnSecureToken: true },
  });
  expect(login.ok()).toBeTruthy();
  const { idToken } = await login.json();
  return { email, password, uid: localId, headers: { Authorization: `Bearer ${idToken}` } };
}

test.beforeEach(async ({ request }) => {
  const config = await (await request.get('/api/config')).json();
  expect(config.projectId).toBe(projectId);
  expect(config.emulatorUrl).toBe(authUrl);
});

test.afterAll(async ({ request }) => {
  for (const localId of accounts) {
    await request.post(`${authUrl}/identitytoolkit.googleapis.com/v1/projects/${projectId}/accounts:delete`, {
      headers: { Authorization: 'Bearer owner' }, data: { localId },
    });
  }
});

test('real Firebase authorization, Cosmos persistence, validation and exact retry identity', async ({ request }) => {
  expect((await request.get('/api/incidents')).status()).toBe(401);
  const denied = await dispatcher(request, { dispatcher: true, resortId: 'another-resort' });
  expect((await request.get('/api/incidents', { headers: denied.headers })).status()).toBe(403);
  const nonDispatcher = await dispatcher(request, { resortId: 'summit-west' });
  expect((await request.post('/api/incidents', { headers: nonDispatcher.headers,
    data: { id: randomUUID(), latitude: 47.42, longitude: -121.42 } })).status()).toBe(403);
  const first = await dispatcher(request);
  const second = await dispatcher(request);
  const id = randomUUID();
  const input = { id, latitude: 47.4206, longitude: -121.4213 };
  const before = Date.now();
  const response = await request.post('/api/incidents', { headers: first.headers,
    data: { ...input, createdAt: '2000-01-01T00:00:00Z', createdBy: 'untrusted', resortId: 'another-resort' } });
  expect(response.status()).toBe(201);
  const saved = await response.json();
  expect(saved.resortId).toBe('summit-west');
  expect(saved.createdBy).not.toBe('untrusted');
  expect(Date.parse(saved.createdAt)).toBeGreaterThanOrEqual(before - 1000);
  expect(Date.parse(saved.createdAt)).toBeLessThanOrEqual(Date.now() + 1000);
  expect(await (await request.post('/api/incidents', { headers: first.headers, data: input })).json()).toEqual(saved);
  expect((await request.post('/api/incidents', { headers: first.headers,
    data: { ...input, latitude: 48 } })).status()).toBe(409);
  expect((await request.post('/api/incidents', { headers: second.headers, data: input })).status()).toBe(409);
  expect((await request.post('/api/incidents', { headers: first.headers,
    data: { ...input, id: randomUUID(), latitude: 91 } })).status()).toBe(400);
  expect(await (await request.get(`/api/incidents/${id}`, { headers: second.headers })).json()).toEqual(saved);
  const list = await (await request.get('/api/incidents', { headers: second.headers })).json();
  expect(list.items).toContainEqual(saved);
});

test('map click, popout, marker reopen, list navigation and reload use real saved incidents', async ({ page, request }, testInfo) => {
  const account = await dispatcher(request);
  await page.goto('/');
  await page.getByLabel('Email', { exact: true }).fill(account.email);
  await page.getByLabel('Password', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Create at map center' })).toBeEnabled();
  const map = page.getByLabel('Summit West incident map');
  const point = await map.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    for (let y = 100; y < 350; y += 50)
      for (let x = 80; x < 400; x += 50) {
        const hit = document.elementFromPoint(bounds.left + x, bounds.top + y);
        if (hit && !hit.closest('.leaflet-marker-icon, .leaflet-control')) return { x, y };
      }
    throw new Error('No empty map location is available.');
  });
  const creation = page.waitForResponse(response =>
    response.url().endsWith('/api/incidents') && response.request().method() === 'POST');
  await map.click({ position: point });
  expect((await creation).status()).toBe(201);
  const popout = page.getByRole('dialog');
  await expect(popout).toBeVisible();
  await expect(popout.getByText('Saved to Summit West')).toBeVisible();
  const id = await popout.locator('.incident-id').innerText();
  expect((await (await creation).json()).id).toBe(id);
  await expect(popout).toContainText('Pacific');
  const marker = page.getByTitle(`Incident ${id}`, { exact: true });
  await page.getByRole('button', { name: 'Close incident popout' }).click();
  await expect(popout).not.toBeVisible();
  await marker.click();
  await expect(popout).toContainText(id);
  await page.getByRole('button', { name: /^Incidents / }).click();
  await page.getByRole('button', { name: new RegExp(`Incident ${id.slice(0, 8).toUpperCase()}`) }).click();
  await expect(popout).toContainText(id);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Create at map center' })).toBeEnabled();
  await page.getByTitle(`Incident ${id}`, { exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText(id);
  await page.screenshot({ path: testInfo.outputPath('dispatch-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: 'Close incident popout' })).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('dispatch-mobile.png'), fullPage: true });
});

test('a lost real save response survives reload and retries without duplicating the incident', async ({ page, request }) => {
  const account = await dispatcher(request);
  let saved: { id: string; createdAt: string } | undefined;
  const bodies: string[] = [];
  await page.route('**/api/incidents', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    bodies.push(route.request().postData()!);
    if (bodies.length === 1) {
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      saved = await response.json();
      return route.abort('failed');
    }
    return route.continue();
  });
  await page.goto('/');
  await page.getByLabel('Email', { exact: true }).fill(account.email);
  await page.getByLabel('Password', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const create = page.getByRole('button', { name: 'Create at map center' });
  await expect(create).toBeEnabled();
  await create.click();
  await expect(page.getByRole('alert')).toContainText('Save not confirmed');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('earlier save was not confirmed');
  await page.getByRole('button', { name: 'Retry save' }).click();
  await expect(page.getByRole('dialog')).toContainText(saved!.id);
  expect(bodies[1]).toBe(bodies[0]);
  const stored = await (await request.get(`/api/incidents/${saved!.id}`, { headers: account.headers })).json();
  expect(stored.createdAt).toBe(saved!.createdAt);
});

test('vitals preserve timestamp precision, authorization, retries and every concurrent correction', async ({ request }) => {
  const first = await dispatcher(request), second = await dispatcher(request);
  const denied = await dispatcher(request, { dispatcher: true, resortId: 'another-resort' });
  const incidentId = randomUUID(), reportId = randomUUID();
  expect((await request.post('/api/incidents', { headers: first.headers,
    data: { id: incidentId, latitude: 47.42, longitude: -121.42 } })).status()).toBe(201);
  const root = `/api/incidents/${incidentId}/vitals`;
  const path = `${root}/${reportId}`;
  const value = { measuredAt: '2026-01-01T12:03:45.123Z', heartRate: 80, respiratoryRate: null,
    spo2: null, reportingPatroller: 'Fictional P1', note: null };
  const input = { operationId: randomUUID(), value };
  expect((await request.get(root)).status()).toBe(401);
  for (const url of [root, `${path}/history`])
    expect((await request.get(url, { headers: denied.headers })).status()).toBe(403);
  for (const method of ['post', 'put'] as const)
    expect((await request[method](path, { headers: denied.headers, data: input })).status()).toBe(403);
  expect((await request.post(`/api/incidents/${randomUUID()}/vitals/${reportId}`,
    { headers: first.headers, data: input })).status()).toBe(404);
  const headers = first.headers;
  for (const invalid of [
    { ...value, heartRate: null }, { ...value, heartRate: 0 }, { ...value, respiratoryRate: -1 },
    { ...value, spo2: 99.5 }, { ...value, spo2: 101 }, { ...value, measuredAt: '2999-01-01T00:00:00Z' },
    { ...value, note: 'x'.repeat(2001) }, { ...value, reportingPatroller: 'x'.repeat(101) },
  ]) expect((await request.post(path, { headers, data: { ...input, value: invalid } })).status()).toBe(400);

  const simultaneousCreates = await Promise.all([0, 1].map(() => request.post(path, {
    headers, data: { ...input, createdBy: 'spoof', resortId: 'another-resort' },
  })));
  expect(simultaneousCreates.map(response => response.status()).sort()).toEqual([200, 201]);
  const created = simultaneousCreates.find(response => response.status() === 201)!;
  const saved = await created.json();
  expect(Date.parse(saved.report.value.measuredAt)).toBe(Date.parse(value.measuredAt));
  expect(saved.report.createdBy).toBe(first.uid);
  expect(saved.report.value.spo2).toBeNull();
  expect((await request.post(path, { headers, data: input })).status()).toBe(200);
  expect((await request.post(path, { headers, data: { ...input, value: { ...value, heartRate: 90 } } })).status()).toBe(409);
  expect((await request.post(path, { headers: second.headers, data: input })).status()).toBe(409);

  const edit1 = { operationId: randomUUID(), value: { ...value, heartRate: 81, spo2: 97 } };
  const edit2 = { operationId: randomUUID(), value: { ...value, heartRate: 82, note: 'Fictional correction' } };
  const responses = await Promise.all([
    request.put(path, { headers, data: edit1 }), request.put(path, { headers: second.headers, data: edit2 }),
  ]);
  for (const response of responses) expect(response.status()).toBe(200);
  const history = await (await request.get(`${path}/history`, { headers })).json();
  expect(history.items).toHaveLength(3);
  expect(history.items.map((item: { revision: number }) => item.revision)).toEqual([1, 2, 3]);
  expect(history.items[0].before).toBeNull();
  expect(history.items[1].before).toEqual(history.items[0].after);
  expect(history.items[2].before).toEqual(history.items[1].after);
  expect(new Set(history.items.slice(1).map((item: { editor: string }) => item.editor)))
    .toEqual(new Set([first.uid, second.uid]));
  const retry = await (await request.put(path, { headers, data: edit1 })).json();
  expect(retry.report.revision).toBe(3);
  expect(retry.report.value).toEqual(history.items[2].after);
  expect(retry.report.createdBy).toBe(first.uid);
  expect((await (await request.post(path, { headers, data: input })).json()).report.revision).toBe(3);
  expect((await (await request.get(`${path}/history`, { headers })).json()).items).toHaveLength(3);
  const list = await (await request.get(root, { headers: second.headers })).json();
  expect(list.items).toHaveLength(1);
  expect(list.items[0].revision).toBe(3);
  expect((await request.get(`${root}?cursor=not-valid`, { headers })).status()).toBe(400);
});

test('vital pagination includes all reports in timestamp order and isolates incidents', async ({ request }) => {
  const account = await dispatcher(request);
  const incidentId = randomUUID(), otherIncidentId = randomUUID();
  for (const id of [incidentId, otherIncidentId])
    expect((await request.post('/api/incidents', { headers: account.headers,
      data: { id, latitude: 47.42, longitude: -121.42 } })).status()).toBe(201);
  const root = `/api/incidents/${incidentId}/vitals`;
  const reportIds: string[] = [];
  for (let index = 0; index < 101; index++) {
    const reportId = randomUUID();
    reportIds.push(reportId);
    const response = await request.post(`${root}/${reportId}`, { headers: account.headers, data: {
      operationId: randomUUID(), value: { measuredAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
        heartRate: null, respiratoryRate: null, spo2: index % 101, reportingPatroller: null, note: null },
    } });
    expect(response.status()).toBe(201);
  }
  const ids = new Set<string>(), times: number[] = [];
  let cursor: string | null = null, pages = 0;
  do {
    const response = await request.get(`${root}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
      { headers: account.headers });
    expect(response.status()).toBe(200);
    const page = await response.json();
    expect(page.items.length).toBeLessThanOrEqual(100);
    for (const report of page.items) {
      ids.add(report.id); times.push(Date.parse(report.value.measuredAt));
    }
    cursor = page.cursor;
    pages++;
  } while (cursor);
  expect(ids.size).toBe(101);
  expect(times).toHaveLength(101);
  expect(pages).toBeGreaterThan(1);
  expect(times).toEqual([...times].sort((a, b) => b - a));
  for (let index = 0; index < 100; index++)
    expect((await request.put(`${root}/${reportIds[0]}`, { headers: account.headers, data: {
      operationId: randomUUID(), value: { measuredAt: '2026-01-01T00:00:00Z', heartRate: null,
        respiratoryRate: null, spo2: index, reportingPatroller: null, note: null },
    } })).status()).toBe(200);
  const firstHistory = await (await request.get(`${root}/${reportIds[0]}/history`, { headers: account.headers })).json();
  expect(firstHistory.items).toHaveLength(100);
  expect(firstHistory.items[0].revision).toBe(1);
  const lastHistory = await (await request.get(`${root}/${reportIds[0]}/history?cursor=${encodeURIComponent(firstHistory.cursor)}`,
    { headers: account.headers })).json();
  expect(lastHistory.items).toHaveLength(1);
  expect(lastHistory.items[0].revision).toBe(101);
  expect(lastHistory.cursor).toBeNull();
  expect((await request.get(`${root}/${reportIds[1]}/history?cursor=${encodeURIComponent(firstHistory.cursor)}`,
    { headers: account.headers })).status()).toBe(400);
  const empty = await request.get(`/api/incidents/${otherIncidentId}/vitals`, { headers: account.headers });
  expect((await empty.json()).items).toEqual([]);
});

test('dispatcher records, retries, corrects and sees automatically refreshed vitals without losing input', async ({ page, request }) => {
  const account = await dispatcher(request), colleague = await dispatcher(request);
  const incidentId = randomUUID();
  await request.post('/api/incidents', { headers: account.headers,
    data: { id: incidentId, latitude: 47.42, longitude: -121.42 } });
  const root = `/api/incidents/${incidentId}/vitals`;
  await page.goto('/');
  await page.getByLabel('Email', { exact: true }).fill(account.email);
  await page.getByLabel('Password', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByTitle(`Incident ${incidentId}`, { exact: true }).click();
  const panel = page.getByRole('region', { name: 'Incident vitals', exact: true });
  await expect(panel.getByText('No vital reports recorded.')).toBeVisible();
  await panel.getByLabel('Heart rate (beats/min)', { exact: true }).fill('80');
  await panel.getByLabel('Measurement time', { exact: false }).fill('2026-03-08T02:30');
  await panel.getByRole('button', { name: 'Save vitals', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('may not exist during a daylight-saving change');
  await panel.getByLabel('Measurement time', { exact: false }).fill('2026-11-01T01:30');
  const offset = panel.getByRole('combobox', { name: 'Time offset (repeated local time)', exact: true });
  await expect(offset).toHaveValue('');
  await offset.selectOption({ label: 'Nov 1, 2026, 1:30 AM PST' });
  await panel.getByLabel('Measurement time', { exact: false }).fill('2026-01-01T04:03');
  const bodies: string[] = [];
  let reportId = '';
  await page.route(`**${root}/*`, async route => {
    if (route.request().method() !== 'POST') return route.continue();
    bodies.push(route.request().postData()!);
    if (bodies.length === 1) {
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      reportId = (await response.json()).report.id;
      return route.abort('failed');
    }
    return route.continue();
  });
  await panel.getByRole('button', { name: 'Save vitals', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('Save not confirmed');
  await expect(panel.getByLabel('Heart rate (beats/min)', { exact: true })).toHaveValue('80');
  await panel.getByRole('button', { name: 'Retry vital save' }).click();
  await expect(panel.getByRole('status')).toContainText('Vital report saved');
  expect(bodies[1]).toBe(bodies[0]);
  const row = panel.locator(`[data-report-id="${reportId}"]`);
  await expect(row).toContainText('80');
  await expect(panel.getByRole('img', { name: /Heart rate/ }).locator('circle')).toHaveCount(1);
  await expect(panel.getByText('No measurements reported.')).toHaveCount(2);
  await row.getByRole('button', { name: 'Correct', exact: true }).click();
  await panel.getByLabel('SpO2 (%)', { exact: true }).fill('98');
  await panel.getByRole('button', { name: 'Save correction', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('Vital report saved');
  await row.getByRole('button', { name: 'Audit history', exact: true }).click();
  await expect(panel.getByRole('heading', { name: 'Version 2 - Correction' })).toBeVisible();
  await expect(panel.getByRole('region', { name: 'Vital audit history' })).toContainText(account.uid);
  await panel.getByLabel('Heart rate (beats/min)', { exact: true }).fill('77');
  const otherId = randomUUID();
  await request.post(`${root}/${otherId}`, { headers: colleague.headers, data: {
    operationId: randomUUID(), value: { measuredAt: '2026-01-01T12:04:59.123Z', heartRate: null,
      respiratoryRate: 12, spo2: 99, reportingPatroller: null, note: 'Fictional later report' },
  } });
  await expect(panel.locator(`[data-report-id="${otherId}"]`)).toBeVisible({ timeout: 20000 });
  await expect(panel.getByLabel('Heart rate (beats/min)', { exact: true })).toHaveValue('77');
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('button', { name: 'Close incident popout' }).click();
  await expect(panel).toBeVisible();
  page.once('dialog', dialog => dialog.accept());
  await panel.getByRole('button', { name: 'Cancel changes' }).click();
  await panel.locator(`[data-report-id="${otherId}"]`).getByRole('button', { name: 'Correct', exact: true }).click();
  await panel.getByLabel('Note (optional)').fill('Fictional note correction');
  await panel.getByRole('button', { name: 'Save correction', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('Vital report saved');
  const stored = await (await request.get(root, { headers: account.headers })).json();
  expect(Date.parse(stored.items.find((item: { id: string }) => item.id === otherId).value.measuredAt))
    .toBe(Date.parse('2026-01-01T12:04:59.123Z'));
  await page.reload();
  await page.getByTitle(`Incident ${incidentId}`, { exact: true }).click();
  await expect(page.locator(`[data-report-id="${reportId}"]`)).toContainText('98');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: 'Save vitals', exact: true })).toBeVisible();
});
