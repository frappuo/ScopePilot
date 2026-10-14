# ScopePilot --- Product and Architecture Handoff

**Purpose:** Context handoff covering the product, architecture, implementation, design decisions, evaluation, known limitations, and next steps. This is a status summary that may lag behind later changes; the repository is the source of truth for exact current code behavior.

-   **Official title:** ScopePilot: An AI-Assisted Microscopy Observation System Using Vision Language Models
-   **Course:** BCSE497J Project-I
-   **Repository:** https://github.com/frappuo/ScopePilot
-   **Public backend:** https://scopepilot.onrender.com (per handoff; the repository contains no Render configuration)
-   **Domain:** Educational microscopy only; not a diagnostic system.

## 1. Product summary

ScopePilot augments a conventional microscope with a smartphone app and a backend-connected Vision-Language Model (VLM). A student uploads a microscope image; the FastAPI backend validates it and calls Gemini, and returns a structured educational analysis (probable specimen, visible structures, observations, explanation, limitations) that also drives follow-up questions and a quiz. The goal is to help students interpret what they see without an expensive digital microscope or local ML hardware.

The AI is assistive and tentative; the student remains responsible for verifying the output through direct observation and trusted materials. ScopePilot does not diagnose disease or replace expert judgment.

**Longer-term ideas (not planned for the current prototype, not implemented):** image comparison, a custom microscopy VLM, Soup-based fine-tuning, classifier/reliability models, uncertainty calibration, and real-time microscope video.

## 2. Current status

### Implemented

-   React Native/Expo app (gallery selection only; no camera capture): analysis, follow-up Q&A (`/ask`), quiz (`/quiz`: exactly three questions, four options each).
-   FastAPI backend with Gemini; upload validation and re-encoding (section 5); structured, Pydantic-validated responses; the app shows the backend's `detail` for 400/413/415 only.
-   Optional Gemini model fallback on quota or model-not-found (`GEMINI_FALLBACK_MODELS`); evals are pinned to the primary model.
-   Request limits (body size, `/ask`/`/quiz` input caps, global daily Gemini cap) and an optional shared app token (`APP_TOKEN`; a deterrent, not authentication).
-   Student logbook backend under `/v1` (Supabase token verification, experiment create/read/list/edit/save/delete, experiment-scoped follow-up questions and quiz, daily usage in `GET /v1/me`, account deletion with `DELETE /v1/me`; section 5). No login or logbook screens in the app yet.
-   Braintrust prompt-evaluation harness with four variants and deterministic scorers.

### Verified on a physical device (user-reported)

-   2026-10-03: analysis, Q&A, quiz, Live Photos, and PNG uploads verified on a physical iPhone against the deployed Render backend.
-   Render deployment at `https://scopepilot.onrender.com`: per handoff and user report; not verifiable from the repository.

### Incomplete or not verified

-   Production RAG integration over a trusted biology knowledge base.
-   Camera capture in the app.
-   Larger, expert-reviewed microscopy benchmark.
-   Semantic specimen matching.
-   Structure precision/F1 and validated hallucination scoring.
-   Repeated-run robustness/statistical evaluation.
-   Complete token/cost tracing.
-   Dedicated prompt-injection filtering and adversarial testing.
-   Explicit microscopy-vs-non-microscopy content gate.
-   Clinical or diagnostic functionality (out of scope).

Do not describe planned features as implemented.

### Planned / not implemented

None of the following exists in the code. Remaining logbook PRs, in order:

-   PR 7: legacy switch.
-   Then the frontend login and experiments screens (no login in the app today).
-   Later assistant features: cross-experiment context, learning tracking.
-   RAG over trusted biology material.

Also not implemented: per-user rate limiting on the legacy `/analyze`, `/ask` and `/quiz`. They have only a global, per-process daily Gemini cap (`GEMINI_DAILY_CALL_LIMIT`) and the mapping of a Gemini 429 to a 503. The per-user daily quota covers `POST /v1/experiments` and `POST /v1/experiments/{id}/ask` and `/quiz`.

### Known issues / follow-up tasks

-   CORS is intentionally off, so the browser preview cannot call the backend.
-   No authentication or per-user rate limiting on the legacy API (body limits, input caps, a global daily cap, and an optional shared app token exist).
-   The legacy `/ask` and `/quiz` trust the client-supplied analysis until PR 7 (legacy switch). The `/v1/experiments/{id}/ask` and `/quiz` routes read the stored analysis instead.
-   Reconcile eval variant names (section 8).
-   Gemini's handling of 16-bit grayscale PNG is untested.
-   The code default `GEMINI_MODEL` (`gemini-2.5-flash`) differs from `backend/.env.example` (`gemini-3.1-flash-lite`) and was recorded as unavailable to new users (`progress.md`).
-   `backend/.env.example` does not list `MAX_ENCODED_IMAGE_BYTES`.
-   A "server busy" 503 shows the app's generic 503 message, not the backend detail.
-   Real-device behavior of the decode lock and memory use on Render have not been measured.

