# ScopePilot

AI-assisted microscopy education. AI observations are tentative, require student/instructor verification, and are not medical diagnoses.

## Day 1 backend

Implemented scope: FastAPI health and image-analysis endpoints. No frontend or later MVP features yet.

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
