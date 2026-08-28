# Permission requests — drafts

Two outbound requests identified by [nl-41o.2](02-source-inventory.md) and
[nl-41o.3](01-goals-and-required-fields.md). Both gate real work and both are cheap to send.

**Not sent yet.** Verify the contact routing below is still current before sending.

Design notes on both drafts: they lead with the ask, state the *boundary* concretely
(facts, not prose — this is what makes a yes easy to give), and make a "no" easy to say.
Neither overstates what the project is.

---

## 1. BRIT — Illustrated Flora of North Central Texas

**Why it matters:** the flora supplies **nativity**, the field BONAP's terms put out of
reach and USDA does not publish. It resolves the desert-willow-vs-Mexican-plum case
outright. Highest-value permission of the two.

**Send to:** `info@brit.org` — BRIT's general address. The flora is a joint BRIT
Press / Austin College publication, so Austin College is a reasonable alternative or CC if
BRIT redirects. Avoid mailing a named individual first; a general address routes better.

**Standing:** the PDFs are published free by the publisher itself, and © 1999 BRIT and
Austin College with no licence granted. Fact extraction is defensible without asking — this
email is to be a good citizen and to get the citation form right, not because the work is
blocked on it.

> **Subject:** Extracting factual data from the online Illustrated Flora of North Central Texas
>
> Hello,
>
> I'm working on a small non-commercial personal project — a web tool for designing a
> native-plant landscape for my own yard in Dallas. There's no revenue involved. The code
> and its data files are public on GitHub.
>
> I'd like to ask about the online PDFs of *Shinners & Mahler's Illustrated Flora of North
> Central Texas*, which BRIT and Austin College make freely available at
> <http://artemis.austincollege.edu/acad/bio/gdiggs/NCTXpdf.htm>.
>
> **What I'd like to do:** extract discrete factual values per species — whether a species
> is native to the region or introduced and naturalized, bloom months, and habitat and soil
> notes — into a structured dataset, with every value carrying a citation back to the flora.
>
> **What I would not do:** reproduce the species descriptions, the identification keys, or
> the illustrations. Short factual values only, never the text they came from.
>
> Two questions:
>
> 1. Is that use acceptable to BRIT?
> 2. If so, how would you prefer the flora be cited?
>
> I'm glad to share what I build, and equally glad to drop this if the answer is no.
>
> Thank you for putting the flora online — for someone trying to tell a local native from a
> naturalized escape, it is far and away the most useful regional resource I've found.
>
> John Syrinek
> Dallas, TX

---

## 2. LBJ Wildflower Center — NPIN

**Why it matters:** NPIN publishes month-precision bloom, **light requirement as a set**
(the only source that does), deer resistance, species-level larval hosts, and commercial
availability. It also keys on USDA symbols, so it joins to everything else for free.

**Send via:** the contact form at <https://www.wildflower.org/contact> — the Center
publishes no direct address, and the form has a category dropdown including **"Native
Plant Database & Images"**, which is the correct routing. Phone: 512.232.0100.

**Why this one is genuinely needed, unlike BRIT's:** the terms of use could not be read at
all. `robots.txt` and the site policy pages return a Cloudflare challenge or 403 while
species pages serve normally. Saying that plainly is the strongest part of the message —
it shows the block was respected rather than circumvented.

> **Subject:** NPIN — terms and acceptable request rate for a small non-commercial project
>
> Hello,
>
> I'm building a small non-commercial personal tool for designing a native-plant garden in
> my own yard in Dallas. There's no revenue involved, and the code and data are public on
> GitHub.
>
> I'd like to use a handful of fields from NPIN species pages — light requirement, bloom
> time, water use, soil description, commercial availability, and larval host — for roughly
> 500 North Central Texas species, fetching each species page once and caching the result
> rather than re-requesting it.
>
> I tried to read your terms of use before writing, and couldn't: `/robots.txt` and the
> site policy pages return a Cloudflare challenge or a 403, while the plant database pages
> themselves load normally. Rather than guess at the terms or work around the block, I'd
> rather just ask.
>
> Three questions:
>
> 1. Is that use acceptable?
> 2. What request rate would you consider polite? I'd plan on one request every few
>    seconds unless you'd prefer slower.
> 3. Is there a bulk export, data file, or API I should be using instead of fetching pages?
>
> I'm happy to attribute NPIN however you prefer, and happy to drop it if the answer is no.
>
> Thanks for maintaining the database — the light-requirement and larval-host fields in
> particular are things I haven't found published anywhere else.
>
> John Syrinek
> Dallas, TX

---

## Deliberately not sent yet: BONAP

BONAP's terms require advance written permission for reuse of "biological attribute
information", which covers a nativity column exactly. An email would cost nothing and a yes
would give county-level nativity.

**But hold it** until the flora extraction in nl-41o.3 is verified against
`dfw-avoid-non-natives.csv`. If the flora's editorial convention holds, the project gets
regional nativity from a source that is already free, already downloaded, and dependent on
nobody's permission. Not needing an answer beats getting one — and if the extraction fails,
the BONAP request is still there to send, better informed about exactly what is missing.