## 3. Architecture

Microscope → phone image picker → Expo app → multipart upload → FastAPI (validation, re-encode) → Gemini → Pydantic-validated `Analysis` → app (analysis, follow-up Q&A, quiz) → the student verifies the output.

Planned RAG: trusted material → chunks → embeddings → vector retrieval → grounded explanation. RAG can ground biological explanations in sources; it cannot prove that a structure is actually visible in the submitted image. Visual interpretation, factual grounding, and human verification are distinct responsibilities.

-   **Frontend:** UI, image selection, API requests, loading/error/success states. Never calls Gemini.
-   **Backend:** API boundary, upload validation, prompts, model orchestration, response validation, error handling, provider credentials.
-   **Gemini:** pretrained, replaceable multimodal inference; not assumed accurate or calibrated.
-   **Braintrust:** experiment tracking and evaluation, not the inference model or product database.

## 4. Design rationale

-   **VLM rather than a classifier:** ScopePilot needs specimen, structures, observations, explanation, limitations, Q&A and quizzes, not a label. A VLM fits this workflow but is not automatically more reliable than specialist CV models.
-   **No custom training:** a microscopy foundation model would need substantial expert-labelled data and compute. The project does not claim a novel architecture; specialist models (e.g. segmentation) could come later.
-   **Gemini behind the backend:** keeps the API key out of the app, centralizes prompts and validation, and keeps the client provider-independent.

## 5. Backend

Layout: `routes/` = HTTP only, `schemas/` = Pydantic, `services/` = Gemini and business logic (`gemini.py`, `images.py`, `logbook.py`, `auth.py`), `config.py` = env, `middleware.py` = app token, bearer auth, body limits and log-path templates.

### Endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `/health` | GET | Health check. |
| `/analyze` | POST | Validate an image, call Gemini, return structured analysis. |
| `/ask` | POST | Answer a follow-up using the analysis context. |
| `/quiz` | POST | Generate quiz questions from the analysis context. |
| `/v1/me` | GET | The signed-in user (Supabase token) and today's per-user Gemini usage (`usage`, or null if it could not be read). |
| `/v1/me` | DELETE | Permanently delete the signed-in account and all its logbook data (body `{"confirm": "DELETE MY ACCOUNT"}`). |
| `/v1/experiments` | POST, GET | Create a draft from an image; list own saved experiments and live drafts. |
| `/v1/experiments/{id}` | GET, PATCH, DELETE | Read; edit title/notes and save a draft; delete. |
| `/v1/experiments/{id}/ask` | POST | Answer a follow-up question from the experiment's stored analysis. |
| `/v1/experiments/{id}/quiz` | POST | Generate a quiz from the experiment's stored analysis (no body). |

The `/v1` routes are the student logbook ("Student logbook" below); they need a Supabase access token.

### `/analyze` flow

`prepare_image` validates and re-encodes the upload, `analyze_image` calls Gemini (with fallback), the response is validated against `Analysis`, and failures become `{"detail": ...}` errors. The eval harness reuses both functions: `app.services.images.prepare_image(data, content_type, settings) -> tuple[bytes, str]` and `app.services.gemini.analyze_image(data, mime_type, settings) -> Analysis`. Eval runs from commit `d2ea65f` onward send re-encoded, metadata-free bytes, so they are not directly comparable with earlier runs.

### Request limits, app token, CORS

Details in README.md. Not covered there:

-   The daily Gemini cap (`GEMINI_DAILY_CALL_LIMIT`, default 100, counted just before each `generate_content` call, so fallbacks count) lives in process memory: it resets on restart and each worker process counts separately. Google's own quota reset time may differ from UTC midnight. Covered by mocked tests (`test_limits.py`); not verified on Render.
-   `APP_TOKEN` (`AppTokenMiddleware`, outermost, `hmac.compare_digest`) is compiled into the app bundle via `EXPO_PUBLIC_APP_TOKEN`: a deterrent, **not authentication**. Rollout: ship the app, then set `APP_TOKEN` on Render, then confirm old builds get the 401 "update the app" message. Rejections log path and reason only. Not verified on Render or in a device build.
-   CORS is intentionally off: the native app does not need it, and CORS is not an abuse control.

