# ScopePilot

AI-assisted microscopy education app (name is ScopePilot, never "MicroLens"). Educational only, NOT diagnostic.
Stack: Expo/React Native/TypeScript frontend, FastAPI + Pydantic backend, Gemini VLM, Braintrust evals, Render deploy (per handoff; no Render config in the repo).
Full context: @docs/HANDOFF.md. It may lag the code; the repo is the source of truth.

## Commands (PowerShell, repo root)
- Backend tests: `Push-Location backend; .\.venv\Scripts\python.exe -m pytest -q --basetemp="$env:USERPROFILE\pytest-tmp"; Pop-Location` (basetemp avoids Windows temp-folder permission errors)
- Run backend: `.\backend\.venv\Scripts\python.exe -m uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8000`
- Frontend (from frontend/): `npm.cmd run typecheck`, `npm.cmd test`, `npm.cmd run build`
- Eval (from backend/): set `$env:SCOPEPILOT_EVAL_PROMPT_VARIANT` then `.\.venv\Scripts\braintrust.exe eval evals/microscopy_eval.py`

## Architecture rules
- routes = HTTP only; schemas = Pydantic; services = Gemini/business logic; config = env. No Gemini calls in routes.
- Frontend never calls Gemini and never holds secrets. API calls live in a dedicated service.
- Keep experimental prompt changes isolated from the production prompt.

## Secrets and privacy
- Never read, print, log or commit backend/.env, frontend/.env or any secret. Only the variable name GEMINI_API_KEY appears in code.
- Never commit personal photos (EXIF/GPS). Test fixtures must be synthetic or public-domain.
- Logbook data is accessed only through the backend with the Supabase secret key (SUPABASE_SECRET_KEY; bypasses row-level security), and every query must be scoped by the verified user_id. The secret key never goes in the app, the repo, logs or docs.
- No key, token, password or Supabase project URL in any file.

## Working style
- Inspect first, then explain the plan and the files to change. For risky changes, plan only and wait for approval.
- Keep changes focused; do not touch unrelated files.
- Run relevant tests/build after edits, report commands and results, and never claim something works unless it was run.
- Frontend style: functional React components; no state-management library unless necessary; no authentication unless explicitly requested.

## Known facts
- iPhone camera JPEGs are detected by Pillow as format MPO (2 frames). Fixed by `prepare_image` (commit d2ea65f): MPO is accepted as JPEG, first frame only, re-encoded without metadata. User-verified on a physical iPhone against Render on 2026-10-03.
- Frontend reads the API base URL from EXPO_PUBLIC_API_URL (frontend/.env).
- Model: code default `gemini-2.5-flash` (config.py); backend/.env.example sets `gemini-3.1-flash-lite`; the model used on Render is not verifiable from the repo.
- Model fallback: GEMINI_FALLBACK_MODELS (comma-separated, max 3, same key) is tried only on 429/RESOURCE_EXHAUSTED or 404/NOT_FOUND; all other errors fail immediately. Evals never fall back and record the model in the experiment name/metadata. Only list models verified for image input and structured JSON output; models can be retired at any time.
- Request limits: body size (app/middleware.py; /analyze = MAX_IMAGE_BYTES + 64 KiB, others MAX_JSON_BODY_BYTES, /health exempt); /ask and /quiz analysis caps (AnalysisInput); GEMINI_DAILY_CALL_LIMIT per UTC day per process, counts every attempt incl. fallbacks, 503 + Retry-After, resets on restart.
- CORS is intentionally off: the native app does not need it, and CORS is not an abuse control.
- App token: APP_TOKEN (backend) / EXPO_PUBLIC_APP_TOKEN (app) -> header X-ScopePilot-Token, checked before body parsing; empty = off; /health exempt; 401 "Unauthorized client.". It is compiled into the app bundle: a deterrent, NOT authentication. Rollout: ship the app, then set APP_TOKEN on Render, then confirm old builds get 401. Never put a real token in code, tests, docs or logs.
- Logbook PRs 1 (scaffolding: Supabase schema, settings) and 2 (Supabase access-token verification in services/auth.py, BearerAuthMiddleware for /v1/*, GET /v1/me) are merged. /v1 returns 503 "Logbook not configured." unless SUPABASE_URL and SUPABASE_SECRET_KEY are both set.
- Supabase and Render are running, but SUPABASE_URL and SUPABASE_SECRET_KEY must stay unset on Render until the experiment endpoints exist and the isolation tests pass.
- Per-IP rate limiting is dropped; per-user limits (planned) replace it.

## Planned / not implemented (do not describe as implemented)
Only token verification and GET /v1/me exist. None of this exists in the code yet (remaining logbook PRs, in order):
- PR 3: create/read experiments.
- PR 4: list/rename/save/delete experiments.
- PR 5: experiment-scoped /ask and /quiz (experiment_id instead of a client-supplied analysis) plus the per-user Gemini cap.
- PR 6: account deletion.
- PR 7: legacy switch.
- Then the frontend login and experiments screens (no login in the app today).
- Later assistant features: cross-experiment context, learning tracking.
- RAG.

## Known issues / follow-up tasks
Details in docs/HANDOFF.md section 2.
- Legacy /analyze, /ask, /quiz have no user auth or per-user limits (only global limits and a shared app token) until the logbook PRs land.
- Browser preview cannot call the API (CORS intentionally off).
- /ask and /quiz trust the client-supplied analysis.
- Reconcile eval variant names (code names differ from the handoff's recorded results).
- Gemini's handling of 16-bit PNG is untested.
- Default model mismatch (see Known facts); .env.example lacks MAX_ENCODED_IMAGE_BYTES.
- A "server busy" 503 shows the app's generic 503 message.

## Honesty rules
- Distinguish implemented / partial / planned. RAG is planned, not implemented.
- Lexical specimen matching is NOT biological accuracy. Schema validity is shape, not truth.
- Never claim: hallucination-free output, guaranteed identification, prompt-injection immunity, a novel model architecture, or that 5 images show general performance.
- Gemini output is tentative, not ground truth. No fake confidence percentages.
