# Operations

## Configuration contract

ASP.NET configuration uses `__` in environment variable names. Base settings are
in `backend\PatrollerAudit.Api\appsettings.json`; do not commit credentials.

| Setting | Cloud | Local Compose |
|---|---|---|
| `ASPNETCORE_ENVIRONMENT` | `Production` | `Development` |
| `Auth__ProjectId` | Dedicated real Firebase project for the ring | `demo-patroller-audit-local` |
| `Auth__ApiKey` | Public Firebase web API key | Local placeholder supplied by `/api/config` |
| `Auth__Domain` | Optional auth domain; defaults to `<project>.firebaseapp.com` | Not needed for email/password emulator login |
| `Auth__EmulatorPublicUrl` | Unset | Loopback Firebase URL using `FIREBASE_AUTH_PORT` |
| `Auth__EmulatorEnabled`, `Emulator__Enabled` | `false` | `true` |
| `FIREBASE_AUTH_EMULATOR_HOST` | Unset | `firebase-auth-emulator:9099` |
| `CosmosDb__AccountEndpoint` | Azure Cosmos HTTPS endpoint | Unset |
| `CosmosDb__DatabaseName` | Dedicated ring database | `patroller-audit-local` |
| `CosmosDb__ConnectionString` | Forbidden; managed identity only | Public emulator connection string |
| `Emulator__CertificatePath` | Unset | Captured certificate volume |
| `AZURE_CLIENT_ID` | User-assigned app identity | Unset |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | Supplied by Bicep | Unset |

Non-development startup fails without Firebase/Cosmos configuration and rejects
emulator settings or Cosmos account keys. Local certificate acquisition is
trust-on-first-use only inside the Compose network. Only the configured emulator
client trusts the captured certificate; global TLS validation is not disabled.
Cloud authentication validates Firebase JWT signatures, issuer, audience,
expiry, and subject. Local authentication uses Firebase Admin's actual emulator
verification. Product endpoints require authentication by default. Incident endpoints
additionally require verified custom claims `dispatcher: true` and
`resortId: "summit-west"`. Only trusted account administration may assign these
claims; public registration is not an authorization path. The browser has no
account creation or claim editing UI.

`/health` checks process liveness without calling dependencies. `/api/health`
checks Cosmos database access and returns 503 when unavailable/unconfigured.
It does not claim that Firebase, user login, or product workflows have been
validated. Unknown `/api/*` routes return 404 instead of the SPA. `/api/config`
anonymously exposes public Firebase web configuration only, never service credentials.

## Dispatch POC contract

The bounded journey is an authenticated Summit West dispatcher opening the map,
clicking a location, and seeing a saved incident popout. Closing the popout only
hides it; the marker and shared incident list remain. Reload reads saved records.
The map starts at the Summit West base area (47.4206, -121.4213); clicks are not
geofenced. This is not a real-time collaboration or operational patrol system.

| Action | API / invariant | Persisted effect / UI |
|---|---|---|
| Sign in | Firebase email/password; verified dispatcher and resort claims on every product request | No app user records; unauthorized accounts cannot list or create incidents |
| Open map/list or refresh | `GET /api/incidents?cursor=...`; resort partition fixed by server, pages of at most 100 | Client follows opaque continuation cursors; previous records stay visible with a warning if refresh fails |
| Click map | `POST /api/incidents` with UUID, latitude, longitude; finite coordinates within global ranges | Creates immutable schema-v1 incident; server assigns UTC `createdAt`, token subject `createdBy`, and `resortId`; popout appears only after save confirmation |
| Reopen marker | `GET /api/incidents/{uuid}` also supports individual reads | No write; popout shows ID, coordinates, and creation time formatted in `America/Los_Angeles` |
| Retry uncertain save | Same UUID and coordinates, same authenticated creator | Create conflict returns original record and time; changed payload or creator returns 409, never overwrites |

This introduces the first domain container, `incidents`, partitioned by `/resortId`.
IDs are client-generated UUID request identities, not trusted business attribution.
Creation time is entry time, not an asserted incident occurrence time.
Incident metadata has no status, patient details, assignment, update/delete endpoint,
or offline write queue. Its append-only records do not need edit ETags.
The separate vital-report contract below adds measurements and corrections without
changing incident metadata. The default Cosmos index supports descending `createdAt` reads;
all queries use the fixed Summit West partition. Other resorts and general
multi-resort permissions remain deferred.

Pending save identity is retained in browser session storage, scoped to the signed-in
user, before a request is sent. A reload offers a manual retry, not an automatic
write. With browser storage disabled, only in-memory retry survives. Closing the
tab can lose an unconfirmed request identity; consult the shared list before
creating a replacement. No input is represented as saved before the server replies.
The server stores initial creator/time for incident attribution. Incident metadata
has no correction/history workflow; vital reports retain their own revision history.