### Model fallback (`GEMINI_FALLBACK_MODELS`)

-   Up to 3 models, tried in order after `GEMINI_MODEL` with the same key, by the shared `_generate` helper in `services/gemini.py`. More than 3 fails startup.
-   Moves on only for 429/`RESOURCE_EXHAUSTED` or 404/`NOT_FOUND`; every other error, and any bad response, fails immediately. If all fail: 503 if any hit quota, otherwise 502.
-   Logs model names only (`Gemini served …`, `Gemini fallback … reason=quota|model_not_found`). Evals never fall back (section 8).
-   Only list models verified for image input and structured JSON output; Google can retire models at any time.
-   Covered by mocked tests (`test_fallback.py`); not verified against real Gemini 429/404 responses.

### Analysis contract, `/ask` and `/quiz`

`Analysis` has `probable_specimen` (tentative), `visible_structures`, `observations`, `explanation` and `limitations`. A valid schema guarantees shape, not biological truth. `/ask` and `/quiz` use the analysis as context; both depend on model output and are not infallible.

### Upload pipeline (`prepare_image`, `services/images.py`)

Steps are in README.md. iPhone camera JPEGs are detected by Pillow as `MPO` with two frames; before commit `d2ea65f` (2026-10-03) they got 415. MPO is now accepted as JPEG, first frame only. Limitations: 16-bit-per-channel RGB PNGs are reduced to 8 bits (only 16-bit grayscale round-trips); Gemini's handling of 16-bit PNG is untested; peak memory for a 20 MP image was roughly +170–340 MiB on Windows and has not been measured on Render.

### Student logbook (PR 3 merged 2026-10-11 as #11, live-verified; PR 4 merged 2026-10-12 as #14 and PR 5 merged 2026-10-12 as #16, both live-verified locally; PR 6 account deletion live-verified locally 2026-10-14)

Slice 1: Supabase Auth login, saving an analysis as an experiment, list/open/rename/delete, and follow-up questions and quizzes on a stored experiment. Only the backend part is done; the app's login and logbook screens are planned, not implemented. The backend verifies Supabase access tokens on every `/v1/*` route. It can create, read, list, edit, save and delete experiments (PR 3, PR 4), answer questions and build quizzes from an experiment's stored analysis (PR 5), and delete the whole account (PR 6). The app's login and experiment screens do not exist yet.

-   `POST /v1/experiments` (multipart `image`): validates and cleans the upload with `prepare_image`, analyzes it with Gemini, and stores it as a draft that expires after `DRAFT_TTL_HOURS`. Stored with it: a metadata-free JPEG display copy (long edge at most 2048 px), a 256 px thumbnail, the model that answered and a hash of the production prompt (`PROMPT_VERSION`). Returns 201 with the experiment and short-lived signed image URLs.
    -   Order: draft cap (409), `prepare_image`, display copies, the per-user daily quota (`consume_gemini_call`, 429 with `Retry-After`), Gemini, the stored-analysis cap, uploads, insert. A rejected image or a failed display copy costs no quota. An analysis over the `StoredAnalysis` caps gives 502 "Gemini returned an invalid or empty analysis" and stores nothing; the quota unit stays spent.
    -   On failure: if Gemini fails, nothing is stored. If an upload fails, the uploaded images are deleted. If the insert fails, the row is deleted first (the insert may have committed before its response was lost) and the images only if that succeeded; otherwise they are kept so a surviving row keeps its images. The insert goes through `create_draft` (draft cap under a per-user lock, nothing written after a deadline 8 s out), and the row cleanup waits until 2 s past that deadline and then calls `discard_draft`.
