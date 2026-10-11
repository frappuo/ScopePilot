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
-   Student logbook backend under `/v1` (Supabase token verification, experiment create/read/list/edit/save/delete; section 5). No login or logbook screens in the app yet.
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

-   PR 5: experiment-scoped `/ask` and `/quiz` (`experiment_id` instead of a client-supplied analysis), charging the same per-user daily quota that create already uses since PR 3. Today both accept the full analysis supplied by the client (`AskRequest.analysis`, `QuizRequest.analysis` in `backend/app/schemas/`).
-   PR 6: account deletion.
-   PR 7: legacy switch.
-   Then the frontend login and experiments screens (no login in the app today).
-   Later assistant features: cross-experiment context, learning tracking.
-   RAG over trusted biology material.

Also not implemented: per-user rate limiting on `/analyze`, `/ask` and `/quiz`. Today they have only a global, per-process daily Gemini cap (`GEMINI_DAILY_CALL_LIMIT`) and the mapping of a Gemini 429 to a 503. The per-user daily quota applies only to `POST /v1/experiments`.

### Known issues / follow-up tasks

-   CORS is intentionally off, so the browser preview cannot call the backend.
-   No authentication or per-user rate limiting on the legacy API (body limits, input caps, a global daily cap, and an optional shared app token exist).
-   `/ask` and `/quiz` trust the client-supplied analysis.
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

Layout: `routes/` = HTTP only, `schemas/` = Pydantic, `services/` = Gemini and business logic (`gemini.py`, `images.py`, `logbook.py`, `auth.py`), `config.py` = env, `middleware.py` = app token and body limits.

### Endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `/health` | GET | Health check. |
| `/analyze` | POST | Validate an image, call Gemini, return structured analysis. |
| `/ask` | POST | Answer a follow-up using the analysis context. |
| `/quiz` | POST | Generate quiz questions from the analysis context. |
| `/v1/me` | GET | The signed-in user (Supabase token). |
| `/v1/experiments` | POST, GET | Create a draft from an image; list own saved experiments and live drafts (PR 4 branch). |
| `/v1/experiments/{id}` | GET, PATCH, DELETE | Read, edit/save (PATCH and DELETE on the PR 4 branch). |

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

### Student logbook (PR 3 create and read: merged 2026-10-11 as PR #11, live-verified)

Planned slice 1: Supabase Auth login, saving an analysis as an experiment, and list/open/rename/delete. The backend verifies Supabase access tokens (every `/v1/*` route, `GET /v1/me`) and can create and read experiments (PR 3). List, rename, save and delete exist on the PR 4 branch (`feat/experiments-list-patch-delete`, not yet merged; migration 0002 not yet applied). The app's login and experiment screens do not exist yet.

-   `POST /v1/experiments` (multipart `image`): validates and cleans the upload with `prepare_image`, analyzes it with Gemini, and stores it as a draft that expires after `DRAFT_TTL_HOURS`. Stored with it: a metadata-free JPEG display copy (long edge at most 2048 px), a 256 px thumbnail, the model that answered and a hash of the production prompt (`PROMPT_VERSION`). Returns 201 with the experiment and short-lived signed image URLs.
    -   Order: draft cap (409), `prepare_image`, display copies, the per-user daily quota (`consume_gemini_call`, 429 with `Retry-After`), Gemini, uploads, insert. A rejected image or a failed display copy costs no quota.
    -   On failure: if Gemini fails, nothing is stored. If an upload fails, the uploaded images are deleted. If the insert fails, the row is deleted first (the insert may have committed before its response was lost) and the images only if that succeeded; otherwise they are kept so a surviving row keeps its images. On the PR 4 branch the insert goes through `create_draft` (draft cap under a per-user lock, nothing written after a deadline 8 s out), and the row cleanup waits until 2 s past that deadline and then calls `discard_draft`.
-   PR 4 branch: `GET /v1/experiments` (own saved experiments and live drafts, newest first, cursor paging, thumbnail URLs only), `PATCH /v1/experiments/{id}` (title/notes, save a draft; saved cap 409), `DELETE /v1/experiments/{id}` (row first, then images), and a best-effort purge of drafts expired for over 5 minutes after each create and list.
-   `GET /v1/experiments/{id}`: returns the caller's own experiment with freshly signed image URLs. Another user's ID, a non-UUID or an expired draft gives the same 404 as a missing ID.
-   Isolation lives in `backend/app/services/logbook.py`: every query filters by the verified `user_id`, every storage path must start with `<user_id>/`, and rows returned by Supabase are re-checked. Logs carry operation names and status codes only.
-   Tests use an in-memory fake of Supabase (`backend/tests/test_experiments.py`).

