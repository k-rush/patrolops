# Dispatcher: track radio-reported vitals over time

## Status and boundary

**Approved story baseline with open questions - 2026-11-12.**
Story ID: **DIS-VITALS-01**. The user approved the consolidated scope with the
listed open questions. Conversation decisions below are confirmed requirements;
technical proposals and unresolved details are not implementation approval.

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
  Implementation, publication, deployment, and real patient data are not authorized.

## Ordered journey and acceptance criteria

Criteria describe expected behavior, not implemented behavior.

| ID | User action / Given-When | System response / Then | Validation, persisted effect, next state |
|---|---|---|---|
| DV-01 | An authorized dispatcher selects an existing incident. | Show a vital-entry form, the incident's saved history newest measurement first, and separate trend charts for each vital. Clearly identify the selected incident. | Server verifies dispatcher access to the incident's ski area/resort. Read only; no patient details are invented. An empty history is explicitly empty. |
| DV-02 | The dispatcher enters a radio report. | Accept any subset of the three vitals, an optional reporting patroller, and an optional note. Label units. Measurement time defaults to now and is adjustable. | Require at least one vital. Heart and respiratory rates are positive whole numbers; SpO2 is a number from 0 through 100 inclusive. Unreported values remain absent, not zero or copied from earlier reports. Unsaved form state is not a record. |
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

No feature code has been changed or verified for this story. There are no other
maintained user-story, domain-model, or API guide documents in the fetched `docs`
directory. Related current journey: the Dispatch POC contract in
[Operations](OPERATIONS.md).

## Data-model and API impact

The incident domain model exists; vital reports, revisions, and patient entities
do not. This story requires a new vital-report concept, not reuse of coordinates,
creation timestamps, or free-form incident fields. One incident represents one
patient's vital history for this scope; no demographic data or multi-patient
model is introduced.

Proposed representation, subject to implementation design review:

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
- Report is the proposed aggregate boundary, not the entire incident. Independent
  reports must not rewrite incident metadata or overwrite other reports.
  Current state, audit append, and operation receipt must commit atomically.
  Internal version checks/retries may serialize writes, but must implement the
  approved overwrite policy rather than expose a new conflict workflow.
- An exact retry returns its original operation result without another write;
  a reused identity with changed payload must be rejected. Account for a lost
  response followed by a newer edit. No autosave or private-draft writes exist
  in this scope, so that race is excluded; shared correction races are covered.
- Proposed incident-scoped create/list/read/correct/audit commands and queries
  require parent-incident existence and resort authorization on every request.
  Response contracts include server save status/current revision and timestamps;
  correction failures must not falsely acknowledge persistence.
- Listing needs deterministic measurement-time order, pagination, and an audit
  cursor/order. Charts must not silently represent only one page as complete
  history. Equal-time ordering, chart retrieval, and DST ambiguity remain open.
- Container layout, partition key, measurement-time indexes, and transaction
  boundaries must be selected together. A resort partition is compatible with
  current ownership, but container selection and throughput are not approved.
  Audit and receipt writes cannot be best-effort independent writes.
- New backend validators/DTOs/repositories and frontend types/forms/charts/audit
  readers are required. No export or downstream medical reader exists to update.
  Future fixtures and acceptance records must be fictional and API-created.

Existing incidents remain valid and have empty vital histories; do not fabricate
patient records, measurements, performers, occurrence times, or lifecycle
statuses. Prefer additive storage that leaves schema-v1 incident creation/read
behavior intact. Vital schema versioning and absent-field rules need explicit
contracts. An older retained app revision can ignore additive vital storage;
rollback must preserve reports and audit history rather than delete containers.

Before separately authorized rollout, provision required containers/indexes and
container-scoped permissions before dependent application code is deployed.
Local emulator provisioning/readiness must be updated alongside approved
implementation. Real patient-data retention, privacy, networking, and launch
review remain unmet operational prerequisites, not authorized by this story.

## Decisions and open questions

Confirmed: single-patient existing incident; three vitals with partial reports;
adjustable measurement time defaulting to now; optional reporting patroller/note;
table plus separate trends; explicit Save; full audit and no permanent deletion;
all resort/area dispatchers can view/edit; backfill before incident start;
future times rejected; specified numeric validation; open-incident scope;
overwrite allowed; online-only recovery; resort timezone.

Superseded proposal: retain input and require manual reconciliation on a
concurrent correction. The user selected overwrites instead. No lock, lease, or
single-editor enforcement is approved.

| ID | Unresolved or provisional decision | Impact |
|---|---|---|
| OQ-01 | Optional reporting patroller: free text, a roster identity, or both? Is a snapshot label required? | Resolve before source-field implementation; do not invent roster administration. |
| OQ-02 | SpO2 decimal precision; note/source length limits; timestamp entry precision. | Numeric range is agreed, but rounding and payload limits are not. |
| OQ-03 | DST repeated/nonexistent local times; equal measurement-time ordering; chart point/line presentation. | Resolve ambiguous time entry and deterministic presentation without medical interpretation. |
| OQ-04 | Explicit refresh versus automatic synchronization of other dispatchers' changes. | Current incidents refresh manually; no live subscription has been approved for vitals. |
| OQ-05 | Is Summit West the initial delivery target, using its existing verified claims and Pacific timezone? | General resort membership/timezone configuration is not implemented and is not implicitly authorized. |
| OQ-06 | Closed-incident viewing/recording/correction rules. | Explicitly deferred neighboring journey, not part of this story's first delivery. |

The approved baseline retains the listed open questions; blocking source/time/
contract decisions must be resolved before implementation. Story approval does
not authorize feature implementation or publication.

## Future implementation traceability and evidence

| Criteria | Required change | Future evidence |
|---|---|---|
| DV-01, DV-11 | Incident-scoped queries, verified resort authorization, selected-incident UI. | Authenticated allowed/denied API reads and writes using real Firebase/Cosmos emulators. |
| DV-02 through DV-05 | Report persistence, server validation/time rules, form, table, and charts. | API-created partial/complete reports, boundary/future-time rejection, reload persistence, backfill ordering, absent readings, and timezone cases. |
| DV-06 through DV-08 | Atomic current revision/audit/receipt writes, corrections and audit UI, overwrite policy. | Cross-dispatcher correction, complete before/after attribution, concurrent accepted writes, and no lost audit versions. |
| DV-09, DV-10 | Explicit save state, exact retry, preserved in-form input, navigation warning, failed-read handling. | Failed/uncertain save and retry, retry after a later edit, no duplicate revisions, and visible stale/read-failure state. |

All rows are **expected, not implemented or verified**. Implementation requires
separate authorization and end-to-end API/browser evidence, not screenshots or
pure-client tests alone. No screenshots or deployment evidence were requested.