-   `GET /v1/experiments` (own saved experiments and live drafts, newest first, cursor paging, thumbnail URLs only), `PATCH /v1/experiments/{id}` (title/notes, save a draft; saved cap 409), `DELETE /v1/experiments/{id}` (row first, then images), and a best-effort purge of drafts expired for over 5 minutes after each create and list.
-   `GET /v1/experiments/{id}`: returns the caller's own experiment with freshly signed image URLs. Another user's ID, a non-UUID or an expired draft gives the same 404 as a missing ID.
-   `POST /v1/experiments/{id}/ask` (body `{"question": "..."}`, 1-500 characters after trimming; any other field gives 422) and `POST /v1/experiments/{id}/quiz` (no body; a body is ignored). Both work on the caller's own drafts and saved experiments and store nothing. The analysis comes from the stored row, never from the request.
    -   Order: non-UUID id → 404 before any request; read the row (another user's ID, a missing ID or an expired draft → 404; a foreign row or storage path → 503); parse the stored analysis (failure → 503); the `StoredAnalysis` caps (over → 422 "This experiment's analysis is too long for follow-up questions."); the per-user quota (429); Gemini (the same prompts as the legacy routes). Nothing before the quota step costs a unit. A Gemini failure (502/504) or the server-wide daily cap (503) still costs one.
-   Stored-analysis cap (`StoredAnalysis`, `backend/app/schemas/analysis.py`): the same per-field caps as the legacy `/ask`/`/quiz` input (`AnalysisInput`), plus 32 KiB for the compact UTF-8 JSON in total. Enforced at create (502, nothing stored) and again at ask/quiz (422, no quota), so rows stored before the cap are refused rather than sent.
-   Per-user daily quota: one unit per create, ask or quiz, `USER_DAILY_GEMINI_LIMIT` per UTC day (default 40), counted in `usage_daily` by `consume_gemini_call` on the database clock. When it is used up: 429 "Daily AI request limit reached for your account. Try again after 00:00 UTC." with `Retry-After` in seconds until 00:00 UTC. A non-boolean RPC result fails closed (429).
-   `GET /v1/me` returns `usage` (`used_today`, `daily_limit`, `remaining`, `resets_at` = next 00:00 UTC), read from `usage_daily` with a 3 s timeout (`USAGE_TIMEOUT_SECONDS`). The timeout applies per connect, read and write step, not to the whole request, so a slow or trickling response can still hold `/v1/me` somewhat longer. Any failure or malformed row gives 200 with `usage: null` and a log line with op and status only. The backend clock picks the day while the quota RPC uses the database clock, so the two can disagree for a few seconds around midnight.
-   Logs template experiment paths: `/v1/experiments/{id}`, `/v1/experiments/{id}/ask`, `/v1/experiments/{id}/quiz`. Any other path under the prefix logs as `/v1/experiments/{id}`. This covers app logs and, as a backstop, uvicorn's access log.
-   `DELETE /v1/me` (PR 6) permanently deletes the caller's account.
    -   Body: exactly `{"confirm": "DELETE MY ACCOUNT"}`. A missing body, any other phrase (including another letter case) or an extra field gives 422 before any Supabase request.
    -   Responses: 204 when everything is gone. Otherwise 503 "Account deletion did not finish. Please try again."
    -   Order:
        1.  The user's `experiments` rows. Every returned row is re-checked as the user's own.
        2.  A sweep of the whole storage folder `<user_id>/`, including orphans that no row lists. It uses the Storage list API page by page, checks every listed name before building a path, and is bounded by rounds and time.
        3.  The Supabase Auth user, through the Admin API (hard delete). A 404 with `user_not_found` counts as already gone.
        4.  A final sweep, for images that a create still running may have uploaded meanwhile.
    -   `usage_daily` rows go by the `on delete cascade` with the Auth user. A deletion that fails earlier therefore keeps the day's quota count.
    -   Retries: a failed step stops the rest, and every step is safe to repeat. The access token stays valid until it expires, so a retry finishes a half-deleted account.
    -   App contract: on 503, keep the session and retry `DELETE /v1/me`; sign out only on 204.
    -   Once the Auth user is gone, the foreign keys to `auth.users` reject any new row or quota use.
    -   No migration is needed. The row delete is small and indexed, well inside the 5 s `statement_timeout`, and the Auth delete runs inside Supabase Auth, not as `service_role`.
    -   Logs carry op names and counts only (`op=rows`, `op=objects`, `op=auth result=deleted|absent`, `op=final_sweep`).
-   Isolation lives in `backend/app/services/logbook.py`: every query filters by the verified `user_id`, every storage path must start with `<user_id>/`, and rows returned by Supabase are re-checked. Logs carry operation names and status codes only.
-   Tests use an in-memory fake of Supabase (`backend/tests/fake_supabase.py`, shared by `test_experiments.py` and `test_account_delete.py`). It covers Storage listing, Auth users, the cascade and the foreign-key rejections.
    -   PR 5 (ask, quiz, caps, quota, `/v1/me` usage, log templates) is covered by mocked tests (backend suite 518 passed, 1 skipped, httptools not installed) and was also live-verified locally on 2026-10-12 (below).
    -   PR 6 is covered by mocked tests (backend suite 615 passed, 1 skipped) and was live-verified locally on 2026-10-14 (below).

Verified live (2026-10-11, user-reported, against the real Supabase project):

-   An `sb_secret_` key works with the `apikey` header alone (no `Authorization` header).
-   Storage upload and signed-URL request paths, and the `signedURL` format the code expects (`/object/sign/...`).
-   The quota RPC: `usage_daily` counted 1 after one create.
-   The bucket limits accept the upload.
-   Two-user isolation: user A reading A's experiment gets 200; user B reading A's experiment gets 404.

Verified live (2026-10-12, user-reported; backend run locally against the real Supabase project and real Gemini, two test users A and B):

-   Migration 0002 is applied: `create_draft`, `discard_draft`, `update_experiment` and `consume_gemini_call` exist, and `service_role` has `statement_timeout` = 5 s.
-   PR 4: create goes through `create_draft`. List returns the user's own item with a signed thumbnail and no next page. PATCH saving without a title gives 422 "A title is required to save."; a title plus save sets `saved_at` and clears `expires_at`. DELETE gives 204; then GET 404, a repeat DELETE 404, an empty list, and the images are gone from storage. The repeat DELETE logged no cleanup failure, so deleting storage paths that no longer exist succeeds.
-   PR 5: experiment ask and quiz work (quiz: 3 questions, 4 options each). `/v1/me` usage went 0 -> 3 after create, ask and quiz (remaining 37, `resets_at` the next 00:00 UTC); user B's usage stayed 0.
-   Isolation: user B got 404 "Experiment not found." on read, ask, quiz, PATCH and DELETE of A's experiment, and A's experiment was unchanged.
-   Orphans: 10 image pairs with no rows were found and removed in one user's folder, uploaded 2026-10-11 between 20:31 and 20:35 UTC. Most likely cause: creates run before migration 0002 was applied (`create_draft`/`discard_draft` returned 404, so cleanup kept the images by design). This confirms the "apply 0002 first" setup step and the need for a sweeper.
-   Auth settings: sign-ups open, email confirmation on, custom SMTP off. Custom SMTP must be configured before real users sign up.

Verified live (2026-10-14, user-reported; backend run locally against the real Supabase project, with a throwaway user C and a control user A):

-   Setup:
    -   C had 2 experiments (1 saved, 1 draft) and 3 quota units used.
    -   C had 6 storage files, including a loose orphan image directly in C's folder and a nested orphan in a subfolder made in the dashboard.
-   `DELETE /v1/me` with no body gave 422, with the phrase in the wrong case 422, and with the correct phrase 204.
-   Logs: `rows experiments=2`, `objects deleted=6 rounds=2`, `auth result=deleted`, `final_sweep deleted=0`. Counts only, no IDs.
-   A repeat delete gave 204 with `auth result=absent`: Supabase Auth reports `user_not_found`, so retries finish.
-   The Auth Admin API accepts the secret key in the `apikey` header alone.
-   Afterwards, checked by SQL:
    -   C has 0 experiments, 0 usage rows, no Auth user and 0 files.
    -   A's 2 files are untouched.
    -   There are 2 users in total.
-   C's still-valid access token: create gives 503 (log `consume_quota status=409`, no Gemini call), and C can no longer sign in (400).

Still unverified:

-   Latency between Render and Supabase.
-   Memory on Render for the second decode (the display copies) on each create.
-   The logbook on Render: `SUPABASE_URL` and `SUPABASE_SECRET_KEY` are not set there yet.
-   The expired-draft purge and the 409 draft and saved caps were not exercised live.
-   Account deletion from Render, and how long it takes there.

Known trade-offs / deferred:

-   Orphaned storage objects persist until a sweeper exists: a crash between upload and insert, a failed image delete, or an expired-draft purge whose delete was still running when its re-check read. Account deletion (PR 6) removes everything under the user's folder, orphans included, but only when the account itself is deleted.
-   A Gemini failure, or hitting the server-wide daily cap, still costs one unit of the user's daily quota (create, ask and quiz).
-   The unit is also spent when the Gemini API key is not configured: the 503 comes after the charge, as in create. This is an operator setup error, not something a user can trigger.
-   The per-user quota (default 40) is larger than the share of the server-wide `GEMINI_DAILY_CALL_LIMIT` (default 100, per process) that a few heavy users need to exhaust it for everyone. Revisit both limits before opening sign-ups.
-   The draft and saved caps rely on PostgREST's default READ COMMITTED isolation (each count runs after the per-user advisory lock). Under REPEATABLE READ or stricter, the snapshot predates the lock and a concurrent create could be missed. Keep the default, or switch to per-user counter rows locked with SELECT ... FOR UPDATE.
-   Migration 0002 sets a 5 s `statement_timeout` on `service_role`, which covers every backend statement. Account deletion (PR 6) does not need a longer one: its row delete is small and indexed, and the Auth delete runs inside Supabase Auth, not as `service_role`. A future backfill must set a longer timeout for its own transaction.
-   After account deletion, an access token stays valid until it expires, because the backend verifies it locally. With it, the list is empty, reads give 404, create gives 503 at the quota step, and `GET /v1/me` gives 200 with usage 0. No data can come back: the foreign keys to `auth.users` reject new rows and quota use.
-   A create waiting on Gemini while an account is deleted can upload its images afterwards. Its insert then fails, and its cleanup normally removes the images. If that cleanup fails, the images are orphans for the planned sweeper; the app has already signed out, so nothing retries.
-   Any valid access token can delete the account; the confirmation phrase only prevents accidents. A recent-sign-in requirement is deferred until the app has a re-auth flow.
-   "Permanent" deletion means live data. Supabase backups, Supabase API logs and Render request logs keep traces until they age out.
-   `DELETE /v1/me` has no `Retry-After` on its 503 and no per-user rate limit.
-   No per-user rate limit on `/v1` list, PATCH and DELETE, and every list (and create) also starts an expired-draft purge (2-4 Supabase calls). Add per-user limits, and run the purge at most once per user per few minutes.
-   On an insert failure, cleanup waits until 2 s past the create deadline (up to about 10 s) before `discard_draft`, and holds a threadpool worker meanwhile. The client already gets a 503; the worker cost matters only if insert failures become frequent.
-   Clock skew: the create deadline tolerates the database clock lagging Render's by about 2 s (minus the discard call's latency). Beyond that, a queued create can still insert after its images were deleted (a draft without images until the purge). Future hardening: a tombstone written by `discard_draft` and checked by `create_draft`, which removes the clock dependence. The purge margin assumes the clocks agree within 5 minutes.
-   `discard_draft` returns false both when no row exists and when the row is no longer a draft, and cleanup treats both as success. A draft saved from another session during the cleanup wait would lose its images. Future fix: a three-way result (deleted / absent / kept), deleting images only for deleted or absent.
-   `discard_draft` waits up to 6 s for the per-user lock, longer than the 5 s statement timeout, so a create still running finishes or rolls back first. If the discard still fails (transport error), the images are kept; if the create had rolled back, they are orphaned.
-   GET treats an expired draft as missing (404) while DELETE still deletes it (204). This is intended. GET decides expiry on the backend clock; the database functions use the database's clock.
-   Logs: Render's start command lives in the dashboard (not the repo) and must include `--no-access-log --ws none`. `--ws none` matters because WebSocket handshakes log the path and query on `uvicorn.error`, which the access-log flag does not cover. `app/main.py` also templates IDs and drops query strings in uvicorn's access log as a backstop. Never run with `--log-level trace` in production: it logs whole requests, including the Authorization header. Render's own HTTP request logs, and Supabase's API logs (which see `user_id=eq.<uid>` and experiment IDs in query strings), may still record them.

