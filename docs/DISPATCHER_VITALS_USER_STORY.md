# Dispatcher: track radio-reported vitals over time

## Status and boundary

**Approved story; implementation authorized 2026-11-12.**
Story ID: **DIS-VITALS-01**. Following merge of the baseline, the user authorized
implementation and resolved the blocking choices below. Closed-incident behavior
remains deferred. Publication and cloud deployment require separate authorization.

**As a dispatcher, I want to record radio-reported patient vitals on an incident
and review their changes over time, so I can follow the reported measurements.**

- Persona: authenticated dispatcher assigned to the incident's ski area/resort.
- Trigger: a patroller reports measurements over the radio.
- Entry: select an existing incident for one patient; first story covers open
  incidents only. Patient identification and incident creation are neighboring
  journeys, not new forms required by this story.
- Goal: save a partial or complete report, review the chronological history and
  per-vital trends, and correct a saved report with full audit history.
- Exit: save is confirmed and the report appears in the incident history; the
  dispatcher may record the next report or leave.
- Safety: record reported observations, not medical verification, diagnosis,
  treatment guidance, clinical alerts, or severity classification.
- Scope: heart rate (beats/min), respiratory rate (breaths/min), and SpO2 (%).
  Implementation is authorized; publication, deployment, and real patient data are not.

## Ordered journey and acceptance criteria

Criteria describe approved behavior; implementation evidence is tracked below.

| ID | User action / Given-When | System response / Then | Validation, persisted effect, next state |
|---|---|---|---|
| DV-01 | An authorized dispatcher selects an existing incident. | Show a vital-entry form, the incident's saved history newest measurement first, and separate trend charts for each vital. Clearly identify the selected incident. | Server verifies dispatcher access to the incident's ski area/resort. Read only; no patient details are invented. An empty history is explicitly empty. |
| DV-02 | The dispatcher enters a radio report. | Accept any subset of the three vitals, an optional reporting patroller, and an optional note. Label units. Measurement time defaults to now and is adjustable. | Require at least one vital. Heart and respiratory rates are positive whole numbers; SpO2 is a whole number from 0 through 100 inclusive. Unreported values remain absent, not zero or copied from earlier reports. Unsaved form state is not a record. |
| DV-03 | The dispatcher adjusts measurement time, including backfill before incident creation. | Enter and display time in the ski area/resort timezone with a visible timezone label. Order history by measurement time rather than entry time. | Reject future measurement instants using server time. Store an unambiguous measurement instant separately from the server-assigned entry instant. No lower bound at incident creation is imposed. |
| DV-04 | The dispatcher explicitly selects Save. | Show saving, then saved or failed; only acknowledge success after server confirmation. On success, show the saved report in the history and relevant charts. | Persist a stable report ID linked to the incident/resort, supplied measurements/time/source/note, and authenticated recorder identity plus server entry time. Invalid requests make no change. |
| DV-05 | The dispatcher reviews measurements across multiple reports. | The table shows measurement time and reported values; separate labeled charts plot each vital against measurement time. Missing values are not plotted as zero or carried forward. | Reads use current saved versions. Corrections to measurements/time update their corresponding table/chart entries. Entry time is not substituted for measurement time. No clinical interpretation is added. |
| DV-06 | Any dispatcher assigned to the same ski area/resort corrects a saved report, including another dispatcher's report. | Allow explicit Save of the correction. Retain the original and all subsequent versions; do not offer permanent deletion. | Apply the same vital/time validation. Maintain record identity and original recorder/time. Each accepted edit records the actual prior and new state, changed fields, authenticated editor, and server edit time. |
| DV-07 | A dispatcher inspects a report's audit history. | Show initial recording and every accepted correction, including what changed, who changed it, and when. | Preserve historical attribution and ordering independently of user-adjustable measurement time. Optional reporting patroller is the reported source, not the authenticated recorder/editor. |
| DV-08 | Two valid corrections to the same report arrive, despite concurrency being unlikely. | Allow overwrite: the last correction accepted by the server becomes the current report. No editor lock or user-facing stale-version conflict workflow is required. | Retain every accepted version and audit the actual immediately preceding saved state. Retrying an already-accepted correction must not overwrite a later correction or create another audit entry. Independent new reports remain separate. |
| DV-09 | Save fails or the response is lost; the dispatcher retries. | Preserve input while the form stays open, show failure or an unconfirmed result honestly, and allow retry without duplicate reports or edits. | Use the same operation identity for an exact retry. Show the authoritative current state if a later edit has superseded that operation. Changed content is a new operation, not a retry. |
| DV-10 | The dispatcher attempts to navigate away with unsaved changes, or reads fail. | Warn before leaving unfinished input. If a history/chart read fails, display the failure; retained data must not be presented as freshly loaded. | No offline write queue, persistent vital drafts, or browser-crash recovery is promised. Standard browser limitations on unload warnings apply. |
| DV-11 | An unauthenticated user or dispatcher outside the incident's ski area/resort tries to read, add, correct, or inspect audit history. | Deny access server-side, not merely by hiding controls. | No unauthorized read or write. Ownership and audit identity come from server-verified context, never client assertions. |

