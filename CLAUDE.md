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

## Planned / not implemented (do not describe as implemented)
Authentication and database-backed accounts are currently deferred. None of this exists in the code:
- User accounts and login.
- Saved experiment logs (list, open, rename, delete).
- Server-side storage of analyses so /ask and /quiz take an experiment_id (today they take a client-supplied analysis).
- Per-user rate limiting.
- Later assistant features: cross-experiment context, learning tracking.
- RAG.

## Known issues / follow-up tasks
Details in docs/HANDOFF.md section 2.
- Remove the temporary HealthDiagnostic panel (frontend/src/components/HealthDiagnostic.tsx).
- No auth or per-user rate limiting on the public API (only global limits).
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