Schema and settings:

-   `supabase/migrations/0001_logbook.sql` creates `experiments`, `usage_daily`, the `consume_gemini_call` function and a private `experiment-images` bucket. Row-level security is on, with no policies, so the app's publishable key cannot touch them. Only the backend (secret key) can.
-   `supabase/migrations/0002_logbook_caps.sql` (PR 4) adds `create_draft`, `discard_draft` and `update_experiment` (draft and saved caps under a per-user lock) and a 5 s `statement_timeout` on `service_role`. PR 5 and PR 6 need no migration.
-   Settings: `SUPABASE_URL` (https origin), `SUPABASE_SECRET_KEY` (backend host only, never the app or the repo), `LOGBOOK_BUCKET`, `USER_DAILY_GEMINI_LIMIT` (default 40, shared by create, ask and quiz), `MAX_SAVED_EXPERIMENTS_PER_USER`, `MAX_DRAFTS_PER_USER`, `DRAFT_TTL_HOURS`. The logbook counts as configured only when both the URL and the secret key are set.

Setup (manual; steps 1-2 done on the real project, step 3 partly done (SMTP still off), step 4 done locally but not on Render):

1.  Create a free Supabase project and choose the region deliberately.
2.  Run the migrations in the dashboard SQL editor: `0001_logbook.sql`, then `0002_logbook_caps.sql`. **Apply 0002 BEFORE setting `SUPABASE_URL`/`SUPABASE_SECRET_KEY` on Render**: without it, `create_draft` and `discard_draft` return 404 and every create leaves orphaned images.
3.  Auth: enable email confirmation, configure a custom SMTP provider (the built-in sender allows about 2 emails/hour), and use OTP codes in the confirmation/recovery email templates.
4.  Create a dedicated secret key for the backend and set the variables above on Render.

