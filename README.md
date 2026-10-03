# ScopePilot

AI-assisted microscopy education. AI observations are tentative, require student/instructor verification, and are not medical diagnoses.

## Status

Implemented:

- FastAPI backend: `GET /health`, `POST /analyze` (image → structured analysis), `POST /ask` (follow-up question about the current analysis), `POST /quiz` (three multiple-choice questions from the current analysis).
- Expo TypeScript app: gallery image selection, analysis display, follow-up Q&A, and quiz.
- Braintrust prompt-evaluation harness (`backend/evals/microscopy_eval.py`).

Not implemented: RAG, camera capture in the app, user accounts, saved analyses, and per-user rate limiting. Backend CORS is intentionally off (see Request limits). See [docs/HANDOFF.md](docs/HANDOFF.md) for architecture, status, planned features, and known issues.

## Backend

### Setup (PowerShell, from repository root)

Use Python 3.12 or newer. If `python` is unavailable, replace it in the first command with the full path to your Python executable.

```powershell
python -m venv backend/.venv
.\backend\.venv\Scripts\python.exe -m pip install -r backend/requirements-dev.txt
Copy-Item backend/.env.example backend/.env
```

Create the environment file only once; do not overwrite an existing configuration. Edit `backend/.env` and set `GEMINI_API_KEY` to your key. Environment variables override this file. Restart the backend after changes.

`GEMINI_MODEL` selects the model; it must support image input and structured JSON output, and your key must have access to it. The default in `backend/app/config.py` is `gemini-2.5-flash`, which an earlier live check (see `progress.md`) found unavailable to new users. `backend/.env.example` sets `gemini-3.1-flash-lite`. Other settings: `GEMINI_FALLBACK_MODELS` (empty; up to 3 models tried only on quota or model-not-found errors, see `docs/HANDOFF.md`), `GEMINI_TIMEOUT_SECONDS` (default 60), `MAX_IMAGE_BYTES` (10 MiB), `MAX_IMAGE_PIXELS` (20,000,000), `MAX_ENCODED_IMAGE_BYTES` (14 MiB; not listed in `.env.example`), `MAX_JSON_BODY_BYTES` (64 KiB), `GEMINI_DAILY_CALL_LIMIT` (100), `APP_TOKEN` (empty = check off; see App token). Numeric settings must be positive.

`.env` files are ignored by Git; only `.env.example` belongs in version control. Never put API keys in source files or the frontend.

### Run (from repository root)

```powershell
.\backend\.venv\Scripts\python.exe -m uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8000
```

Keep this terminal open. In a second PowerShell terminal:

```powershell
Invoke-RestMethod http://127.0.0.1:8000/health
```

Startup fails clearly if `GEMINI_API_KEY` is missing or blank. The application loads user-managed `backend/.env` regardless of the working directory and never writes that file. Startup errors omit configuration values.

Expected JSON: `{"status":"ok"}`. This checks backend liveness after configuration loads, not Gemini credential validity or availability. Interactive API documentation: http://127.0.0.1:8000/docs.

### Analyze an image

```powershell
curl.exe -X POST http://127.0.0.1:8000/analyze -F "image=@C:/path/to/microscopy.jpg;type=image/jpeg"
```

The multipart field is `image`. Accepted declared types: `image/jpeg`, `image/png`, `image/webp`. Before Gemini is called, `prepare_image` in `backend/app/services/images.py`:

1. Rejects empty uploads, uploads over `MAX_IMAGE_BYTES`, and other declared types.
2. Reads only the image header and checks that the detected format matches the declared type, that width × height is within `MAX_IMAGE_PIXELS`, and that the image has one frame. iPhone camera JPEGs, which Pillow detects as MPO with two frames, are accepted as JPEG; animated GIF/PNG/WebP are rejected.
3. Decodes the first frame, applies EXIF orientation, and re-encodes it without EXIF/GPS, XMP, or text metadata (the ICC colour profile is kept when the image mode is unchanged): JPEG/MPO → JPEG quality 95 (a deliberate second lossy encode); PNG → PNG, lossless, keeping mode, alpha, palette, and 16-bit grayscale; WebP → WebP quality 95. No resizing.
4. Rejects re-encoded output over `MAX_ENCODED_IMAGE_BYTES`.

Only one image is decoded/re-encoded at a time; a request that waits more than 5 seconds for its turn gets 503. Rejections are logged with the rule, declared type, and detected format only. Uploads are not retained by application code; FastAPI may temporarily spool multipart files while receiving a request. The file-size check runs after multipart parsing, so it is not a total HTTP request-body limit.

Success returns `probable_specimen`, `visible_structures`, `observations`, `explanation`, and `limitations`, validated with Pydantic. A valid schema guarantees shape, not biological correctness.

Errors use `{"detail":"..."}` (FastAPI validation errors use a detail list):

| Status | Cause |
|---|---|
| 400 | Empty, corrupt, or undecodable image |
| 401 | Missing or wrong `X-ScopePilot-Token` while `APP_TOKEN` is set |
| 413 | Request body over limit, upload over size limit, resolution over pixel limit, or re-encoded image too large |
| 415 | Unsupported declared type, content not matching the declared type, or multi-frame image |
| 422 | Missing upload, invalid request body, or `/ask`/`/quiz` analysis over the input caps |
| 502 | Gemini provider, network, or response-validation failure; unavailable model |
| 503 | Missing API key, Gemini quota/rate limit, server busy decoding another image, or daily Gemini limit reached (with `Retry-After`) |
| 504 | Gemini timeout |

No automatic provider retries are made.

### Request limits

