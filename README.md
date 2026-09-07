# ScopePilot

AI-assisted microscopy education. AI observations are tentative, require student/instructor verification, and are not medical diagnoses.

## Day 1 backend

Implemented scope: FastAPI health and image-analysis endpoints, plus an Expo gallery-to-analysis frontend. Later MVP features are not implemented.

### Setup (PowerShell, from repository root)

Use Python 3.12 or newer. If `python` is unavailable, replace it in the first command with the full path to your Python executable.

```powershell
python -m venv backend/.venv
.\backend\.venv\Scripts\python.exe -m pip install -r backend/requirements-dev.txt
Copy-Item backend/.env.example backend/.env
```

Create the environment file only once; do not overwrite an existing configuration. Edit `backend/.env` and set `GEMINI_API_KEY` to your key. `GEMINI_MODEL` is configurable and defaults to `gemini-2.5-flash`; the selected model must support image input and structured JSON output. Environment variables override this file. Restart the backend after changes.

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

### Analyze a real image

Replace the example image path with an existing microscopy image:

```powershell
curl.exe -X POST http://127.0.0.1:8000/analyze -F "image=@C:/path/to/microscopy.jpg;type=image/jpeg"
```

The multipart field is `image`. Supported types: JPEG (`image/jpeg`), PNG (`image/png`), and single-frame WebP (`image/webp`). Default limits: 10 MiB and 20 million pixels. The backend checks declared type against decoded contents. Uploads are not retained by application code; FastAPI may temporarily spool multipart files while receiving a request. The file-size check runs after multipart parsing, so it is not a total HTTP request-body limit.

Success returns `probable_specimen`, `visible_structures`, `observations`, `explanation`, and `limitations`. The backend sends validated image bytes to Gemini using the [Google Gen AI SDK](https://github.com/googleapis/python-genai) and validates its JSON response with Pydantic.

Errors use `{"detail":"..."}` (FastAPI validation errors use a detail list): 400 empty/corrupt image; 413 image limit exceeded; 415 unsupported or mismatched type; 422 missing upload; 503 missing key or provider quota; 502 provider/network/response failure; 504 timeout. No automatic provider retries are made.

### Tests (from repository root)

```powershell
Push-Location backend
.\.venv\Scripts\python.exe -m pytest -q
Pop-Location
```

Tests mock Gemini at the SDK boundary, so they need no API key and do not verify live model quality or access. A successful real-image request with a configured key is still required to verify the live integration.

## Frontend: phone image analysis

The Expo TypeScript app selects one gallery image, previews it, uploads it, and displays Probable Specimen, Visible Structures, Observations, Explanation, and Limitations. It uses local React state and a dedicated API service. Gallery images are converted to JPEG at 90% quality and resized only when the longest edge exceeds 2400 pixels; no cropping is applied. Fine detail can be affected by this conversion and AI observations still need verification.

Install from the repository root (Node.js 22.14+ and npm):

```powershell
Push-Location frontend
npm.cmd ci
Pop-Location
```

Start the backend from the repository root in one terminal. The process-only model override below uses the model verified with a live request; it does not change the user-managed backend configuration file.

```powershell
$env:GEMINI_MODEL = 'gemini-3.6-flash'
.\backend\.venv\Scripts\python.exe -m uvicorn app.main:app --app-dir backend --host 0.0.0.0 --port 8000
```

Stop any older backend using that port first. Connect the phone and computer to the same trusted Wi-Fi. Find the computer's active Wi-Fi IPv4 address with `ipconfig`. If needed, allow Python through Windows Firewall on the private network. In a second terminal, replace `192.168.1.100` below with that address:

```powershell
Push-Location frontend
$env:EXPO_PUBLIC_API_URL = 'http://192.168.1.100:8000'
npm.cmd start -- --lan
```

Open the QR code in an Expo Go version compatible with SDK 57. On a physical phone, `localhost` and `127.0.0.1` point to the phone, not the computer. Verify `http://<computer-ip>:8000/health` in the phone browser if uploads cannot connect. For an Android emulator, the host is normally `10.0.2.2`.

`EXPO_PUBLIC_API_URL` is a public backend address, not a secret. Never add Gemini credentials to the frontend. Restart Expo after changing the address. Requests time out after 90 seconds; image selection and analysis buttons are disabled while a request is running. Errors preserve the selected image for retry; selecting a new image clears the old result.

Frontend checks (from `frontend`):

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
```

The build exports Android/iOS JavaScript and Hermes bundles plus a web preview into ignored `frontend/dist`; it does not produce an APK or IPA. API tests use mocked HTTP responses and do not call Gemini.

Optional layout preview:

```powershell
npm.cmd run web
```

The intended upload target is the native phone app. The browser preview requires backend CORS support for cross-origin API requests; this parcel does not change backend CORS configuration.
