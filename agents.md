# ScopePilot Codex Instructions

## General

This repository contains ScopePilot, an AI-assisted educational microscopy application.

Read PROJECT\_CONTEXT.md and ARCHITECTURE.md before making architectural changes.

## Development Philosophy

Prioritize:

1. simplicity
2. working functionality
3. maintainability
4. clear separation of concerns

This is a university prototype with a short development deadline.

Avoid unnecessary enterprise architecture.

## Before Editing

Before modifying code:

1. Inspect the relevant files.
2. Explain the planned changes briefly.
3. Identify files that will be changed.
4. Do not modify unrelated files.

## After Editing

Always:

1. Run relevant tests/build commands.
2. Fix errors caused by the change.
3. Report files changed.
4. Report commands executed.
5. Report unresolved issues honestly.

Never claim something works unless it has been tested.

## Backend Rules

Backend uses FastAPI and Python.

Structure responsibilities separately:

* routes = HTTP/API endpoints
* schemas = Pydantic request/response models
* services = Gemini/RAG/business logic
* config = environment/configuration

Do not place Gemini API logic directly inside route handlers.

All API keys must use environment variables.

Do not hard-code secrets.

Use Pydantic models for structured responses.

## Frontend Rules

Frontend uses Expo + React Native + TypeScript.

Use functional React components.

Keep API communication in a dedicated service.

Keep screens/components simple.

Do not add state-management libraries unless necessary.

Do not implement authentication unless explicitly requested.

## AI Rules

Gemini output is not ground truth.

Do not display fake confidence percentages.

Prefer fields such as:

* probable\_specimen
* visible\_structures
* observations
* explanation
* limitations

The application is educational and must not provide medical diagnosis.

## Current MVP Priority

Build in this order:

1. Backend health endpoint
2. Gemini image-analysis service
3. /analyze endpoint
4. Frontend image picker
5. Image upload
6. Structured result screen
7. Follow-up questions
8. Quiz generation
9. Basic RAG
10. Camera capture
11. UI polish

Do not work on future features before these are functional.


\## Secrets



Never read, print, log, copy, expose, or include the contents of .env files or secret values.



Treat backend/.env as user-managed secret configuration.



Use only the environment variable name GEMINI\_API\_KEY in code.



Do not include secrets in:

\- source code

\- tests

\- logs

\- README files

\- commits

\- generated documentation



Do not inspect backend/.env.