## Permissions, lifecycle, and handoff

All dispatchers assigned to the incident's ski area/resort can view, add, correct,
and inspect audit history. Explicit incident assignment is not required.
Patroller/supervisor access is not defined by this story. General account
administration and multi-resort access design remain separate dependencies.

Reports have unsaved input versus saved evidence; no draft submission, clinical
approval, or success/outcome lifecycle is introduced. Corrections update current
evidence but never erase prior evidence. Closure restrictions and reopening are
deferred; do not add a closure lifecycle or invent a closed flag to finish this
story. Viewing historical vitals by other personas and downstream handoff/export
are outside scope.

The overwrite decision deliberately permits loss of another dispatcher's changes
from the current view, but not from audit history. It is not a one-editor
guarantee. Audit retention and write ordering remain necessary even without a
user-facing concurrency conflict.

## Current-flow comparison and implementation evidence

Baseline inspected: fetched `origin/main` commit `89daa0f`. The original checkout
was older and described a feature-free scaffold; the fetched baseline supersedes
that description for this story.

| Evidence | Current behavior | Gap |
|---|---|---|
| `README.md`; `docs/OPERATIONS.md`, Dispatch POC contract | Firebase dispatcher sign-in, shared incident list/map, saved incident popout, manual refresh. Fictional-data POC only. | No vital-entry or trend/audit UI. No incident closure or patient workflow. |
| `backend/PatrollerAudit.Api/Incidents.cs` | Immutable schema-v1 incident with UUID, resort, coordinates, creator, and creation time; authenticated create/list/read and create retry identity. | No vital domain entity or correction/history endpoints. |
| `frontend/src/dispatch.ts`; `frontend/src/DispatchMap.tsx` | Incident types/API helper, selectable map markers, and time formatting in `America/Los_Angeles`. | No vital DTOs or forms. Resort timezone is fixed for Summit West, not configurable generally. |
| `docs/OPERATIONS.md`, Configuration and Dispatch POC contracts | Server policy requires verified `dispatcher: true` and `resortId: "summit-west"`; incidents container partitions by `/resortId`. | General resort/area membership is deferred; a new vitals store needs explicit provisioning and scoped access. |

The table above records the pre-implementation baseline, not the current feature.
Implementation adds the vital model and contract described below. Related journey:
the Dispatch POC contract in
[Operations](OPERATIONS.md).

## Data-model and API impact

The baseline had incidents but no vital reports, revisions, or patient entities.
Implementation adds reports and revisions, not reuse of coordinates,
creation timestamps, or free-form incident fields. One incident represents one
patient's vital history for this scope; no demographic data or multi-patient
model is introduced.

Implemented representation:

- Incident has zero to many reports. Each report has stable identity, incident
  identity, resort ownership, schema version, nullable measurements with explicit
  units, measurement instant, optional source/note, immutable initial recorder
  identity/server time, and a current revision.
- Each accepted create/correction has a stable operation identity and immutable
  revision. Retain before/after values, editor identity, server timestamp, and
  deterministic revision order. Preserve source/attribution as recorded; do not
  rewrite historical attribution when account or source labels change.
