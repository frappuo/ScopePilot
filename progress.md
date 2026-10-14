# ScopePilot Development Progress

Dated log, newest first. Current status, planned features, and known issues
live in `docs/HANDOFF.md`.

## Logbook PR 6 account deletion (2026-10-14)

- `DELETE /v1/me` with the body `{"confirm": "DELETE MY ACCOUNT"}` gives 204,
  or 503 "Account deletion did not finish. Please try again." Any other body
  gives 422 with no Supabase request.
- Order: experiment rows, then a sweep of the user's whole storage folder
  (orphans included), then the Supabase Auth user, then a final sweep.
  `usage_daily` goes by the cascade with the Auth user, so a failed deletion
  keeps the day's quota.
- Every step is safe to repeat. The app keeps its session on 503 and retries;
  it signs out only on 204. No migration.
- The Supabase test fake moved to `backend/tests/fake_supabase.py`. Backend
  suite: 615 passed, 1 skipped, all mocked.
- Live check (user-reported; backend run locally against the real Supabase
  project, throwaway user C, control user A):
  - C had 2 experiments, 3 quota units and 6 files, including loose and
    nested orphans.
  - No body 422, wrong-case phrase 422, correct phrase 204.
  - Logs: `rows experiments=2`, `objects deleted=6 rounds=2`,
    `auth result=deleted`, `final_sweep deleted=0`; counts only.
  - A repeat delete gave 204 with `auth result=absent` (`user_not_found`).
  - The Auth Admin API accepts the secret key in `apikey` alone.
  - By SQL afterwards: C has no experiments, usage rows, Auth user or files;
    A's 2 files are untouched; 2 users in total.
  - C's old token: create gives 503 (`consume_quota status=409`, no Gemini
    call); C can no longer sign in (400).
- Not verified: deletion from Render and its timing.
- Next: PR 7 (legacy switch), then the app's login and logbook screens.
  Configure custom SMTP before real users sign up.

## Logbook PR 4-5 live check (2026-10-12)

User-reported; backend run locally against the real Supabase project and real
Gemini, two test users.

- Migration 0002 is applied (`create_draft`, `discard_draft`,
  `update_experiment`, `consume_gemini_call`; 5 s `statement_timeout` on
  `service_role`).
- PR 4: create via `create_draft`; list with a signed thumbnail; PATCH save
  without a title gives 422, with a title sets `saved_at` and clears
  `expires_at`; DELETE 204, then GET/DELETE 404 and the images are gone.
  Deleting storage paths that no longer exist succeeds.
- PR 5: experiment ask and quiz work; `/v1/me` usage went 0 -> 3 after create,
  ask and quiz (remaining 37); the other user's usage stayed 0.
- Isolation: the other user got 404 on read, ask, quiz, PATCH and DELETE, and
  the experiment was unchanged.
- 10 orphaned image pairs from 2026-10-11 (most likely creates run before 0002
  was applied) were found and removed; this confirms "apply 0002 first" and
  the need for a sweeper.
- Custom SMTP is off; configure it before real users sign up. The Supabase
  variables are still unset on Render.
- Not exercised live: the expired-draft purge and the 409 draft/saved caps.

## Logbook PR 5 (2026-10-12)

