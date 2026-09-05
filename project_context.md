# ScopePilot Project Context

## Project Name
ScopePilot

## Project Type
BCSE497J Project-I

## Project Goal
ScopePilot is an AI-assisted microscopy learning system designed for biology education.

The system augments an existing conventional optical microscope rather than replacing it.

A smartphone captures or uploads an image viewed through the microscope. The image is analyzed by a Vision-Language Model and the system provides structured educational assistance.

## Problem

Students using microscopes often have difficulty:
- identifying specimens
- recognizing visible biological structures
- understanding observations
- obtaining immediate guidance during laboratory work

Conventional microscopes provide visual access to specimens but do not provide interactive educational assistance.

## Core Principle

ScopePilot is an assistive educational tool.

It does NOT:
- perform medical diagnosis
- replace instructors
- treat AI output as ground truth
- assume model-generated confidence is calibrated

The student/human remains responsible for verification.

## Core Architecture

Conventional Microscope
→ Smartphone Camera
→ React Native / Expo Mobile App
→ FastAPI Backend
→ Gemini Vision-Language Model
→ RAG
→ Structured Educational Response
→ Student Verification

## Current AI Choice

Gemini is currently the primary Vision-Language Model.

Gemini and Qwen were previously compared on microscopy images.

Model training and custom classifiers are NOT part of the current MVP.

## MVP Features

1. Capture or upload microscopy image
2. Analyze microscopy image using Gemini
3. Return structured microscopy observations
4. Display probable specimen
5. Display visible biological structures
6. Provide educational explanation
7. Communicate limitations 
8. Allow follow-up questions
9. Generate quizzes
10. Use RAG to ground educational explanations

## Future Features

- image history
- comparison between microscope images
- custom microscopy VLM
- Soup-based fine-tuning
- classifier/reliability models
- advanced uncertainty calibration
- user accounts
- real-time microscope video

Do not implement future features unless explicitly requested.

## Technology Stack

Frontend:
- React Native
- Expo
- TypeScript

Backend:
- Python
- FastAPI
- Pydantic

AI:
- Gemini API

RAG:
- simple vector retrieval initially
- trusted biology material such as OpenStax Biology

Development:
- Git
- GitHub
- VS Code
- Codex

## Current Deadline

A working 60–70% prototype must be demonstrated within four days.

Prioritize working functionality over architectural complexity.