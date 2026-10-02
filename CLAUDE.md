# ScopePilot

AI-assisted microscopy education app (name is ScopePilot, never "MicroLens"). Educational only, NOT diagnostic.
Stack: Expo/React Native/TypeScript frontend, FastAPI + Pydantic backend, Gemini VLM, Braintrust evals, Render deploy.
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

## Known facts
- iPhone camera JPEGs are detected by Pillow as format MPO (2 frames); `prepare_image` accepts them as JPEG, uses only the first frame and re-encodes it (fixed with synthetic tests; not yet verified with a real iPhone upload).
- Frontend reads the API base URL from EXPO_PUBLIC_API_URL (frontend/.env). The README is partly stale.

## Honesty rules
- Distinguish implemented / partial / planned. RAG is planned, not implemented.
- Lexical specimen matching is NOT biological accuracy. Schema validity is shape, not truth.
- Never claim: hallucination-free output, guaranteed identification, prompt-injection immunity, a novel model architecture, or that 5 images show general performance.
- Gemini output is tentative, not ground truth. No fake confidence percentages.