- PR 3 (create/read, #11) and PR 4 (list, edit/save, delete, migration 0002,
  #14) are merged.
- PR 5: `POST /v1/experiments/{id}/ask` and
  `/quiz` answer from the experiment's stored analysis, never a client-supplied
  one, and store nothing. 404 for another user's, a missing or an expired
  experiment; 422 for a stored analysis over the caps; none of these costs
  quota.
- Stored analyses are capped (`StoredAnalysis`: the `/ask` input caps plus
  32 KiB in total) at create (502) and at ask/quiz (422).
- One per-user daily quota (`USER_DAILY_GEMINI_LIMIT`, default now 40) covers
  create, ask and quiz; 429 "Daily AI request limit reached for your account."
- `GET /v1/me` reports `usage` (used, limit, remaining, next UTC midnight),
  read with a 3 s timeout; `usage` is null if the read fails.
- Logs template `/v1/experiments/{id}/ask` and `/quiz`; IDs never appear.
- Local tooling configuration files are no longer tracked (kept locally,
  excluded through `.git/info/exclude`).
- Backend suite: 518 passed, 1 skipped (httptools not installed), all mocked.
  Not verified live: ask/quiz and the `usage_daily` read against real Supabase
  and Gemini.
- Legacy `/analyze`, `/ask` and `/quiz` are unchanged: global limits only, and
  `/ask`/`/quiz` still trust the client's analysis until PR 7.

### Next steps

1. PR 6: account deletion (rows, `usage_daily` and everything under the user's
   storage folder; its own longer statement timeout).
2. PR 7: legacy switch.
3. Then the app's login and experiments screens.

## Logbook PRs 1-2 Merged (2026-10-08)

- PR 1 (scaffolding: Supabase schema, settings, setup notes) and PR 2
  (Supabase access-token verification, `BearerAuthMiddleware` for `/v1/*`,
  `GET /v1/me`) are merged. Backend suite: 258 passed, all offline (fake JWKS,
  locally generated keys).
- Remaining logbook PRs are planned, not implemented: 3 create/read
  experiments, 4 list/rename/save/delete, 5 experiment-scoped ask/quiz plus
  per-user cap, 6 account deletion, 7 legacy switch, then the frontend login
  and experiments screens.
- Per-IP rate limiting is dropped; per-user limits replace it.
- Logbook data is accessed only through the backend with the Supabase secret
  key, and every query must be scoped by the verified `user_id`. The secret key
  never goes in the app, the repo, logs or docs.
- Supabase and Render are running, but `SUPABASE_URL` and
  `SUPABASE_SECRET_KEY` stay unset on Render until the experiment endpoints
  exist and the isolation tests pass.
- Not yet verified against a real Supabase token: JWKS signing keys, exact
  `iss`, and presence of `is_anonymous`.

### Next steps

1. Create branch `feat/experiments-create-read`.
2. Plan PR 3 (create/read experiments) in plan mode.
3. Isolation tests (one user can never reach another's data), then a live
   smoke test.
4. Set `GEMINI_DAILY_CALL_LIMIT` on Render.

## Upload Fix, Docs Sync and Device Verification (2026-10-03)

- Cause of the iPhone 415: iPhone camera JPEGs are detected by Pillow as format
  MPO with two frames, which the declared-type check rejected. It was not HEIC.
- Fixed by `prepare_image` in `backend/app/services/images.py` (commit
  `d2ea65f`): MPO accepted as JPEG using the first frame; header-only checks
  before full decode; EXIF orientation applied; EXIF/GPS/XMP/text metadata
  stripped; re-encoding as JPEG q95, lossless PNG, or WebP q95; re-encoded
  output capped by `max_encoded_image_bytes` (14 MiB); one-at-a-time decode
  lock with a 5-second wait, then 503; rejection logs record only rule,
  declared type, and detected format; the pixel-limit message states the limit.
- The app appends the backend `detail` for 400/413/415 only; 5xx details are
  never shown (commit `1a6e894`).
- The eval harness now sends `prepare_image` output, so eval results from this
  point are not directly comparable with earlier runs.
- Backend suite: 87 passed. Frontend suite: 40 passed. TypeScript typecheck and
  `expo export` passed.
- User-verified on a physical iPhone against the deployed Render backend:
  analysis, follow-up Q&A, quiz, Live Photos, and PNG uploads. This supersedes
  the "physical-iPhone verification pending" notes in earlier entries; Q&A
  keyboard scrolling was not separately reported.
- Not verified: Gemini's handling of 16-bit PNG; memory use on Render.
- Documentation synced to the code. `architecture.md` and `project_context.md`
  were merged into `docs/HANDOFF.md` and removed.

## Educational Quiz Verification (2026-09-08)

- Added `POST /quiz` using the current structured analysis as tentative context;
  the image is not resent and `/analyze` and `/ask` behavior is unchanged.
- Quiz responses are validated as exactly three questions with four unique
  options each, an exact option match for `correct_answer`, and non-empty text.
- A live local Gemini request returned HTTP 200 with three questions.
- The frontend now displays one question at a time with local answer locking,
  scoring, explanations, next-question progression, and quiz reset while
  preserving the analysis and Q&A result.
- Backend suite: 65 tests passed. Frontend suite: 36 tests passed. TypeScript
  typecheck passed.
- Web export passed. The all-platform export reached bundling but the local
  Hermes compiler executable was denied permission by the environment.

## Q&A Keyboard Focus Scrolling (2026-09-07)

- Replaced focus-time `scrollToEnd` behavior with measured scrolling for the
  follow-up controls. The input container is measured in window coordinates and
  the ScrollView moves only by the amount that overlaps the keyboard, retaining
  a 32 px gap.
- Answer arrival keeps its separate `scrollToEnd` behavior.
- Frontend TypeScript typecheck passed and all 33 existing frontend tests passed.

## Follow-up Q&A Verification (2026-09-07)

- `POST /ask` accepts the current structured analysis and a student question, then
  returns a validated `answer` without resending or reanalyzing the image.
- Gemini Q&A logic remains in the service layer. Its prompt treats the supplied
  analysis as tentative context, distinguishes observations from general biology
  knowledge, acknowledges uncertainty, and prohibits medical diagnosis.
- A live request through the running FastAPI backend returned HTTP 200 with a
  non-empty Gemini answer.
- The frontend includes a multiline follow-up input, local loading and error states,
  duplicate-submit prevention, and latest-answer display while preserving analysis.
- The Q&A prompt now limits answers to the current microscopy analysis and related
  biology. A live unrelated question returned the exact configured out-of-scope
  sentence. A live relevant answer was non-empty and contained no Markdown heading
  or emphasis markers.
- A lightweight frontend sanitizer removes obvious Markdown headings and paired
  emphasis markers and converts Markdown list markers to readable bullet lines.
- The Q&A screen now uses React Native keyboard avoidance and explicit scrolling on
  keyboard open and answer arrival. iOS bundling passed.
- Full backend suite: 54 tests passed. Frontend suite: 33 tests passed. TypeScript
  typecheck and the iOS, Android, and web exports passed. Existing `/analyze` and
  image-upload tests remain passing.

## Frontend Parcel Verification (2026-09-06)

- Expo SDK 57 TypeScript frontend initialized with a single analysis screen,
  dedicated API service, gallery selection, JPEG preparation (later removed; the
  app now uploads the original file), preview, loading/error
  states, and all five structured result sections.
- `npm run typecheck`: passed.
- `npm test`: 6 API-service tests passed (multipart upload, network failure,
  provider failure, size rejection, malformed fields, and non-JSON response).
- `npm run build`: Android and iOS Hermes bundles plus web export succeeded.
  Native compilation required execution outside the filesystem sandbox.
- Expo dev server ran on port 8081; browser preview rendered and the no-image
  state correctly disabled Analyze. Layout inspected visually.
- Browser preview API requests require backend CORS; backend was unchanged.
- npm installation reported 10 moderate dependency vulnerabilities. No forced
  dependency upgrades were applied. Expo's offline compatibility check reported
  dependencies up to date (offline validation has limited coverage).
- No backend code, backend/.env, camera capture, or later MVP features changed.

## Backend Verification

Latest live verification: the real onion image returned HTTP 200 from /analyze
and passed strict Pydantic validation using a process-only GEMINI_MODEL override
to gemini-3.6-flash. GET /health returned 200. All 46 backend tests passed.

Diagnosed two provider failures: HTTP 400 for additional_properties in the
response_schema payload, then HTTP 404 because gemini-2.5-flash is unavailable
to new users. The outgoing schema now omits that unsupported field while local
validation still rejects extra fields. AFC is explicitly disabled. Provider 404
responses now explain that GEMINI_MODEL needs updating.

The existing user-managed model configuration was not changed. Normal startup
requires a supported GEMINI_MODEL override or a user-managed configuration update.
No .env contents or credentials were inspected or exposed. Earlier verification
notes below record historical results and are superseded by this live check.

Project planning and architecture completed.

Backend environment configuration and the microscopy analysis flow are tested
locally. Live Gemini analysis remains unverified because startup configuration
validation does not currently pass.

## Microscopy Analysis Verification (2026-09-06)

- Dedicated Gemini service uses the existing configured key, model, and timeout;
  the route handles upload orchestration without Gemini-specific logic.
- POST /analyze returns the five-field Pydantic response in mocked SDK tests.
- JPEG, PNG, and WebP uploads tested; empty, corrupt, mismatched, animated,
  oversized, and excessive-pixel images rejected before Gemini calls.
- Exact MAX_IMAGE_BYTES boundary accepted; one byte over rejected.
- Missing response fields, extra fields, incorrect types, and blank list entries
  rejected; empty visible-structure lists accepted for indiscernible images.
- Educational prompt strengthened to put ambiguity and image-quality issues in
  limitations and avoid claiming structures that are not discernible.
- Full backend suite: 45 tests passed, preserving all existing tests. Two upstream
  dependency deprecation warnings remain.
- Real Onion1.jpg read from Git history and uploaded through /analyze with a mocked
  Gemini response: HTTP 200 and response schema validation passed. This verifies
  image handling, not actual specimen identification.
- Live request could not start because configuration validation failed; no real
  Gemini request was sent. backend/.env was not inspected or modified.
- Upload size is checked after multipart parsing; a total HTTP request-body limit
  is not implemented in this prototype.

## Environment Configuration Verification (2026-09-06)

- Environment loading and local dotenv loading/precedence covered by automated tests
  using synthetic inputs; backend/.env was not inspected or modified.
- Startup rejects missing or blank GEMINI_API_KEY with a clear error.
- Configuration error messages omit input values.
- 27 backend tests passed, including configuration tests and existing regression tests.
  Two upstream dependency deprecation warnings remain.
- Normal Uvicorn startup reported missing/blank GEMINI_API_KEY and exited as intended.
- Uvicorn started successfully with a temporary synthetic process environment value;
  GET /health returned HTTP 200 and {"status":"ok"} on port 8001.
- Real credential validity and Gemini connectivity were not tested. User-managed
  configuration still needs a usable GEMINI_API_KEY for normal startup.
- No analysis, frontend, or future-feature implementation was changed in this task.

## Historical Plan (early 2026-09, superseded)

Original planning notes, kept for the record. Frontend/backend integration,
follow-up Q&A, and quiz generation have since been implemented; RAG and camera
capture have not.

### Completed

- Project idea finalized
- System architecture defined
- Gemini selected as primary VLM
- Preliminary Gemini vs Qwen evaluation completed
- Literature review completed
- Project-I documentation started

### Current Sprint

Goal:
Build a 60–70% working ScopePilot prototype within four days.

### Immediate Tasks

- Initialize repository
- Initialize FastAPI backend
- Initialize Expo frontend
- Implement backend health endpoint
- Integrate Gemini image analysis
- Test analysis using microscopy image

### Not Started

- Frontend/backend integration
- Follow-up Q&A
- Quiz generation
- RAG
- Camera capture
- UI polishing

### Deferred

- Soup
- custom VLM training
- custom classifier
- user authentication
- database-backed accounts
- real-time video