Free-tier caveats (from Supabase docs, 2026-10-07): projects pause after 7 days of inactivity, there are no backups, and storage is 1 GB.

## 6. Frontend and deployment

The app uploads the original picked file as multipart without converting or resizing it (`frontend/src/services/images.ts`; HEIC is rejected in the app). Error-message mapping is in README.md and `frontend/src/services/api.ts`. Last physical-iPhone check: 2026-10-03 against `https://scopepilot.onrender.com`.

Lesson from an earlier config problem: a stale PowerShell `$env:EXPO_PUBLIC_API_URL` (`http://192.168.137.1:8000`) overrode `frontend/.env`. On a physical phone `localhost` is the phone; local testing needs a LAN address or tunnel, which the deployed HTTPS URL avoids.

## 7. Prompting, guardrails, and security

The production analysis, Q&A and quiz prompts live in `backend/app/services/gemini.py`, each passed as Gemini's `system_instruction`. They aim to keep output educational and microscopy-focused, identify a *probable* specimen, separate visual observations from explanation, avoid claiming structures only because they are normally expected, and state limitations.

-   **Prompt injection:** backend mediation, instructions and schema validation give some control, but no dedicated filter exists. Prompts cannot guarantee resistance to direct or indirect (text-in-image) injection; do not claim it is handled. Keep secrets out of model context and give the model no privileged tools.
-   **Wrong images:** an invalid file is rejected deterministically; a valid but irrelevant image (e.g. a selfie) reaches the VLM, and no content-domain gate exists; a poor microscopy image should produce limitations, but this is not guaranteed.
-   **Other failures:** provider errors (e.g. Gemini 503) are availability, not quality; malformed output fails schema validation; network failures must show an error, not crash.