- Authenticated server context supplies ownership and audit identities. The
  measurement instant is dispatcher input validated server-side, not proof of
  when a patroller physically measured a vital.
- Report is the aggregate boundary, not the entire incident. Independent
  reports must not rewrite incident metadata or overwrite other reports.
  Current state, audit append, and operation receipt must commit atomically.
  Internal version checks/retries may serialize writes, but must implement the
  approved overwrite policy rather than expose a new conflict workflow.
- An exact retry confirms its originally accepted revision and returns the
  current report without another write;
  a reused identity with changed payload must be rejected. Account for a lost
  response followed by a newer edit. No autosave or private-draft writes exist
  in this scope, so that race is excluded; shared correction races are covered.
- Incident-scoped create/list/correct/audit commands and queries
  require parent-incident existence and resort authorization on every request.
  Response contracts include server save status/current revision and timestamps;
  correction failures must not falsely acknowledge persistence.
- Lists use measurement time descending, original entry time descending, and ID
  ascending, with opaque continuation cursors and at most 100 records per page.
  The client follows all pages before replacing displayed history/charts.
- The new `vitals` container partitions by `/incidentKey`, combining the
  server-owned resort and incident UUID. Current report and immutable revision
  (also the operation receipt) commit atomically. Internal ETags serialize
  overwrites, retrying up to eight times before a retryable 503.
  No independent best-effort audit writes or unbounded embedded audit arrays.
- Backend validators/DTOs/persistence and frontend types/forms/charts/audit
  readers are added. No export or downstream medical reader exists to update.
  Future fixtures and acceptance records must be fictional and API-created.

Existing incidents remain valid and have empty vital histories; do not fabricate
patient records, measurements, performers, occurrence times, or lifecycle
statuses. Additive storage leaves schema-v1 incident creation/read
behavior intact. Reports and revisions are schema v1; unreported vital fields are
null, never inferred. An older retained app revision can ignore additive vital storage;
rollback must preserve reports and audit history rather than delete containers.

Before separately authorized rollout, provision required containers/indexes and
container-scoped permissions before dependent application code is deployed.
Local emulator provisioning/readiness includes the new container and index.
Real patient-data retention, privacy, networking, and launch
review remain unmet operational prerequisites, not authorized by this story.

## Decisions and deferred scope

Confirmed: single-patient existing incident; three vitals with partial reports;
adjustable measurement time defaulting to now; optional reporting patroller/note;
table plus separate trends; explicit Save; full audit and no permanent deletion;
all resort/area dispatchers can view/edit; backfill before incident start;
future times rejected; specified numeric validation; open-incident scope;
overwrite allowed; online-only recovery; resort timezone.

Superseded proposal: retain input and require manual reconciliation on a
concurrent correction. The user selected overwrites instead. No lock, lease, or
single-editor enforcement is approved.

| ID | Resolution | Impact |
|---|---|---|
| OQ-01 | Resolved: optional free-text patroller name/call sign stored with each version. | No roster dependency or invented identity; proposed maximum 100 characters. |
| OQ-02 | Resolved: whole-number SpO2; backend timestamps retain precision, UI input/display use whole minutes. | No rounding of fractional SpO2. Unchanged measurement instants retain hidden seconds during corrections. Proposed note limit 2,000 characters is applied. |
| OQ-03 | Resolved: reject nonexistent local DST times, require offset choice for repeated times, tie-break by entry time then ID, use point charts. | No interpolation or inferred readings. |
| OQ-04 | Resolved: automatic refresh while incident is open. | Implementation polls every 10 seconds with manual refresh too; preserves unfinished input. |
| OQ-05 | Resolved: Summit West only, existing verified claims and Pacific timezone. | General resort membership/configuration remains outside scope. |
| OQ-06 | Deferred: closed-incident viewing/recording/correction rules. | Explicitly excluded neighboring journey; no closure flag is introduced. |

