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
| blood-smear | Blood smear | Wikipedia contributors | https://en.wikipedia.org/wiki/Blood_smear | CC BY-SA 4.0 | page and confirmed | 2026-10-27 | Converted to Markdown; reference and navigation sections removed; split into passages for retrieval. |
| epidermis-botany | Epidermis (botany) | Wikipedia contributors | https://en.wikipedia.org/wiki/Epidermis_(botany) | CC BY-SA 4.0 | page and confirmed | 2026-10-27 | Converted to Markdown; reference and navigation sections removed; split into passages for retrieval. |
| ground-tissue | Ground tissue | Wikipedia contributors | https://en.wikipedia.org/wiki/Ground_tissue | CC BY-SA 4.0 | page and confirmed | 2026-10-27 | Converted to Markdown; reference and navigation sections removed; split into passages for retrieval. |
| kaiser-yeasts | 8.2: Yeasts | Gary Kaiser | https://bio.libretexts.org/Bookshelves/Microbiology/Microbiology_(Kaiser)/Unit_4%3A_Eukaryotic_Microorganisms_and_Viruses/08%3A_Fungi/8.2%3A_Yeasts | CC BY 4.0 | page and confirmed | 2026-10-27 | Converted to Markdown; reference and navigation sections removed; split into passages for retrieval. |
| optical-microscope | Optical microscope | Wikipedia contributors | https://en.wikipedia.org/wiki/Optical_microscope | CC BY-SA 4.0 | page and confirmed | 2026-10-27 | Converted to Markdown; reference and navigation sections removed; split into passages for retrieval. |
| oral-mucosa | Oral mucosa | Wikipedia contributors | https://en.wikipedia.org/wiki/Oral_mucosa | CC BY-SA 4.0 | page and confirmed | 2026-10-27 | Converted to Markdown; reference and navigation sections removed; split into passages for retrieval. |
| plant-cell | Plant cell | Wikipedia contributors | https://en.wikipedia.org/wiki/Plant_cell | CC BY-SA 4.0 | page and confirmed | 2026-10-27 | Converted to Markdown; reference and navigation sections removed; split into passages for retrieval. |
| red-blood-cell | Red blood cell | Wikipedia contributors | https://en.wikipedia.org/wiki/Red_blood_cell | CC BY-SA 4.0 | page and confirmed | 2026-10-27 | Converted to Markdown; reference and navigation sections removed; split into passages for retrieval. |
| saccharomyces-cerevisiae | Saccharomyces cerevisiae | Wikipedia contributors | https://en.wikipedia.org/wiki/Saccharomyces_cerevisiae | CC BY-SA 4.0 | page and confirmed | 2026-10-27 | Converted to Markdown; reference and navigation sections removed; split into passages for retrieval. |
| staining | Staining | Wikipedia contributors | https://en.wikipedia.org/wiki/Staining | CC BY-SA 4.0 | page and confirmed | 2026-10-27 | Converted to Markdown; reference and navigation sections removed; split into passages for retrieval. |
| stratified-squamous-epithelium | Stratified squamous epithelium | Wikipedia contributors | https://en.wikipedia.org/wiki/Stratified_squamous_epithelium | CC BY-SA 4.0 | page and confirmed | 2026-10-27 | Converted to Markdown; reference and navigation sections removed; split into passages for retrieval. |
| vascular-tissue | Vascular tissue | Wikipedia contributors | https://en.wikipedia.org/wiki/Vascular_tissue | CC BY-SA 4.0 | page and confirmed | 2026-10-27 | Converted to Markdown; reference and navigation sections removed; split into passages for retrieval. |
| white-blood-cell | White blood cell | Wikipedia contributors | https://en.wikipedia.org/wiki/White_blood_cell | CC BY-SA 4.0 | page and confirmed | 2026-10-27 | Converted to Markdown; reference and navigation sections removed; split into passages for retrieval. |
