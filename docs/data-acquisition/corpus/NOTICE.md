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

**This repository is public.** Publishing the flora from here would be redistribution,
which is a different act from downloading it.

## Files

**`*.pdf` — NOT in this repository. Deliberately.** The PDFs are gitignored
(`.gitignore`) because they may not be reproduced. Download them yourself from the URL
above; drop them in this directory and everything below works. `.gitattributes` still
routes `*.pdf` to git-lfs so that *if* permission is ever obtained, 100 MB of binary
goes to LFS rather than into history, where it could not be removed without a rewrite.

`*.txt` — `pdftotext -layout` output, one file per volume. **These are tracked.** They
are the files every extraction actually reads, and they are what makes doc 03's
measurements reproducible from a clone. Derived, and regenerable once you have the PDFs:

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

## Redistribution

The repository is already public, so this is live, not hypothetical.

**The PDFs are held back** — the full work is the thing BRIT's offer covers for download
and does not license onward. **The extracted text is tracked**, which is a judgement call
worth stating plainly rather than leaving implicit: it is derived, it is what the pipeline
reads, and holding it back would make every number in doc 03 unverifiable from a clone.
It is still the book's prose, so if BRIT would rather it were not mirrored, the fix is to
drop the `*.txt` files and have each user extract their own from the PDFs — the pipeline
keeps working, only reproducibility from a clean clone is lost.

`../permission-requests.md` already drafts a request to BRIT for related reasons and is
the right place to raise this.
