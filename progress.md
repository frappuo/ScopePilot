# ScopePilot Development Progress

Dated log, newest first. Current status, planned features, and known issues
live in `docs/HANDOFF.md`.

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
  were merged into `docs/HANDOFF.md` and removed; `agents.md` now points to
  `CLAUDE.md`.

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
