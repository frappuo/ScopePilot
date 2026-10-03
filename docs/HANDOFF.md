# ScopePilot --- Product and Architecture Handoff

**Purpose:** Context handoff for Claude covering the product,
architecture, implementation, design decisions, evaluation, known
limitations, and next steps. This is a status summary; inspect the
repository for exact current code behavior.

-   **Official title:** ScopePilot: An AI-Assisted Microscopy
    Observation System Using Vision Language Models
-   **Course:** BCSE497J Project-I
-   **Repository:** https://github.com/frappuo/ScopePilot
-   **Public backend:** https://scopepilot.onrender.com (per handoff;
    the repository contains no Render configuration)
-   **Domain:** Educational microscopy only; not a diagnostic system.

## 1. Product summary

ScopePilot augments a conventional microscope with a smartphone
application and a backend-connected Vision-Language Model (VLM). A
student captures or uploads a microscope image. The mobile app sends it
to a FastAPI backend, which validates the upload and calls Gemini. The
result is returned as structured educational analysis: probable
specimen, visible structures, observations, explanation, and
limitations. The same context supports follow-up questions and quiz
generation.

The goal is to help students interpret and learn from microscopy
observations without requiring an expensive digital microscope or local
ML hardware. The AI is assistive and tentative; the student remains
responsible for verifying the output through direct observation and
trusted materials. ScopePilot does not diagnose disease or replace
expert judgment.

**Problem addressed:** students using microscopes often have difficulty
identifying specimens, recognizing visible biological structures,
understanding what they observe, and getting immediate guidance during
laboratory work. A conventional microscope gives visual access to a
specimen but no interactive educational assistance. ScopePilot augments
the existing optical microscope rather than replacing it.

**Longer-term ideas (not planned for the current prototype, not
implemented):** image history, comparison between microscope images, a
custom microscopy VLM, Soup-based fine-tuning, classifier/reliability
models, advanced uncertainty calibration, and real-time microscope
video.

## 2. Current status

### Implemented

-   React Native/Expo mobile application (gallery selection only; no
    camera capture).
-   Image upload of the original file; backend validation and
    re-encoding (see section 5).
-   FastAPI backend and Gemini VLM integration.
-   Structured microscopy analysis response.
-   Follow-up Q&A (`/ask`).
-   Quiz generation (`/quiz`): exactly three questions, four options
    each.
-   Backend error handling; the app shows the backend's `detail` for
    400/413/415 only.
-   Braintrust prompt-evaluation harness with four variants and
    deterministic scorers.
-   Optional Gemini model fallback on quota or model-not-found
    (`GEMINI_FALLBACK_MODELS`); evals are pinned to the primary model
    (sections 5 and 8).
-   Tests at the last run: backend 133 passed (2026-10-04); frontend 40
    passed (2026-10-03; frontend unchanged since).

### Verified on a physical device (user-reported)

-   2026-10-03: analysis, Q&A, quiz, Live Photos, and PNG uploads
    verified on a physical iPhone against the deployed Render backend.
-   Render deployment at `https://scopepilot.onrender.com`: per
    handoff and user report; not verifiable from the repository.

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

None of the following exists in the code. Authentication and
database-backed accounts are currently deferred.

-   User accounts and login.
-   Saved experiment logs: list, open, rename, delete.
-   Server-side storage of analyses, so that `/ask` and `/quiz` take an
    `experiment_id`. Today both accept the full analysis supplied by
    the client (`AskRequest.analysis`, `QuizRequest.analysis` in
    `backend/app/schemas/`).
-   Per-user rate limiting. The only rate-limit handling today maps a
    Gemini 429 to a 503.
-   Later assistant features: context across experiments and learning
    tracking.
-   RAG over trusted biology material.

### Known issues / follow-up tasks

-   Remove the temporary "connection diagnostic" panel
    (`frontend/src/components/HealthDiagnostic.tsx`, shown on the main
    screen) and its `checkBackendHealth`/`checkBackendPost` helpers.
-   No CORS configuration, so the browser preview cannot call the
    backend.
-   No authentication or rate limiting on the public API.
-   `/ask` and `/quiz` trust the client-supplied analysis.
-   Reconcile eval variant names: the code uses
    `prompt-a-naive-baseline`, `prompt-b-scopepilot-production`,
    `prompt-c-overconstrained`, `prompt-d-synthesized`, which differ
    from the names in section 8. `prompt-a-naive-baseline` actually
    sends the unchanged production prompt, and
    `prompt-b-scopepilot-production` is the production prompt plus
    extra instructions.