- **Body size** (`backend/app/middleware.py`): `/analyze` allows `MAX_IMAGE_BYTES` + 64 KiB of multipart overhead; every other path allows `MAX_JSON_BODY_BYTES`; `/health` is exempt. A `Content-Length` over the limit gets 413 before anything is read; a chunked body is counted as it streams and gets 413 once it passes the limit.
- **Input caps** for the analysis sent to `/ask` and `/quiz`: `probable_specimen` ≤ 300 characters, `explanation` ≤ 6000, each list ≤ 40 items of ≤ 1000 characters; over a cap gives 422. The `/analyze` response is not capped.
- **Daily Gemini cap**: at most `GEMINI_DAILY_CALL_LIMIT` Gemini attempts per UTC day, fallback attempts included; then 503 with `Retry-After` (seconds until 00:00 UTC). The count is per process and resets on restart; Google's own quota reset time may differ from UTC midnight. Requests rejected before Gemini (bad images, caps, body size) do not count.
- These are global limits, not per-user rate limiting or authentication.
- **CORS is intentionally not enabled.** The native app does not need it, and CORS only restricts browsers, so it is not an abuse control. As a result the browser preview cannot call the API.

### App token (not authentication)

- With `APP_TOKEN` set, every path except `/health` (including `/docs`) requires the header `X-ScopePilot-Token` with the same value, compared in constant time. A missing or wrong token gets 401 `{"detail": "Unauthorized client."}` before the request body is read. Empty `APP_TOKEN` turns the check off.
- The app sends `EXPO_PUBLIC_APP_TOKEN` (from `frontend/.env`) in that header when it is set, and sends nothing otherwise.
- `EXPO_PUBLIC_` values are compiled into the app bundle, so anyone with the app can extract the token. It deters casual scripts and drive-by web pages (a custom header forces a CORS preflight, and CORS is off), but it is **not authentication**. Real protection needs user accounts.
- Rollout order: (1) ship the updated app built with `EXPO_PUBLIC_APP_TOKEN`; (2) set `APP_TOKEN` on Render; (3) confirm an old build now shows "This app version can't reach the service. Please update the app." (401).
- Use dummy values in examples and tests; never commit a real token.

### Tests (from repository root)

```powershell
Push-Location backend
.\.venv\Scripts\python.exe -m pytest -q --basetemp="$env:USERPROFILE\pytest-tmp"
Pop-Location
```

`--basetemp` avoids Windows temp-folder permission errors. Tests use synthetic images and mock Gemini at the SDK boundary, so they need no API key and do not verify live model quality or access.

## Frontend

The Expo TypeScript app selects one gallery image, previews it, uploads it, and displays Probable Specimen, Visible Structures, Observations, Explanation, and Limitations, followed by a follow-up question box and a three-question quiz. It uses local React state and a dedicated API service (`frontend/src/services/api.ts`).

The app uploads the original picked file without converting, resizing, or cropping it (`frontend/src/services/images.ts`). The type comes from the picker's MIME type, or the file extension if none is given; HEIC and unrecognized types are rejected in the app. Normalization (orientation, metadata removal, re-encoding) happens on the backend.

For 400, 413, and 415 responses, the app appends the backend's short `detail` message to its own error text. Details from 5xx responses and 422 are intentionally never shown; those use fixed messages written in the app:

- 401: "This app version can't reach the service. Please update the app."
- 429: "Too many requests right now. Please wait a minute and try again."
- 503 from the daily Gemini cap: a fixed "Today's ScopePilot analysis limit has been reached…" message. The app recognizes the backend detail by its prefix but never displays it; any other 503 gets the generic message.
- `/ask` and `/quiz` 413, and `/quiz` 422, have their own messages. For an `/ask` 422 the app reads only the structured error locations: a too-long question gets "Please enter a question of up to 500 characters."; anything else (such as the analysis caps) gets "This request could not be processed. Please analyze the image again."

Install from the repository root (Node.js 22.14+ and npm):

```powershell
Push-Location frontend
npm.cmd ci
Pop-Location
```

For local testing, start the backend so the phone can reach it (stop any older backend on that port first):

```powershell
.\backend\.venv\Scripts\python.exe -m uvicorn app.main:app --app-dir backend --host 0.0.0.0 --port 8000
```

Connect the phone and computer to the same trusted Wi-Fi. Find the computer's Wi-Fi IPv4 address with `ipconfig`. If needed, allow Python through Windows Firewall on the private network. The app reads the backend address from `EXPO_PUBLIC_API_URL` (normally set in `frontend/.env`; a PowerShell variable of the same name overrides it). Replace `192.168.1.100` below with your address:

```powershell
Push-Location frontend
$env:EXPO_PUBLIC_API_URL = 'http://192.168.1.100:8000'
npm.cmd start -- --lan
```

The address must be an origin only (no path such as `/health`). Open the QR code in an Expo Go version compatible with SDK 57. On a physical phone, `localhost` and `127.0.0.1` point to the phone, not the computer. For an Android emulator, the host is normally `10.0.2.2`.

`EXPO_PUBLIC_API_URL` is a public backend address, not a secret. Never add Gemini credentials to the frontend. Restart Expo after changing the address. Requests time out after 90 seconds; buttons are disabled while a request is running. Errors preserve the selected image for retry; selecting a new image clears the old result.

Frontend checks (from `frontend`):

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
```

The build exports Android/iOS JavaScript and Hermes bundles plus a web preview into ignored `frontend/dist`; it does not produce an APK or IPA. Tests use mocked HTTP responses and do not call the backend or Gemini.

Optional layout preview: `npm.cmd run web`. The intended upload target is the native app; browser API requests would need backend CORS support, which is intentionally off.
