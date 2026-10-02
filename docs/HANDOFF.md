# ScopePilot --- Product and Architecture Handoff

**Purpose:** Context handoff for Claude covering the product,
architecture, implementation, design decisions, evaluation, known
limitations, and next steps. This is a status summary; inspect the
repository for exact current code behavior.

-   **Official title:** ScopePilot: An AI-Assisted Microscopy
    Observation System Using Vision Language Models
-   **Repository:** https://github.com/frappuo/ScopePilot
-   **Public backend:** https://scopepilot.onrender.com
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

## 2. Current status

### Implemented / working as last reported

-   React Native/Expo mobile application.
-   Image selection and upload.
-   FastAPI backend and Gemini VLM integration.
-   Structured microscopy analysis response.
-   Follow-up Q&A (`/ask`).
-   Quiz generation (`/quiz`); tested flow generated three questions.
-   Image validation and backend error handling.
-   Public Render deployment at `https://scopepilot.onrender.com`.
-   Physical iPhone testing and successful app/backend connectivity.
-   Braintrust prompt-evaluation harness with four variants and
    deterministic scorers.
-   Backend test suite: 65 tests passed at the last recorded run.

### Planned, incomplete, or not verified as complete

-   Production RAG integration over a trusted biology knowledge base.
-   Larger, expert-reviewed microscopy benchmark.
-   Semantic specimen matching.
-   Structure precision/F1 and validated hallucination scoring.
-   Repeated-run robustness/statistical evaluation.
-   Complete token/cost tracing.
-   Dedicated prompt-injection filtering and adversarial testing.
-   Explicit microscopy-vs-non-microscopy content gate.
-   Clinical or diagnostic functionality (out of scope).

Do not describe planned features as implemented.

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

**Frontend:** UI, image selection/capture workflow, API requests,
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

  ChromaDB/embeddings                 RAG direction; do not claim the
                                      full production retrieval pipeline
                                      is complete without checking the
                                      current code.
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

Known structure:

``` text
backend/
  app/
    routes/
    schemas/
    services/
  evals/
    microscopy_eval.py
    images/
```

Routes handle HTTP communication, schemas define data contracts, and
services contain model/application logic. Verify exact files before
making code-level claims.

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

1.  Receive the uploaded file.
2.  Validate supported media type and other file constraints before
    model invocation where applicable.
3.  Read image bytes and pass the MIME type.
4.  Call the Gemini service.
5.  Parse/validate the response against the `Analysis` schema.
6.  Return JSON to the frontend.
7.  Convert validation/provider/response failures into controlled API
    errors.

The evaluation harness reuses this service function:

``` python
app.services.gemini.analyze_image(
    data: bytes,
    mime_type: str,
    settings: Settings,
) -> Analysis
```

Confirm current implementation in the repo before modifying it.

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

### Recent upload issue

A mobile request logged:

``` text
endpoint: https://scopepilot.onrender.com/analyze
fileSize: 3258644
hasFileName: true
mimeType: image/jpeg
uriScheme: file
response status: 415
```

415 means the backend rejected the media type at the API boundary,
likely before Gemini. The precise cause is unconfirmed. Possible causes
include the validator's accepted-type rules, a mismatch between MIME
metadata and actual bytes, or an iPhone HEIC/HEIF image represented as
JPEG. Inspect Render logs and `validate_image(...)` before changing
code; do not assume the cause.

## 6. Frontend and deployment

The app has been tested on a physical iPhone. The image picker provides
a local file URI, which is different from an HTTP URL. Image uploads use
multipart form data. The app displays the structured response and should
represent loading, success, and error states.

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

The Gemini service contains the production analysis prompt. It specifies
the task, educational framing, expected output, and cautious
interpretation. Unless the code confirms use of Gemini's
`system_instruction` parameter, call this an **application
prompt/instruction**, not necessarily a provider-level system prompt.

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
-   Model in recorded runs: `gemini-3.1-flash-lite` (confirm current
    setting before rerunning).
-   Environment variable selects prompt variant; experiment name matches
    it.
-   The harness temporarily replaces the service prompt and restores it
    in `finally`; a lock protects concurrent replacement. These are
    evaluation-only changes; production prompt is not modified by
    running an experiment.

From `backend/`:

``` powershell
$env:SCOPEPILOT_EVAL_PROMPT_VARIANT="prompt-a-baseline"
.\.venv\Scripts\braintrust.exe eval evals/microscopy_eval.py
```

Valid values: - `prompt-a-baseline` -
`prompt-b-visibility-constrained` -
`prompt-c-educational-conservative` - `prompt-d-synthesized`

From repo root:

``` powershell
$env:SCOPEPILOT_EVAL_PROMPT_VARIANT="prompt-a-baseline"
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
disabled; do not report semantic results.

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

Run evaluation from `backend/`:

``` powershell
$env:SCOPEPILOT_EVAL_PROMPT_VARIANT="prompt-a-baseline"
.\.venv\Scripts\braintrust.exe eval evals/microscopy_eval.py
```

Known evaluation dependencies: - `braintrust==0.37.0` -
`autoevals==0.1.0` - `openai==1.109.1` - `backend/requirements-dev.txt`
includes `braintrust[cli]==0.37.0` and `autoevals==0.1.0`.

## 12. Recommended product next steps

1.  Diagnose the mobile upload `415` using deployed logs and the actual
    validator. Verify real file format; do not merely relabel HEIC as
    JPEG.
2.  Improve user-facing upload validation errors.
3.  Add or verify explicit handling for valid but non-microscopy images.
4.  Harden and adversarially test `/ask` scope and direct/indirect
    prompt injection.
5.  Review individual A/B/C/D outputs per image, not just aggregate
    scores.
6.  Expand and expert-validate the dataset.
7.  Improve semantic matching and hallucination evaluation only where
    ground truth supports it.
8.  Implement and separately evaluate RAG.
9.  Evaluate educational usability with students/instructors.
10. Keep experimental prompt changes isolated from the production
    prompt.

## 13. Instructions for Claude

-   Treat the repository as the source of truth for exact implementation
    details; this handoff may lag behind later changes.
-   Inspect relevant files and current Git state before proposing code
    changes.
-   The user prefers precise prompts to feed Codex rather than manual
    editing instructions. For risky changes, provide a plan-only prompt
    first; after review, provide an implementation prompt.
-   Keep changes focused and explain architectural trade-offs.
-   Clearly distinguish implemented, partially implemented, and planned
    features.
-   Use the official name **ScopePilot** (not the old name MicroLens).
-   Preserve the educational, non-diagnostic scope.
-   Never call lexical matching biological accuracy.
-   Never claim prompts guarantee injection resistance or
    hallucination-free outputs.