-   Gemini's handling of 16-bit grayscale PNG is untested.
-   The code default `GEMINI_MODEL` (`gemini-2.5-flash`) differs from
    `backend/.env.example` (`gemini-3.1-flash-lite`) and was recorded
    as unavailable to new users (`progress.md`).
-   `backend/.env.example` does not list `MAX_ENCODED_IMAGE_BYTES`.
-   A "server busy" 503 shows the app's generic 503 message, not the
    backend detail.
-   Real-device behavior of the decode lock and memory use on Render
    have not been measured.

## 3. Architecture

``` text
Conventional microscope
        |
Smartphone camera / image picker
        |
React Native + Expo app
        |
HTTP multipart image upload
        |
FastAPI backend
        |
Image/file validation
        |
Gemini VLM service
        |
Structured Analysis response
        |
Pydantic/schema validation
        |
JSON response to app
        |
Analysis UI
   |             |
Follow-up Q&A   Quiz generation
        |
Student verifies output
```

Planned RAG extension:

``` text
Trusted biology material
        |
Extract and chunk documents
        |
Generate embeddings
        |
Vector store / similarity retrieval
        |
Relevant passages + analysis context
        |
Generation of grounded educational explanation
```

RAG can ground biological explanations in sources; it cannot prove that
a structure is actually visible in the submitted image. Visual
interpretation, factual grounding, and human verification are distinct
responsibilities.

### Component responsibilities

**Frontend:** UI, gallery image selection (camera capture is not
implemented), API requests,
loading/error/success states, and display of analysis/Q&A/quiz. It does
not call Gemini directly.

**Backend:** API boundary, upload validation, model orchestration,
prompt handling, structured response validation, Q&A/quiz processing,
error handling, and provider credentials.

**Gemini:** pretrained multimodal inference component. It receives image
data and instructions and generates text. It is not assumed to be
perfectly accurate or calibrated and is replaceable in principle.

**Braintrust:** experiment tracking and evaluation, not the inference
model or product database.

## 4. Technology choices

  -----------------------------------------------------------------------
  Choice                              Purpose and rationale
  ----------------------------------- -----------------------------------
  React Native                        Cross-platform mobile application
                                      with a shared codebase.

  Expo                                Simplifies React Native
                                      development, device testing, and
                                      mobile integrations.

  TypeScript                          Helps catch frontend type and
                                      data-shape errors; verify exact
                                      repository usage before discussing
                                      particular files.

  Python                              Practical ecosystem for AI
                                      integration, validation, and
                                      evaluation.

  FastAPI                             Python REST API, typed request
                                      handling, automatic OpenAPI/Swagger
                                      docs, and straightforward
                                      AI-service integration.

  Pydantic                            Typed schemas and validation for
                                      predictable API/model output.

  Gemini VLM                          Image-plus-text understanding and
                                      natural-language explanation
                                      without training a custom model.

  Braintrust                          Controlled comparison of prompt
                                      variants and recorded evaluation
                                      results.

  Render                              Public HTTPS hosting for the
                                      backend.

  ChromaDB/embeddings                 Planned RAG direction; not in the
                                      code or requirements.
  -----------------------------------------------------------------------

### Why a VLM rather than a conventional classifier?

A classifier usually returns a label. ScopePilot needs a richer
interaction: likely specimen, structures, observations, educational
explanation, limitations, follow-up answers, and quiz questions. A VLM
is a practical fit for this natural-language multimodal workflow, though
it is not automatically more reliable than specialist CV models.

### Why not train a model?

The project's present focus is integrating and evaluating a pretrained
VLM. Training a microscopy foundation model would require substantial
expert-labelled data and compute. The project does not claim a novel
neural architecture. Specialist models such as segmentation systems
could be considered later if localization or task-specific accuracy
becomes necessary.

### Why keep Gemini behind the backend?

It keeps the API key out of the mobile app, centralizes prompts and
validation, enables controlled error handling and evaluation, and makes
the client less dependent on a particular model provider.

## 5. Backend

Structure:

