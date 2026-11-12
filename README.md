# PatrolOps

Ski patrol dispatch proof of concept using ASP.NET Core 10 and
React/TypeScript, with dedicated Firebase projects, Cosmos accounts, and Azure
Container Apps resources.

PatrolOps is the app's name, and its repository is
[k-rush/patrolops](https://github.com/k-rush/patrolops). .NET project, package,
infrastructure, and data identifiers retain their existing `PatrollerAudit` /
`patroller-audit` names.

The dispatcher command center has a left navigation rail, a Summit West map,
and a shared incident list. Clicking the map saves an incident in Cosmos DB and
opens a rectangular popout with its ID, server creation time in Pacific time,
and coordinates. Closing the popout keeps its reopenable marker.
Firebase email/password sign-in requires a pre-provisioned dispatcher account
with Summit West access. This POC is for fictional data only, not operational dispatch.

Select an incident to record radio-reported heart rate, respiratory rate, and
SpO2 in its patient-vitals panel. Partial reports, minute-level Pacific-time
input, timestamped history, separate point charts, and auditable corrections are
supported. Vitals refresh automatically every 10 seconds without replacing
unfinished input. See the [dispatcher vitals story](docs/DISPATCHER_VITALS_USER_STORY.md)
for scope, decisions, and implementation evidence.

## Local development

Use Docker Desktop's Linux engine and PowerShell 7:

```powershell
.\scripts\Start-Local.ps1
.\scripts\Test-Local.ps1
```

Open **http://127.0.0.1:18080**. Local Cosmos DB and Firebase Auth use real
emulators, isolated Compose resources, and persistent named volumes. Ports are
chosen to avoid common development defaults. Override ports in an untracked `.env` file
or use `Start-Local.ps1 -Port 18090`. No identities or business data are seeded.
The local readiness check creates the database and empty incidents/vitals containers.
Provision an explicit local dispatcher account (use a fictional email):

```powershell
.\scripts\New-LocalDispatcher.ps1 -BaseUrl http://127.0.0.1:18080 `
  -Email fictional-dispatcher@example.test -Password (Read-Host -AsSecureString 'Local password')
```

Sign in at the local app URL. Accounts and incidents survive stack restarts.
Map tiles require internet access and are attributed to OpenStreetMap.
Use **Refresh incidents** to see other dispatchers' new records; there is no
live subscription, incident metadata editing, assignment, or closure workflow.
Vitals use polling while an incident is open. Vital entry is online-only:
explicitly save and wait for confirmation; use the same pending retry after a
failed/uncertain save. Unsaved vital input does not survive closing the tab.

Stop this stack without deleting data:

```powershell
docker compose down
```

For faster UI iteration, use Node 26 (or >=24.12) and .NET SDK 10:

```powershell
dotnet run --project backend\PatrollerAudit.Api
# In a second terminal:
Set-Location frontend
npm ci
npm run dev
```

Vite proxies API requests to port 8080. Without cloud/emulator configuration,
development `/health` returns 200 and `/api/health` returns 503; there is no
in-memory storage fallback. Sign-in requires configured Firebase, so use the
local Compose stack for end-to-end work. The Docker image packages the SPA into
the API container and supplies public Firebase settings through `/api/config`.

## Checks

```powershell
dotnet restore backend\PatrollerAudit.slnx --locked-mode
dotnet format backend\PatrollerAudit.slnx --verify-no-changes --no-restore
dotnet test backend\PatrollerAudit.slnx -c Release --no-restore
$scriptTests = (Get-ChildItem scripts\tests\*.test.mjs).FullName
node --test $scriptTests
Set-Location frontend
npm ci
npm run lint
npm run build
npm test
# Against an already-running isolated local stack (set its actual ports):
$env:BASE_URL = 'http://127.0.0.1:18080'
$env:AUTH_EMULATOR_URL = 'http://127.0.0.1:19099'
npx playwright install chromium
npm run test:e2e
```

The Verify workflow runs these checks, compiles Bicep, and boots the packaged app
against the real local emulators. Browser acceptance
creates fictional identities through Firebase and incidents through the
authenticated API, checks persistence and retry identity, then removes only
its own test identities. Fictional incident records remain in the local database.
Dependency lockfiles are committed inputs.

Use Node 24.x (at least 24.12) for Playwright browser installation and acceptance.
The pinned Playwright 1.56 installer hangs on Node 26; frontend builds and unit
tests still use Node 26 in CI.

## Agent skills

Repository skills cover [Azure investigation](.github/skills/azure-observability-investigator/SKILL.md),
[local development and deployment](.github/skills/deployment-dev-loop/SKILL.md),
[isolated worktrees](.github/skills/git-worktree-workflow/SKILL.md),
[pre-commit review](.github/skills/pre-commit-review/SKILL.md), and
[user-story development](.github/skills/user-story-development/SKILL.md).
They describe the current foundation and do not authorize feature implementation
or publication.

Run all deterministic instruction-coverage evaluations:

```powershell
Get-ChildItem .github\skills\*\evals\run.mjs | ForEach-Object { node $_.FullName }
node --test scripts\tests\skill-evals.test.mjs
```

Each runner accepts `--case=<id>`. Default checks verify instruction coverage,
not model behavior or application correctness, and run in Verify's existing
script test suite. Opt-in `--live` evaluations require explicit AI-credit
authorization and an authenticated Copilot CLI; they assess tool-disabled plans,
not actual service access. A behavioral failure may retry once, using up to two
CLI calls per selected case. No model is pinned.

## Delivery and configuration

See [operations](docs/OPERATIONS.md) for Azure OIDC/GitHub environment setup,
infrastructure previews, immutable image publication, promotion, and rollback.
Cloud provisioning is manual. Once explicitly enabled, successful main CI builds
and deploys test automatically; protected version tags promote the same image to
staging and production. Configure GitHub environment protections and OIDC before
setting `ENABLE_TEST_DEPLOYMENT=true`. Checkout alone never provisions resources.

`infrastructure\main.bicep` defines the registry, telemetry, and isolated ring
foundations. `infrastructure\app.bicep` deploys an immutable image with managed
identity and startup/liveness/readiness probes. The initial cloud ring is test;
later approved rings are exactly **test -> staging -> production**.

This scaffold is not an operational patrol system and must not be used to
record real incidents or sensitive information.
