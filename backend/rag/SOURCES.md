# RAG reference sources

Openly licensed pages used as reference passages for follow-up questions on an experiment
(`POST /v1/experiments/{id}/ask`). Passages explain biology in general; they are never
evidence about what a student's image shows.

- One row per file in `sources/` (`<key>.md`), listed in `sources.json` with the same key, URL,
  topic and licence.
- Only CC BY and CC BY-SA, versions 2.0 to 4.0. No OpenStax material.
- Licence evidence: "page and confirmed" when the page's own licence agreed with the licence
  confirmed in `sources.json`; "confirmed by hand" when the page gave no licence signal or the
  file was written by hand. The fetch script (`python -m rag.fetch`) writes the rows of the
  pages it fetches, keeps every other row, and never overwrites a "confirmed by hand" file.
- The text of each page is shared under the licence in its row, by the author in its row.
  ScopePilot's changes are in the last column.

| key | title | author | url | licence | licence evidence | retrieved | changes |
|---|---|---|---|---|---|---|---|