``` text
backend/
  app/
    config.py            Settings (env / backend/.env)
    main.py              app, routers, AnalysisError handler
    routes/              analyze.py, ask.py, quiz.py, health.py
    schemas/             analysis.py, ask.py, quiz.py, health.py
    services/            gemini.py, images.py, errors.py
  evals/
    microscopy_eval.py
    images/
  tests/
```

Routes handle HTTP communication, schemas define data contracts, and
services contain model/application logic.

### Endpoints

  -----------------------------------------------------------------------
  Endpoint                Method                  Purpose
  ----------------------- ----------------------- -----------------------
  `/health`               GET                     Server
                                                  health/connectivity
                                                  check.

  `/analyze`              POST                    Accept image, validate
                                                  it, call Gemini, return
                                                  structured analysis.

  `/ask`                  POST                    Answer a follow-up
                                                  using
                                                  microscopy/analysis
                                                  context.

  `/quiz`                 POST                    Generate quiz questions
                                                  from analysis context.
  -----------------------------------------------------------------------

### `/analyze` request flow

1.  Receive the uploaded file (`routes/analyze.py`).
2.  `prepare_image(...)` validates and re-encodes it (see "Upload
    pipeline" below) and returns the cleaned bytes and their MIME type.
3.  `analyze_image(...)` sends those bytes to Gemini (with model
    fallback; see "Model fallback" below).
4.  Parse/validate the response against the `Analysis` schema.
5.  Return JSON to the frontend.
6.  Convert validation/provider/response failures into controlled API
    errors (`AnalysisError` → `{"detail": ...}`).

The evaluation harness reuses both service functions:

``` python
app.services.images.prepare_image(data, content_type, settings) -> tuple[bytes, str]
app.services.gemini.analyze_image(data, mime_type, settings) -> Analysis
```

Eval runs from commit `d2ea65f` onward send re-encoded, metadata-free
bytes, so they are not directly comparable with earlier runs.

### Model fallback (`GEMINI_FALLBACK_MODELS`)

`/analyze`, `/ask`, and `/quiz` share one call helper (`_generate` in
`backend/app/services/gemini.py`).

-   Optional comma-separated list of up to 3 models, tried in order after
    `GEMINI_MODEL` with the same API key (no key rotation). Entries are
    trimmed; blanks, duplicates, and the primary model are dropped. More
    than 3 entries fails startup configuration.
-   A request moves to the next model only when Gemini returns 429 /
    `RESOURCE_EXHAUSTED` (quota) or 404 / `NOT_FOUND` (model not found).
    Timeouts, transport errors, other provider errors, and empty,
    invalid, or schema-failing responses fail immediately with the usual
    status; a bad response is never retried on another model.
-   If every model fails: 503 if any attempt hit quota, otherwise 502
    (model unavailable).
-   Logs, model names only: INFO `Gemini served operation=… model=…
    fallback_used=…` and WARNING `Gemini fallback operation=…
    from_model=… to_model=… reason=quota|model_not_found`. The `app`
    logger is set to INFO with one stderr handler in `app/main.py`.
-   Evals never fall back (section 8).
-   Only list models you have verified yourself for image input and
    structured JSON output with your key. Google can retire models at any
    time; recheck the list when 404s appear.
-   Covered by mocked tests (`backend/tests/test_fallback.py`); not
    verified against real Gemini 429/404 responses.

### Analysis response contract

``` python
probable_specimen: str
visible_structures: list[str]
observations: list[str]
explanation: str
limitations: list[str]
```

-   `probable_specimen`: tentative identification, not a confirmed
    result.
-   `visible_structures`: structures the model reports as visible.
-   `observations`: image-specific descriptive statements.
-   `explanation`: educational interpretation.
-   `limitations`: uncertainty or caveats, such as focus, staining,
    magnification, image quality, or ambiguous morphology.

A valid schema guarantees shape, not biological truth.

### `/ask` and `/quiz`

`/ask` uses the existing analysis/specimen context so follow-up
questions such as "Why are they rectangular?" have a referent. Its
intended scope is educational microscopy/biology. `/quiz` uses the
analysis context to generate questions; the tested flow generated three.
Both depend on model output and should not be treated as infallible.

### Upload pipeline (`prepare_image` in `backend/app/services/images.py`)

**Resolved iPhone 415 (fixed 2026-10-03, commit `d2ea65f`):** iPhone
camera JPEGs (e.g. 2268×4032, ~1.2 MB) are detected by Pillow as format
`MPO` with two frames. The old validator mapped only `JPEG`/`PNG`/`WEBP`,
so the declared-type check returned 415 "Image content does not match
its declared type." (its single-frame check would also have rejected
them). The cause was not HEIC; the app rejects HEIC before upload.

