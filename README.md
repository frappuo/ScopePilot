# ScopePilot

**ScopePilot: An AI-Assisted Microscopy Observation System Using Vision Language Models.**

Educational microscopy only. ScopePilot is not a diagnostic system: it does not diagnose disease or replace a teacher, a lab manual or expert judgment.

## 1. What it is

A student photographs the view through a microscope and picks the photo in the app. The app has no in-app camera, so the photo comes from the phone's photo library. The app sends the image to a FastAPI backend. The backend calls Gemini and returns a tentative, structured analysis with five parts: probable specimen, visible structures, observations, explanation and limitations. From there the student can ask follow-up questions about the observation, take a three-question quiz, and keep the observation in a personal logbook (title, notes, saved or draft).

The analysis is a starting point, not an answer. The student checks everything against what they actually see and against trusted course material.

## 2. Architecture

```
Expo app (React Native, TypeScript)
  → FastAPI /v1 API: verifies the Supabase access token, applies a per-user daily AI limit
    → Gemini (image analysis, follow-up answers, quizzes)
Supabase: accounts (Auth), logbook rows (Postgres), images (private Storage bucket)
```

- **Keys stay on the server.** The model sits behind the backend, and the Gemini API key exists only on the server, never in the app. The app signs in with Supabase's publishable key. Logbook data is read and written only by the backend, with the Supabase secret key, and every query is scoped to the signed-in user.
- **Image handling.** The backend checks the declared type, size, pixel count and frame count of each image. It then re-encodes the image without EXIF/GPS metadata before anything is sent to Gemini or stored. iPhone camera JPEGs (detected as MPO) are accepted, using their first frame.
- **Limits.** Request bodies have size limits. Each user has a daily AI limit, shared by create, ask and quiz (`USER_DAILY_GEMINI_LIMIT`), and the server has its own daily Gemini cap (`GEMINI_DAILY_CALL_LIMIT`). There is also an optional shared app token (`APP_TOKEN`). The token ships inside the app, so it deters casual clients but is not authentication.
- **Legacy routes.** The original routes (`/analyze`, `/ask`, `/quiz`) have no user accounts. They are still served unless `LEGACY_API_ENABLED=false`, which answers them with 410.
- **CORS is off on purpose.** The native app doesn't need it, so the browser preview can't call the API.

Layout:
- `backend/app`: `routes/` (HTTP only), `schemas/` (Pydantic), `services/` (Gemini, images, logbook, auth), `config.py`, `middleware.py`
- `backend/tests`, `backend/evals`
- `supabase/migrations`
- `frontend/src`: `api/`, `auth/`, `components/`, `navigation/`, `screens/`, `theme/`
- `frontend/tests`

## 3. Setup

All commands are PowerShell and run from the repository root unless noted. You need Python 3.12 or newer, Node.js 22.14 or newer with npm, a Gemini API key, and a Supabase project.

### Supabase (once)

1. Create a project.
2. In the SQL editor, run `supabase/migrations/0001_logbook.sql` and then `0002_logbook_caps.sql`. Run both before the backend uses the project.
3. Turn on email confirmation for Auth. Before real users sign up, configure custom SMTP and use OTP codes in the email templates; the app confirms sign-up and password recovery with a 6-digit code.

More detail is in [docs/HANDOFF.md](docs/HANDOFF.md), section 5.

### Backend

```powershell
python -m venv backend/.venv
.\backend\.venv\Scripts\python.exe -m pip install -r backend/requirements-dev.txt
Copy-Item backend/.env.example backend/.env
```

Copy the file only once, so an existing configuration is never overwritten. In `backend/.env`, set:
- `GEMINI_API_KEY`;
- `SUPABASE_URL`, the project origin, such as `https://<project-ref>.supabase.co`;
- `SUPABASE_SECRET_KEY`.

The secret key bypasses row-level security, so keep it on the backend host only. Every other setting is described in `backend/.env.example`. Environment variables override the file. `.env` files are ignored by Git; only the `.env.example` files are committed.

Run the backend:

```powershell
.\backend\.venv\Scripts\python.exe -m uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8000 --no-access-log --ws none
```

Keep `--no-access-log --ws none` everywhere, including on a host. The flags keep request paths and queries out of the logs. Don't use `--root-path`, because the middlewares match the raw path. To check that the backend is up, run `Invoke-RestMethod http://127.0.0.1:8000/health` from a second terminal; it should return `{"status":"ok"}`. This shows only that the backend is running, not that the Gemini key works.

### Frontend

```powershell
Push-Location frontend
npm.cmd ci
Copy-Item .env.example .env
Pop-Location
```

Fill in `frontend/.env` using the comments in `frontend/.env.example`:
- **`EXPO_PUBLIC_API_URL`:** the backend origin, with no path.
- **`EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`:** use the publishable key, never the secret key. The app refuses to start with a secret key.
- **`EXPO_PUBLIC_APP_TOKEN`:** only if the backend sets `APP_TOKEN`.

Every `EXPO_PUBLIC_` value is compiled into the app bundle, so none of them may be a secret. Restart Expo after any change. On a phone, open the app in an Expo Go version compatible with SDK 57.