## 8. Braintrust evaluation

Purpose: answer "wrapper" feedback with a measurable component, controlled prompt experiments through the same service path on a fixed image set.

-   Project `ScopePilot`; harness `backend/evals/microscopy_eval.py`; images `backend/evals/images/`; images go through `prepare_image` as in production.
-   The model is the configured `GEMINI_MODEL` (recorded runs: `gemini-3.1-flash-lite`, per handoff; not verifiable from the repository). `analyze_case` clears `GEMINI_FALLBACK_MODELS` and calls `analyze_image(..., allow_fallback=False)`, so a run never switches model. Experiment name `"<variant> | <model>"`; metadata records `gemini_model`, `prompt_variant`, `fallback: "disabled"`.
-   `SCOPEPILOT_EVAL_PROMPT_VARIANT` selects the variant. The harness swaps the service prompt under a lock and restores it in `finally`; the production prompt is never modified.
-   Code variant names (`prompt-a-naive-baseline`, `prompt-b-scopepilot-production`, `prompt-c-overconstrained`, `prompt-d-synthesized`) differ from the recorded results' names (`prompt-a-baseline`, `prompt-b-visibility-constrained`, `prompt-c-educational-conservative`); the mapping is unreconciled. In the code, `prompt-a-naive-baseline` sends the unchanged production prompt and the other three append extra instructions.

**Dataset:** five cases (`blood_smear_1`, `yeast_1`, `onion_epidermis_1`, `cheek_1`, `plant_tissue_1`) with manual labels (specimen; structures; kingdom). Only the onion image was visually inspected; the labels are not expert-validated ground truth.

**Scorers:**

1.  `specimen_accuracy_lexical`: normalized containment 0/1. Lexical consistency, **not** biological accuracy; synonyms can be false negatives.
2.  `structure_recall`: matched / expected structures; does not penalize extra unsupported structures.
3.  `schema_validity`: exactly the five fields; structure, not factual correctness.
4.  `limitation_awareness`: 1 if any non-empty limitation; does not judge its accuracy.
5.  Duration is performance, not accuracy.

An `LLMClassifier` semantic scorer (`specimen_accuracy_semantic`) is defined but not in `scores`: its `gpt-4o` provider was not configured in Braintrust. Do not report semantic results.

**Variants:** A, baseline: the mature production prompt. B, visibility-constrained: report only clearly visible structures. C, educational-conservative: probable ID from visible evidence, observations separated from explanation. D, synthesized: keep useful caution without over-restricting structures.

**Recorded results** (as recorded in this handoff; old variant names; predate upload re-encoding; not verifiable from the repository):