Current steps, in order:

1.  Cheap checks: empty → 400; over `max_image_bytes` (10 MiB) → 413;
    declared type not `image/jpeg`, `image/png`, or `image/webp` → 415.
2.  Header-only checks (no full decode yet), with Pillow's
    decompression-bomb protection active:
    -   detected format must match the declared type; `MPO` counts as
        JPEG → otherwise 415;
    -   width × height within `max_image_pixels` (20,000,000) → otherwise
        413 with a message stating the limit;
    -   exactly one frame, except MPO → otherwise 415 (animated GIF, APNG,
        and animated WebP are rejected).
3.  Decode under a one-at-a-time lock. A request waits up to 5 seconds
    for the lock, then gets 503 "Server is busy…". The lock covers only
    decode and re-encode, never the Gemini call, and is released on
    every error path.
4.  Decode the first frame only (for MPO, the primary image) and apply
    EXIF orientation.
5.  Re-encode without EXIF/GPS, XMP, comments, or PNG text chunks. The
    ICC profile is kept only when the image mode is unchanged.
    -   JPEG/MPO → JPEG, quality 95; modes other than RGB/L are
        converted to RGB. This is a deliberate second lossy encode.
    -   PNG → PNG, lossless; mode kept (including P with transparency,
        LA, RGBA, and 16-bit grayscale `I;16`).
    -   WebP → WebP, lossy quality 95; modes other than RGB/RGBA are
        converted.
    -   No resizing.