Verified live (2026-10-11, user-reported, against the real Supabase project):

-   An `sb_secret_` key works with the `apikey` header alone (no `Authorization` header).
-   Storage upload and signed-URL request paths, and the `signedURL` format the code expects (`/object/sign/...`).
-   The quota RPC: `usage_daily` counted 1 after one create.
-   The bucket limits accept the upload.
-   Two-user isolation: user A reading A's experiment gets 200; user B reading A's experiment gets 404.

Still unverified:

-   That deleting a storage path that was never stored returns 200 (cleanup after a failed or timed-out upload relies on this).
-   Latency between Render and Supabase.
-   Memory on Render for the second decode (the display copies) on each create.

Known trade-offs / deferred:

-   Orphaned storage objects persist until a sweeper exists: a crash between upload and insert, a failed image delete, or an expired-draft purge whose delete was still running when its re-check read. PR 6 account deletion must delete everything under the user's folder, not only the files listed in rows.
-   A Gemini failure, or hitting the server-wide daily cap, still costs one unit of the user's daily quota.
-   The stored analysis has no length cap. Add one in PR 5, before it feeds `/ask` and `/quiz`.
-   The draft and saved caps rely on PostgREST's default READ COMMITTED isolation (each count runs after the per-user advisory lock). Under REPEATABLE READ or stricter, the snapshot predates the lock and a concurrent create could be missed. Keep the default, or switch to per-user counter rows locked with SELECT ... FOR UPDATE.
-   Migration 0002 sets a 5 s `statement_timeout` on `service_role`, which covers every backend statement. PR 6 account deletion (cascade plus storage cleanup) and any backfill must set a longer timeout for their own transaction.
-   No per-user rate limit on `/v1` list, PATCH and DELETE, and every list (and create) also starts an expired-draft purge (2-4 Supabase calls). Add per-user limits, and run the purge at most once per user per few minutes.
-   On an insert failure, cleanup waits until 2 s past the create deadline (up to about 10 s) before `discard_draft`, and holds a threadpool worker meanwhile. The client already gets a 503; the worker cost matters only if insert failures become frequent.
-   Clock skew: the create deadline tolerates the database clock lagging Render's by about 2 s (minus the discard call's latency). Beyond that, a queued create can still insert after its images were deleted (a draft without images until the purge). Future hardening: a tombstone written by `discard_draft` and checked by `create_draft`, which removes the clock dependence. The purge margin assumes the clocks agree within 5 minutes.
-   `discard_draft` returns false both when no row exists and when the row is no longer a draft, and cleanup treats both as success. A draft saved from another session during the cleanup wait would lose its images. Future fix: a three-way result (deleted / absent / kept), deleting images only for deleted or absent.
-   `discard_draft` waits up to 6 s for the per-user lock, longer than the 5 s statement timeout, so a create still running finishes or rolls back first. If the discard still fails (transport error), the images are kept; if the create had rolled back, they are orphaned.
-   GET treats an expired draft as missing (404) while DELETE still deletes it (204). This is intended. GET decides expiry on the backend clock; the database functions use the database's clock.
-   Logs: Render's start command lives in the dashboard (not the repo) and must include `--no-access-log --ws none`. `--ws none` matters because WebSocket handshakes log the path and query on `uvicorn.error`, which the access-log flag does not cover. `app/main.py` also templates IDs and drops query strings in uvicorn's access log as a backstop. Never run with `--log-level trace` in production: it logs whole requests, including the Authorization header. Render's own HTTP request logs, and Supabase's API logs (which see `user_id=eq.<uid>` and experiment IDs in query strings), may still record them.

Schema and settings:

-   `supabase/migrations/0001_logbook.sql` creates `experiments`, `usage_daily`, the `consume_gemini_call` function and a private `experiment-images` bucket. Row-level security is on, with no policies, so the app's publishable key cannot touch them. Only the backend (secret key) can.
-   Settings: `SUPABASE_URL` (https origin), `SUPABASE_SECRET_KEY` (backend host only, never the app or the repo), `LOGBOOK_BUCKET`, `USER_DAILY_GEMINI_LIMIT`, `MAX_SAVED_EXPERIMENTS_PER_USER`, `MAX_DRAFTS_PER_USER`, `DRAFT_TTL_HOURS`. The logbook counts as configured only when both the URL and the secret key are set.

Setup (manual, not yet verified against a real project):

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
