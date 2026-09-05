# ScopePilot Architecture

## High-Level Architecture

Microscope
↓
Smartphone
↓
Expo React Native Application
↓
FastAPI Backend
↓
Gemini VLM
↓
RAG Knowledge Retrieval
↓
Structured Educational Response
↓
Mobile Application

## Frontend Responsibilities

The frontend handles:

- image selection
- camera capture
- image preview
- API requests
- analysis result display
- follow-up question input
- quiz interface
- loading states
- error states

The frontend should NOT contain:

- Gemini API keys
- Gemini API calls
- RAG logic
- sensitive configuration

## Backend Responsibilities

The backend handles:

- image validation
- Gemini requests
- prompt construction
- structured response parsing
- follow-up Q&A
- quiz generation
- RAG retrieval
- API error handling

## Planned API

### GET /health

Returns backend status.

### POST /analyze

Input:
microscopy image

Output:

{
  "probable_specimen": "",
  "visible_structures": [],
  "observations": [],
  "explanation": "",
  "limitations": []
}

### POST /ask

Input:
- previous analysis
- student question

Output:
- answer
- sources if RAG is used

### POST /quiz

Input:
- previous analysis

Output:
- multiple-choice questions
- options
- correct answer
- explanation

## Future APIs

/history
/compare

These are NOT part of the immediate MVP.