6.  Re-encoded output over `max_encoded_image_bytes` (14 MiB, about
    18.7 MiB as base64, below Gemini's ~20 MB inline request limit) →
    413.
7.  Decode/encode failure → 400.

Gemini receives the re-encoded bytes with the MIME type of the output
format. Each rejection is logged at WARNING with the rule, status,
declared type (only if one of the three accepted types, otherwise
`other`/`none`), and detected format. No image content is logged.

Limitations:

-   16-bit-per-channel RGB PNGs are reduced to 8 bits per channel by
    Pillow when decoded; only 16-bit grayscale round-trips.
-   Gemini's handling of 16-bit PNG is untested.
-   Peak memory for one 20 MP image was measured on Windows at roughly
    +170–340 MiB (WebP highest); it has not been measured on Render.

## 6. Frontend and deployment

The app has been tested on a physical iPhone (latest user-reported check:
2026-10-03, against the Render backend). The image picker provides a
local file URI, which is different from an HTTP URL. The app uploads the
original file as multipart form data without converting or resizing it
(`frontend/src/services/images.ts`); HEIC and unrecognized types are
rejected in the app. The app shows loading, success, and error states.
For 400/413/415 it appends the backend's `detail` to its own message;
5xx and 422 details are intentionally never shown
(`frontend/src/services/api.ts`).

The working public backend URL is:

``` text
https://scopepilot.onrender.com
```

An earlier local configuration problem came from a stale PowerShell
variable:

``` powershell
$env:EXPO_PUBLIC_API_URL
```

It had been set to `http://192.168.137.1:8000`; removing the stale value
allowed the frontend `.env` configuration to take effect. On a physical
phone, `localhost` refers to the phone, not the development computer.
Local testing therefore needs a reachable LAN address or tunnel; the
deployed HTTPS URL avoids that issue.

## 7. Prompting, guardrails, and security

The Gemini service (`backend/app/services/gemini.py`) contains the
production analysis, Q&A, and quiz prompts. Each is passed as Gemini's
`system_instruction`. They specify the task, educational framing,
expected output, and cautious interpretation.

Prompt instructions aim to: - keep analysis educational and
microscopy-focused; - identify a *probable* specimen; - separate direct
visual observations from biological explanation; - avoid claiming
structures solely because they are normally expected; - communicate
limitations; - return the required structured fields.

### Prompt injection

Known status: backend mediation, application-level instructions, and
schema validation provide some controls, but a dedicated
prompt-injection filter has not been confirmed. Prompts alone cannot
guarantee resistance to direct injection ("ignore previous
instructions") or indirect injection (malicious text in an image). Do
not claim prompt injection is fully handled. Keep secrets out of model
context and avoid giving the model privileged tools.

### Wrong or irrelevant images

Distinguish: 1. Invalid file: deterministic backend validation can
reject it. 2. Valid but irrelevant image (e.g., selfie): it may pass
file validation and reach the VLM. Prompting may discourage unsupported
analysis, but an explicit content-domain gate has not been confirmed. 3.
Poor/ambiguous microscopy image: the model should report limitations,
but this is not guaranteed to be correct.

### Other failure classes

-   Provider error (e.g., Gemini 503): infrastructure/availability
    issue, not a quality score.
-   Malformed model output: schema validation failure.
-   Network failure: frontend should show an error rather than crash.
-   Invalid upload: reject before calling the model where possible.

## 8. Braintrust evaluation

### Purpose

The project received feedback that it could appear to be a "wrapper."
The evaluation work provides a measurable engineering component: run
controlled prompt experiments through the same analysis service, compare
outputs on a fixed set of microscopy images, and use observed trade-offs
to guide prompt decisions.

### Harness and run command

-   Braintrust project: `ScopePilot`
-   Harness: `backend/evals/microscopy_eval.py`
-   Images: `backend/evals/images/`
-   Model: the harness has no model setting of its own; it uses the
    configured `GEMINI_MODEL` (`get_settings()`). Model in the recorded
    runs: `gemini-3.1-flash-lite`, per handoff; not verifiable from the
    repository.
-   Environment variable `SCOPEPILOT_EVAL_PROMPT_VARIANT` selects the
    prompt variant; the experiment name matches it.
-   Images go through `prepare_image` before Gemini, as in production.
-   Evals are pinned to `GEMINI_MODEL`: `analyze_case` clears
    `GEMINI_FALLBACK_MODELS` and calls `analyze_image(...,
    allow_fallback=False)`, so a run never switches model. The
    experiment name is `"<variant> | <model>"` and the experiment
    metadata records `gemini_model`, `prompt_variant`, and
    `fallback: "disabled"`.
-   The harness temporarily replaces the service prompt and restores it
    in `finally`; a lock protects concurrent replacement. These are
    evaluation-only changes; production prompt is not modified by
    running an experiment.

From `backend/`:

``` powershell
$env:SCOPEPILOT_EVAL_PROMPT_VARIANT="prompt-a-naive-baseline"
.\.venv\Scripts\braintrust.exe eval evals/microscopy_eval.py
```

Valid values in the current code (`PROMPT_VARIANTS`):
`prompt-a-naive-baseline`, `prompt-b-scopepilot-production`,
`prompt-c-overconstrained`, `prompt-d-synthesized`.

These differ from the names used for the recorded results below
(`prompt-a-baseline`, `prompt-b-visibility-constrained`,
`prompt-c-educational-conservative`); the mapping between the two sets
is unreconciled. In the code, `prompt-a-naive-baseline` sends the
unchanged production prompt, and the other three append extra
instructions to it.

From repo root:

``` powershell
$env:SCOPEPILOT_EVAL_PROMPT_VARIANT="prompt-a-naive-baseline"
.\backend\.venv\Scripts\braintrust.exe eval backend/evals/microscopy_eval.py
```

### Dataset

Five cases: - `blood_smear_1.jpg` - `yeast_1.jpg` -
`onion_epidermis_1.jpg` - `cheek_1.jpg` - `plant_tissue_1.jpg`

Recorded expected annotations: - onion: `onion epidermis`; `cell wall`;
plant - blood: `blood smear`; `red blood cells`; animal - cheek:
`cheek epithelial cells`; `nucleus`, `cell membrane`; animal - yeast:
`yeast cells`; `cell wall`; fungal - plant tissue: `plant tissue`;
`cell wall`; plant

Only the onion image was visually inspected in the earlier discussion.
The remaining annotations are generic manual labels and should not be
called expert-validated ground truth.

### Scorers

1.  `specimen_accuracy_lexical`: normalized case/whitespace and
    containment-based 0/1 string comparison. It is **lexical
    consistency**, not biological accuracy; synonyms can be false
    negatives.
2.  `structure_recall`: matched expected structures / expected
    structures. It measures omissions against labels but does not
    penalize extra unsupported structures.
3.  `schema_validity`: checks that output contains exactly the five
    expected fields. It measures structure, not factual correctness.
4.  `limitation_awareness`: 1 if at least one non-empty limitation
    exists, otherwise 0. It does not assess whether the limitation is
    accurate or useful.
5.  Duration is performance, not accuracy.

### Semantic scorer attempt

An `LLMClassifier` semantic scorer was attempted to handle cases such as
`onion epidermis` versus `Allium cepa (onion) epidermal cell`. Autoevals
tried to use `gpt-4o` through Braintrust Gateway, but that provider was
not configured for the `ScopePilot` organization. The semantic scorer is
still defined in the harness (`specimen_accuracy_semantic`) but is not in
the `scores` list; do not report semantic results.

### Prompt variants

**A --- baseline / production:** the existing project-specific
production prompt, without extra evaluation-only instructions. It is a
mature baseline, not an intentionally weak prompt.

**B --- visibility-constrained:** added stronger instructions to report
only structures clearly supported by visible evidence, avoid mentioning
expected-but-unseen structures, and use limitations when image quality,
staining, magnification, focus, or field of view makes identification
uncertain.

**C --- educational-conservative:** emphasized educational use, probable
identification based on visible evidence, separation of observations
from biology explanation, avoiding hidden/non-visible/expected-only
structures, limitations for ambiguous images, and helping the student
verify rather than treating AI as ground truth.

**D --- synthesized:** combined lessons from the baseline and the more
conservative variants, aiming to retain useful caution and educational
framing without over-restricting structure reporting.

### Recorded results

As recorded in this handoff (variant names as used at the time; see the
naming note above). These runs predate the upload re-encoding change and
are not verifiable from the repository.

  -------------------------------------------------------------------------------------------
  Variant                      Limitation       Schema      Lexical    Structure     Duration
                                awareness     validity     specimen       recall 
                                                              score              
  -------------------------- ------------ ------------ ------------ ------------ ------------
  A --- baseline                     100%         100%          40%         100%      15.29 s

  B ---                              100%         100%          20%          80%      15.51 s
  visibility-constrained                                                         

  C ---                              100%         100%          20%          80%      14.88 s
  educational-conservative                                                       

  D --- synthesized                  100%         100%          40%         100%      17.06 s
  -------------------------------------------------------------------------------------------

A had an initial run with a transient Gemini 503; a subsequent run
completed successfully and the figures above refer to the completed run.
B compared with A showed −20 percentage points in lexical specimen score
and −20 points in structure recall. C compared with B showed no change
in those quality metrics. D compared with C showed +20 points in lexical
score and +20 points in structure recall. Durations are noisy and
provider-dependent.

### Interpretation

In this five-case pilot, the more conservative B/C prompts coincided
with structure recall falling from 100% to 80%. The synthesized D prompt
restored measured recall to 100%, while schema validity and limitation
awareness remained at 100%. This suggests that excessive conservatism
can omit expected structures and that prompt wording affects measured
behavior. It does **not** prove D is universally superior or that
hallucinations have been eliminated. The lexical score is too weak to be
interpreted as biological accuracy. Qualitative, per-image output review
is necessary alongside aggregate scores.

### Defensible review explanation

"I used Braintrust to compare four prompt variants on the same five
microscopy cases using the same model, service path, and deterministic
scorers. The baseline already contained project-specific instructions.
The visibility-constrained and educational-conservative variants were
more restrictive, and measured structure recall fell from 100% to 80%. I
then synthesized a prompt that retained useful caution and educational
framing without the same degree of restriction; in this pilot it
restored recall to 100%, while schema validity and limitation awareness
remained at 100%. This is a small pilot, not proof of general
superiority, and the lexical label metric has known limitations."

## 9. Evaluation limitations and improvement backlog

1.  Lexical specimen matching can mark semantically equivalent names as
    wrong; add validated synonym/ontology normalization or a semantic
    evaluator.
2.  The semantic judge is disabled because its provider was not
    configured; configure and validate an evaluator before reporting
    such scores.
3.  The five-image dataset is a pilot; expand it across specimens,
    magnifications, staining, focus, and image quality.
4.  Existing labels need faculty/biology-expert validation.
5.  Recall does not penalize extra structures; add expert-reviewed
    negative labels and precision/F1 where justified.
6.  Hallucination scoring is incomplete; unannotated does not mean
    false.
7.  Run repeated trials to quantify output variability.
8.  Separate provider failures (503/quota) from model-quality outcomes;
    consider eval-only retries for transient 503s.
9.  Braintrust token/cost fields appeared as zero; do not interpret them
    as true zero usage. Add valid provider tracing.
10. Evaluate RAG against VLM-only output once implemented.
11. Add a human rubric for educational clarity, correctness, usefulness,
    and appropriateness.
12. Measure latency/cost trade-offs with reliable telemetry.

## 10. Technical contribution and how to discuss "wrapper" criticism

Honest framing:

> ScopePilot is an evaluation-driven multimodal educational system. Its
> engineering contribution is integrating a pretrained VLM into a
> mobile-to-backend workflow, validating inputs and structured outputs,
> supporting context-aware learning interactions, and experimentally
> studying prompt-induced reliability trade-offs. It does not claim a
> novel neural architecture or clinical-grade microscopy accuracy.

If asked what remains if Gemini is removed: the current product would
lose its inference engine, but the mobile workflow, API boundary,
validation, structured contract, learning interactions, and evaluation
harness remain. The model is a replaceable component, not a model
trained by the project.

Avoid claiming: - a novel neural architecture; - hallucination-free
output; - guaranteed correct identification; - RAG verifies visual
evidence; - prompt injection is fully solved; - 100% recall means
perfect biological accuracy; - five images establish general
performance.

## 11. Useful commands

Start backend from `backend/`:

``` powershell
.\.venv\Scripts\Activate.ps1
uvicorn app.main:app --reload
```

If venv is active:

``` powershell
uvicorn app.main:app --reload
```

Local API: `http://127.0.0.1:8000`\
Swagger: `http://127.0.0.1:8000/docs`

Run tests from the repository root:

``` powershell
Push-Location backend; .\.venv\Scripts\python.exe -m pytest -q --basetemp="$env:USERPROFILE\pytest-tmp"; Pop-Location
Push-Location frontend; npm.cmd run typecheck; npm.cmd test; Pop-Location
```

Run evaluation from `backend/`:

``` powershell
$env:SCOPEPILOT_EVAL_PROMPT_VARIANT="prompt-a-naive-baseline"
.\.venv\Scripts\braintrust.exe eval evals/microscopy_eval.py
```

Known evaluation dependencies: - `braintrust==0.37.0` -
`autoevals==0.1.0` - `openai==1.109.1` - `backend/requirements-dev.txt`
includes `braintrust[cli]==0.37.0` and `autoevals==0.1.0`.

## 12. Recommended product next steps

The mobile-upload 415 and user-facing upload errors were resolved on
2026-10-03 (see section 5). Remaining:

1.  Work through "Known issues / follow-up tasks" in section 2.
2.  Add or verify explicit handling for valid but non-microscopy images.
3.  Harden and adversarially test `/ask` scope and direct/indirect
    prompt injection.
4.  Reconcile eval variant names, then review individual A/B/C/D
    outputs per image, not just aggregate scores. Re-run the eval to set
    a baseline with re-encoded images.
5.  Expand and expert-validate the dataset.
6.  Improve semantic matching and hallucination evaluation only where
    ground truth supports it.
7.  Implement and separately evaluate RAG.
8.  Evaluate educational usability with students/instructors.
9.  Keep experimental prompt changes isolated from the production
    prompt.

## 13. Instructions for Claude Code

-   Treat the repository as the source of truth; this handoff may lag
    behind later changes. `CLAUDE.md` holds the working rules.
-   Inspect relevant files and current Git state before proposing
    changes.
-   For risky changes, plan first and wait for approval before editing.
-   Keep changes precise and focused; do not touch unrelated files.
    Explain architectural trade-offs.
-   Run the relevant tests/build after edits and report results
    honestly.
-   Clearly distinguish implemented, partially implemented, and planned
    features.
-   Use the official name **ScopePilot** (not the old name MicroLens).
-   Preserve the educational, non-diagnostic scope.
-   Never call lexical matching biological accuracy.
-   Never claim prompts guarantee injection resistance or
    hallucination-free outputs.