## 4. Local device testing

On a physical phone, `localhost` and `127.0.0.1` point to the phone itself, not your computer. The tested setup uses a cloudflared quick tunnel. The tunnel address changes every run, so repeat steps 2 and 3 each time.

1. Start the backend on `127.0.0.1:8000` as above. While the tunnel is open, turn the legacy routes off and keep the server-wide cap low:
   ```powershell
   $env:LEGACY_API_ENABLED = 'false'
   $env:GEMINI_DAILY_CALL_LIMIT = '20'
   .\backend\.venv\Scripts\python.exe -m uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8000 --no-access-log --ws none
   ```
2. In a second terminal, run `cloudflared tunnel --url http://127.0.0.1:8000`. Set `EXPO_PUBLIC_API_URL` in `frontend/.env` to the `https://<name>.trycloudflare.com` origin it prints.
3. In a third terminal, clear any stale shell variable, then start Expo with a cleared cache:
   ```powershell
   Remove-Item Env:EXPO_PUBLIC_API_URL -ErrorAction SilentlyContinue
   Push-Location frontend
   npx.cmd expo start -c --tunnel
   ```

The pitfall: a `$env:EXPO_PUBLIC_API_URL` set earlier in the same PowerShell session overrides `frontend/.env` without any warning, and the app keeps calling an old address. That is why step 3 clears it.

## 5. Tests

The backend tests use synthetic images and mock Gemini and Supabase, so they need no keys:

```powershell
Push-Location backend
.\.venv\Scripts\python.exe -m pytest -q --basetemp="$env:USERPROFILE\pytest-tmp"
Pop-Location
```

`--basetemp` avoids Windows temp-folder permission errors.

The frontend tests mock HTTP and never call the backend, Supabase or Gemini:

```powershell
Push-Location frontend
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
Pop-Location
```

The build exports JavaScript bundles into the ignored `frontend/dist`. It doesn't produce an APK or IPA.

None of these tests checks live model quality or a real Supabase project.

## 6. Evaluation

`backend/evals/microscopy_eval.py` is a Braintrust harness for comparing prompt variants. It runs each image through the same `prepare_image` and Gemini path as production. Model fallback is turned off and the model is recorded with each run. The production prompt is never modified.

Run it from `backend/`, with `GEMINI_API_KEY` set in `backend/.env` and Braintrust credentials available to the CLI:

```powershell
$env:SCOPEPILOT_EVAL_PROMPT_VARIANT = 'prompt-a-naive-baseline'
.\.venv\Scripts\braintrust.exe eval evals/microscopy_eval.py
```

The variants are `prompt-a-naive-baseline`, `prompt-b-scopepilot-production`, `prompt-c-overconstrained` and `prompt-d-synthesized`.

Read the results with care:
- It is a pilot of five images. The labels are manual and have not been checked by an expert.
- The scorers are a lexical specimen match, structure recall, schema validity and whether any limitation is listed.
- A lexical match is not biological accuracy, since synonyms count as misses. Recall ignores extra or invented structures, and a valid schema says nothing about whether the content is true.
- Five images say nothing about general performance.
- The variant names in the recorded results differ from those in the code. See [docs/HANDOFF.md](docs/HANDOFF.md), sections 8 and 9, for the results and their limits.

## 7. Known limitations

- **Output can be wrong.** Gemini's output is tentative: it can misidentify a specimen, list structures that aren't visible, or explain things incorrectly. A valid response shape doesn't make it correct.
- **No microscopy check.** Any valid image is analyzed, including one that isn't a microscopy image.
- **Off-topic questions and prompt injection** (including text inside an image) are handled only by prompt instructions and output validation. There is no dedicated filter, and resistance is not guaranteed.
- **Quiz answers reach the app.** The correct answers are sent with the questions, so a determined user can read them. The quiz is for practice, not assessment.
- **Ask history isn't saved.** Follow-up answers aren't stored. Leaving the screen loses them.
- **RAG isn't built.** Grounding explanations in trusted biology material is planned, not implemented.
- **The deployed backend can't serve the logbook yet.** The public backend (https://scopepilot.onrender.com) answers `/v1` with 503 "Logbook not configured.", so the logbook currently works only against a local backend.
- **Legacy routes are unprotected** until `LEGACY_API_ENABLED=false` is set on the host. Until then they have only global limits and no user accounts.
- **Supabase's built-in email sender** allows only a few messages per hour. Custom SMTP must be configured before real users sign up.

## 8. Project status and docs

The backend's logbook API (`/v1`) is complete. On branch `feat/app-login-logbook`, the app has:
- Supabase email and password accounts;
- the logbook (create, list, open, edit, save, delete);
- follow-up questions, quizzes and daily usage;
- account deletion.

The original single-screen analysis client has been removed from the app.

The repository is at https://github.com/frappuo/ScopePilot.

- [docs/HANDOFF.md](docs/HANDOFF.md): architecture, design decisions, endpoint details, what has been verified and where, known issues, evaluation results and next steps. It can lag the code; the code is the source of truth.
- [CLAUDE.md](CLAUDE.md): working rules for this repository (commands, architecture rules, secrets and privacy, honesty rules).