The user confirmed the implementation choices after baseline merge. The SpO2
whole-number decision supersedes the earlier open decimal-precision question.
Timestamp storage is not truncated to minutes; only UI entry/display is
minute-level. Implementation authorization does not authorize publication,
provisioning, cloud deployment, or real patient data.

## Implementation traceability and evidence

| Criteria | Baseline gap | Model/API/UI change | Evidence |
|---|---|---|---|
| DV-01, DV-11 | No vital domain or access endpoints. | `Vitals.cs` parent lookup and existing dispatcher policy; `VitalsPanel.tsx` selected-incident form. | `frontend/e2e/dispatch.pw.ts`: real Firebase permitted/denied queries and writes; nonexistent parent and cross-incident isolation. |
| DV-02 through DV-05 | No measurement validation, time history, or trends. | Server integer/time validation; timestamp storage; minute-level timezone form; full paginated history and point charts. | `VitalsTests.cs`, `vitals.test.ts`, and real-emulator/browser cases cover partial reports, invalid/future values, DST, precision retention, backfill, pagination, missing measurements, and reload. |
| DV-06 through DV-08 | No correction or audit mechanism. | Transactional report/revision receipts with internal ETag serialization and approved overwrite behavior. | Real-emulator acceptance covers concurrent create retry, two-editor corrections, full before/after chaining, original creator retention, and audit pagination. |
| DV-09, DV-10 | No vital save/recovery UI. | Explicit save, in-memory retry identity, disabled uncertain-input form, navigation warning, visible stale reads, polling independent of edits. | `VitalsPanel.test.tsx` and browser acceptance cover lost real response, exact retry, later-version preservation, rejected input retention, failed refresh, automatic refresh, and navigation cancellation. |

All rows are implemented. The validation record below distinguishes checks run
from coverage defined; no clinical correctness, cloud authorization/provisioning,
or real-world patrol readiness is claimed. All acceptance data is fictional and
created through authenticated APIs and the Firebase Auth emulator.

### Validation record

Validation uses the isolated Compose project `patroller-audit-feat-dispatcher-vitals`
and API/Firebase origins `http://127.0.0.1:38080` and `http://127.0.0.1:39099`.
Other worktrees' stacks are untouched; no cloud rollout was performed. Frontend
commands used Node 24.22.3 through
`npx --yes --package=node@24 --package=npm@11 -c "<command>"` because the default
host Node is too old for this repository.

| Command | Result |
|---|---|
| `dotnet restore backend\PatrollerAudit.slnx --locked-mode` | Passed. |
| `dotnet format backend\PatrollerAudit.slnx --verify-no-changes --no-restore` | Passed on the final backend source. |
| `dotnet build backend\PatrollerAudit.slnx -c Release --no-restore --verbosity quiet` | Passed on the final backend source, no warnings/errors. |
| `dotnet test backend\PatrollerAudit.slnx -c Release --no-restore` | Initially passed 20 tests. A later rerun was blocked by Windows Application Control loading the test assembly (0x800711C7); final query/retry changes are not claimed unit-test verified. No policy was disabled or bypassed. |
| In `frontend`: `npm run lint`, `npm run build`, `npm test` | Passed; 17 unit tests, including timestamp/DST, paginated reads, and recovery cases. |
| In `frontend`: `npm run test:e2e` | Existing three dispatch cases passed. Subsequent targeted runs verified the finalized vitals cases after fixing pagination and a test selector; the initial full run is not claimed wholly passing. |
| In `frontend`: `npm run test:e2e -- --grep vital` | Final API/audit and 101-report/101-revision pagination cases passed; browser case then exposed an overly strict label selector. |
| In `frontend`: `npm run test:e2e -- --grep dispatcher.records` | Passed after selector correction, including DST input, lost real save response, audit, automatic refresh, navigation, reload, and mobile layout. Together the runs cover all six acceptance cases against real Firebase/Cosmos emulators. |
| `.\scripts\Start-Local.ps1 -Port 38080`; `.\scripts\Test-Local.ps1 -Port 38080` | Passed with all five isolated port variables and project name supplied. |
| `az bicep build --file infrastructure\main.bicep --stdout` | Passed; includes the new container/index/scoped grant module. |
