# Corpus provenance and terms

## What this is

*Shinners & Mahler's Illustrated Flora of North Central Texas* — the regional flora
this project reads nativity, bloom timing, habitat, and height from.

| | |
|---|---|
| **Authors** | George M. Diggs, Jr., Barney L. Lipscomb, Robert J. O'Kennon |
| **Published** | 1999 |
| **Publisher** | Botanical Research Institute of Texas (BRIT) and Austin College |
| **Source** | <http://artemis.austincollege.edu/acad/bio/gdiggs/NCTXpdf.htm> |
| **Retrieved** | 2026-08-27 |
| **Coverage** | 2,223 species, 1,456 pages, 6 volumes |

BRIT and Austin College publish the complete work as free PDFs at the URL above.
**It remains under copyright.** It is not public domain, and no license permitting
redistribution has been located — the publishers offer it for download, which is
not the same grant.

## Files

`*.pdf` — the six volumes exactly as downloaded, unmodified. Stored via git-lfs.

`*.txt` — `pdftotext -layout` output, one file per volume. Derived, and regenerable:

```sh
for f in docs/data-acquisition/corpus/FNCT_*.pdf; do
  pdftotext -layout "$f" "${f%.pdf}.txt"
done
```

These are real embedded text, not OCR — the PDFs carry a text layer, so extraction is
lossless rather than probabilistic. That is why no OCR stack appears anywhere in this
project.

## How this project is allowed to use it

**Extract facts; never redistribute expression.** A nativity flag, a bloom month, a soil
note, a height are facts, and facts are not copyrightable. The prose that states them is.

The rule for anything derived from this corpus, per
[03-document-corpus.md](../03-document-corpus.md) §2:

- Store the **extracted value plus a page citation** — `Diggs, Lipscomb & O'Kennon 1999,
  p. 771`.
- **Never** store or emit long excerpts into `plants.csv`, any claim store, or the app.
- Short verbatim quotations in the analysis docs are for identifying and auditing the
  convention being relied on, and stay short.

Page numbers are exact: `pdftotext` emits one form-feed per page and the counts match the
page ranges in the filenames with zero drift, so
`page = first_page_in_filename + formfeed_index`.

## If redistribution ever becomes a question

If this repository is made public, or the corpus is redistributed in any other form, that
is a **separate act from downloading** and is not covered by BRIT's free-download offer.
Ask BRIT first. `../permission-requests.md` already drafts a request to BRIT for related
reasons and is the place to start.