The old scaffold had no domain records, so there is no historical migration or
backfill. Before any separately authorized cloud rollout, provision the new
container and its container-scoped data contributor grant using the foundation
template. The existing database read grant remains; no account-wide write grant
is added. Supply GitHub environment variable `FIREBASE_API_KEY` (public web key),
enable Firebase email/password sign-in, and provision authorized accounts using
trusted Firebase administration. No cloud accounts are created by this feature.
Retained old app revisions ignore the new container; rollback must not delete it.

For local use, `scripts\New-LocalDispatcher.ps1` accepts a secure password prompt
and refuses non-loopback or non-demo configuration. It creates only the explicitly
requested fictional local account. Packaged-app acceptance uses real Firebase
identities and API-created Cosmos records, including denied access, client
timestamp spoofing, lost-response retry, list/map switching, and reload recovery.

## Dispatcher vitals contract

The [approved story](DISPATCHER_VITALS_USER_STORY.md) covers a single patient's
reported vitals per existing incident. Only Summit West is supported, using the
same verified dispatcher/resort claims as incidents. No closed-incident lifecycle,
roster administration, clinical interpretation, or real patient-data launch is added.

| Action | API / invariant | Persisted effect / UI |
|---|---|---|
| Read vitals | `GET /api/incidents/{incidentId}/vitals?cursor=...` | Current reports, pages of at most 100; measurement time descending, original entry time descending, ID ascending. Client follows all cursors before updating table/charts. |
| Record report | `POST /api/incidents/{incidentId}/vitals/{reportId}` with UUID `operationId` and `value` | `value` holds `measuredAt`, nullable `heartRate`, `respiratoryRate`, `spo2`, `reportingPatroller`, and `note`. At least one vital; positive integer rates; integer SpO2 0-100. Server validates and assigns creator/editor and entry/edit timestamps. |
| Correct report | `PUT` to the same report path with a fresh operation UUID and complete replacement `value` | Last server-accepted write becomes current. Original creator/time remain. No permanent deletion or user-facing stale-edit conflict; each overwrite retains its actual before/after state. |
| Inspect audit | `GET /api/incidents/{incidentId}/vitals/{reportId}/history?cursor=...` | Immutable revisions ascending, authenticated editor UID, server timestamp, before/after values. Revisions also serve as operation receipts. |
| Retry uncertain save | Repeat the exact report ID, method, operation ID, values, and authenticated editor | No duplicate report/revision. Response includes the current report and `acceptedRevision`; a newer accepted correction is not rolled back. Changed input/actor with a reused identity returns 409. |

Every request verifies the parent incident in the server-owned resort partition.
An inaccessible/nonexistent incident cannot receive reports. Client-supplied resort,
creator, edit timestamps, or revision numbers are not trusted. Malformed JSON or
fractional integer measurements return 400, including in development.

All timestamps are persisted as UTC instants with backend precision. UI input and
display use whole minutes in `America/Los_Angeles`; correcting another field
preserves hidden timestamp precision. Backfill before incident creation is allowed;
future measurements are rejected against server time. Nonexistent local DST times
are rejected, and repeated times require an explicit offset selection. Patroller
source is optional free text (100 characters); optional notes allow 2,000 characters.

The separate schema-v1 `vitals` container partitions by `/incidentKey`
(`summit-west:{incidentId}`). A report document and its immutable revision/operation
receipt commit in one transactional batch. Correction uses an internal ETag to
serialize approved overwrites and preserve audit history. Contention re-reads both
state and receipt, for up to eight attempts, then returns a retryable 503 without
claiming success. This is not a user-facing optimistic-edit conflict policy.
The composite index orders `/value/measuredAt` descending, `/createdAt` descending,
and `/id` ascending; normal indexing supports per-report revision queries.
Application cursors are incident/report-scoped keyset positions, not trusted
authorization facts. Queries fetch at most 101 candidates and return at most 100,
using the extra row to signal another page; the Cosmos page-size hint alone is
not relied upon. Concurrent corrections can move a report between pages, so the
client deduplicates by ID/highest revision and refreshes the full view on its
next poll rather than claiming a multi-report transactional snapshot.

The vital panel polls every 10 seconds while its incident is open, with manual
refresh available. New data never replaces unfinished input. Missing measurements
remain absent and are not plotted as zero or interpolated. Reads that fail leave a
visible stale-data warning. Explicit saves show saving/confirmed/failed states;
unconfirmed input and exact retry identity remain in memory, and the form is locked
until retry or explicit cancellation. Navigation warns before discarding input,
subject to browser unload-warning limitations. No offline queue or crash recovery
is provided. Closing a form with an unconfirmed save does not undo a server write.