| Variant | Limitation awareness | Schema validity | Lexical specimen | Structure recall | Duration |
|---|---|---|---|---|---|
| A --- baseline | 100% | 100% | 40% | 100% | 15.29 s |
| B --- visibility-constrained | 100% | 100% | 20% | 80% | 15.51 s |
| C --- educational-conservative | 100% | 100% | 20% | 80% | 14.88 s |
| D --- synthesized | 100% | 100% | 40% | 100% | 17.06 s |

A's first run hit a transient Gemini 503; the figures are from the completed rerun. Durations are noisy and provider-dependent.

**Interpretation:** in this five-case pilot the more conservative B/C prompts coincided with recall falling to 80%, and D restored it to 100%. Prompt wording affects measured behavior; this does **not** prove D is universally superior or that hallucinations are eliminated. Per-image qualitative review is needed alongside aggregate scores.

Defensible explanation: "I compared four prompt variants on the same five cases with the same model, service path and deterministic scorers. The more restrictive variants lowered structure recall from 100% to 80%; a synthesized prompt kept the caution and restored recall in this pilot. This is a small pilot, not proof of general superiority, and the lexical metric has known limitations."

## 9. Evaluation limitations and improvement backlog

1.  Lexical matching marks equivalent names wrong; add synonym/ontology normalization or a validated semantic evaluator.
2.  The semantic judge is disabled; configure and validate it before reporting such scores.
3.  Expand the five-image pilot across specimens, magnifications, staining, focus and quality.
4.  Get faculty/biology-expert validation of labels.
5.  Recall ignores extra structures; add expert negative labels and precision/F1 where justified.
6.  Hallucination scoring is incomplete; unannotated does not mean false.
7.  Run repeated trials to quantify variability.
8.  Separate provider failures (503/quota) from quality; consider eval-only retries for transient 503s.
9.  Braintrust token/cost fields showed zero; that is not true zero usage. Add valid provider tracing.
10. Evaluate RAG against VLM-only output once implemented.
11. Add a human rubric for clarity, correctness, usefulness and appropriateness.
12. Measure latency/cost with reliable telemetry.

## 10. Technical contribution and "wrapper" criticism

> ScopePilot is an evaluation-driven multimodal educational system. Its engineering contribution is integrating a pretrained VLM into a mobile-to-backend workflow, validating inputs and structured outputs, supporting context-aware learning interactions, and experimentally studying prompt-induced reliability trade-offs. It does not claim a novel neural architecture or clinical-grade microscopy accuracy.

Without Gemini the product loses its inference engine, but the mobile workflow, API boundary, validation, structured contract, learning interactions, and evaluation harness remain. Avoid claiming: a novel neural architecture, hallucination-free output, guaranteed identification, prompt-injection immunity, that RAG verifies visual evidence, that lexical matching is biological accuracy, that schema validity or 100% recall means correctness, or that five images show general performance.

## 11. Useful commands

From `backend/` with the venv active (Render needs `--no-access-log --ws none` too):

``` powershell
uvicorn app.main:app --reload --no-access-log --ws none
```

Local API `http://127.0.0.1:8000`, Swagger `/docs`. Tests from the repository root:

``` powershell
Push-Location backend; .\.venv\Scripts\python.exe -m pytest -q --basetemp="$env:USERPROFILE\pytest-tmp"; Pop-Location
Push-Location frontend; npm.cmd run typecheck; npm.cmd test; Pop-Location
```

Eval from `backend/`:

``` powershell
$env:SCOPEPILOT_EVAL_PROMPT_VARIANT="prompt-a-naive-baseline"
.\.venv\Scripts\braintrust.exe eval evals/microscopy_eval.py
```

Eval dependencies: `braintrust==0.37.0`, `autoevals==0.1.0`, `openai==1.109.1`; `backend/requirements-dev.txt` includes `braintrust[cli]==0.37.0` and `autoevals==0.1.0`.

## 12. Recommended product next steps

1.  Work through "Known issues / follow-up tasks" in section 2.
2.  Add or verify explicit handling for valid but non-microscopy images.
3.  Harden and adversarially test `/ask` scope and direct/indirect prompt injection.
4.  Reconcile eval variant names, review A/B/C/D outputs per image, and re-run the eval to set a baseline with re-encoded images.
5.  Expand and expert-validate the dataset.
6.  Improve semantic matching and hallucination evaluation only where ground truth supports it.
7.  Implement and separately evaluate RAG.
8.  Evaluate educational usability with students/instructors.
9.  Keep experimental prompt changes isolated from the production prompt.