Provision the new container, composite index, and its container-scoped data
contributor grant via `infrastructure/main.bicep` **before** deploying this app
revision. Cloud readiness now requires both containers. Local readiness provisions
the same container/index against the real emulator. Existing incidents require no
migration: their vital history starts empty. Older app revisions ignore the new
container; rollback must retain all reports and revisions. No provisioning or cloud
deployment is authorized merely by implementing or merging this feature.

## One-time cloud bootstrap

No cloud resources or GitHub settings are changed by creating this scaffold.
Before running delivery workflows:

1. Create a **dedicated** Azure resource group and register the Container Apps,
   Cosmos, Container Registry, monitoring, and managed identity resource providers.
   Verify regional availability, spend, and naming before applying.
2. Create separate real Firebase projects for each approved ring and enable
   Firebase Authentication with email/password sign-in. Do not reuse another
   application's projects. Provision dispatcher accounts and their custom claims
   through trusted administration; customer onboarding remains deferred.
3. Create GitHub environments `infrastructure`, `build`, `test`, `staging`,
   `production`, and `test-monitor`. Restrict infrastructure, test, and monitoring
   to `main`. Allow build on `main` and promotion tags; allow staging on `main`
   and `staging-v*`, and production on `main` and `production-v*`. The main branch
   allowances support approved manual redeployments and rollbacks. Require
   reviewers for infrastructure and staging/production; disable self-approval
   where supported.
   Workflow `environment:` declarations alone do **not** configure these rules.
4. Configure Azure service principals with GitHub OIDC federation using the exact
   subject prefix returned by
   `gh api repos/k-rush/patrolops/actions/oidc/customization/sub`.
   This repository uses immutable subjects:
   `repo:<owner>@<owner-id>/<repo>@<repo-id>:environment:<environment>`.
   Append `:environment:<environment>` to `sub_claim_prefix`; do not substitute
   the legacy name-only subject. A repository rename changes this prefix even
   though its numeric ID is unchanged; reread the prefix and update each Azure
   federated credential before resuming workflows. Use issuer
   `https://token.actions.githubusercontent.com` and audience
   `api://AzureADTokenExchange`. Monitoring needs no Azure identity. Grant the infrastructure
   principal only the resource-group rights needed to provision resources and
   assign roles. Grant the build principal AcrPush through the foundation. Grant
   deploy principals resource-group deployment/Container Apps rights and registry
   read access needed by deployment checks, plus read-only access to the preceding
   ring's app/revision metadata. Avoid subscription-wide ownership.
5. Set `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` for each
   environment. Set `AZURE_RESOURCE_GROUP` and stable lowercase alphanumeric
   `NAME_PREFIX` (3-10 lowercase alphanumeric characters, beginning with a letter;
   example `patrolapp`) for infrastructure and
   ring environments. Set `BUILD_PRINCIPAL_ID` to the build principal's **object**
   ID in infrastructure. Set `ACR_NAME` and `ACR_LOGIN_SERVER` from foundation
   outputs for build and each ring. Set a distinct
   `FIREBASE_PROJECT_ID` and public web `FIREBASE_API_KEY` for each ring.
6. Protect `main` using a branch ruleset requiring pull requests and the Verify
   jobs. Protect `staging-v*` and `production-v*` tag creation/update/deletion
   with tag rulesets. Enable Dependabot alerts and secret scanning where available.

GitHub repository settings and Firebase cloud projects need this administrative
bootstrap; they are not implicitly provisioned by the Azure templates.

## Provision, publish, deploy

Run **Provision infrastructure** on `main`, initially with rings `test` and
`apply=false`. Review Azure what-if before a separate approved `apply=true` run.
Always select a cumulative ring list when adding staging or production; retain
existing rings. Incremental ARM deployments do not delete omitted resources.
The example parameter file contains an intentionally invalid placeholder
principal ID and must be customized before direct CLI deployment.

The foundation provisions a shared registry/log workspace and separate Cosmos
accounts, databases, identities, telemetry instances, and Container Apps
environments per ring, plus the partitioned incidents container. App identities
receive database read access and write access scoped to that container only.
Cosmos currently has a public endpoint but rejects account-key authentication.
Private networking, alerts, retention/privacy policies, and a customer launch
review are required before real patrol data is accepted. Provisioned Cosmos
throughput and minimum app replicas incur cost even with no users.

After provisioning and setting environment variables, set repository variable
`ENABLE_TEST_DEPLOYMENT=true`. **Deploy test** listens for a successful Verify
run from a main push in this repository, builds that exact verified commit, locks
its registry tag against overwrite/deletion, and deploys test by digest. PR runs,
forks, failed CI, and reusable/manual Verify calls do not trigger publication.
Automatic publication stays disabled until explicitly enabled.

**Publish image** remains available on `main` for initial/manual publication; it
calls Verify and the same reusable **Build image** workflow. Existing locked
commit images are reused, not rebuilt. SBOM/provenance are included. Optionally
set `ENABLE_GITHUB_ATTESTATIONS=true` if repository/plan support permits attestations.
Manual **Deploy test** resolves the already-published current-main image and
never builds an unverified replacement.

Promote a verified release commit using matching version tags:

```powershell
git tag staging-v0.1.0 <verified-main-commit>
git push origin staging-v0.1.0
# After staging is accepted:
git tag production-v0.1.0 <same-verified-main-commit>
git push origin production-v0.1.0
```

**Promote release** requires the tagged commit to be merged into main. Production
requires the matching staging version tag on the same commit. Both resolve the
locked commit image without rebuilding and require that the preceding ring's
active, healthy revision actually serves that exact image, not merely that the
latest app template mentions it.

**Deploy ring** remains an approval-gated manual redeployment path. Supply both
the published commit SHA and its digest (SHA defaults to current main). It checks
main ancestry, verifies the commit-to-digest mapping, and applies the same
preceding-ring and deployment gates. It cannot invent an unpublished image.

| Workflow | Purpose |
|---|---|
| Verify | Backend/frontend/script tests, workflow lint, Bicep compilation, and real local emulator checks |
| Provision infrastructure | Manual Azure what-if/apply and applied registry output summary |
| Build image | Reusable immutable publication with OIDC, SBOM/provenance, and locked commit tags |
| Publish image | Manual verified publication |
| Deploy test | Opt-in automatic post-CI test delivery; manual existing-image retry |
| Promote release | Protected staging/production version-tag promotion |
| Deploy ring | Approved manual immutable redeployment |
| Rollback ring | Restore a retained known-good revision under target-ring approval |
| Monitor test | Opt-in scheduled read-only hosted checks |

No business data or accounts are seeded at startup. Verify includes local
authenticated dispatch API/browser acceptance, but no hosted write synthetics,
medical/compliance checks, or production persona acceptance.

## Rollback and diagnostics

PatrolOps is the current UI brand; infrastructure identifiers are unchanged.
Cloud smoke gates accept both PatrolOps and the legacy Patroller Audit brand
with matching JavaScript so retained pre-rebrand revisions can still be recovered.
Local packaged-app checks require PatrolOps.

Normal deployment snapshots the previous serving revision before applying.
Multiple-revision mode routes to the latest ready revision. Gates confirm the
candidate revision and exact digest are serving, then check liveness, Cosmos
readiness, the packaged SPA/assets, and unknown-API 404 behavior. Failed gates
restore and check the previous healthy revision, then deactivate the failed
candidate. Successful deployments deactivate the previous revision to avoid
idle replica charges while retaining up to ten inactive revisions.

For an operator rollback, run **Rollback ring** on main with a retained
known-good revision name and reason. Target-ring reviewers approve the exception
to the preceding-ring promotion requirement. The workflow validates app/registry
ownership, activates and checks the target before routing traffic, then runs
read-only gates. If rollback gates fail, it restores original traffic. Deployment
and rollback state snapshots are retained as workflow artifacts for 14 days.
A failed first deployment has no prior revision to restore; its workflow reports
that explicitly. The incidents container is additive; no historical migrations exist yet.

Set `BASE_URL` in `test-monitor` to the test HTTPS root URL and repository variable
`ENABLE_TEST_MONITORING=true` to enable **Monitor test** every 30 minutes. Manual
monitoring can run before enabling the schedule. This job performs no writes and
needs no Azure/Firebase credentials. Workflow failures are operator-visible;
configure workflow notifications separately. It does not provision Azure alert
rules or validate real Firebase sign-in.

Use Container Apps revision logs and ring Application Insights for diagnostics.
For local failures, run `docker compose ps` and `docker compose logs --tail 100`.
Stop only this project's Compose stack; never prune shared Docker resources.

The local smoke script covers the shell, configuration boundaries, Cosmos readiness,
and a rejected Firebase sign-in. Separate Playwright acceptance creates fictional
emulator identities and exercises real authenticated incident writes, reads, and
browser behavior. Neither substitutes for approved cloud deployment and acceptance
of the actual ring's Firebase configuration and account policy.

The Firebase SDK's gRPC dependency is overridden to a patched compatible release.
Development toolchains still include upstream minimatch advisories; do not expose
emulator, Vite, or test-runner ports publicly. Review Dependabot alerts before
customer deployment. Development dependencies are not shipped in the final app image.
