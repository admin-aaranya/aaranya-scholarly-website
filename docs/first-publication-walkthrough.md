# Publishing the first article

Taking one manuscript from submission to a live public article page on the
production site. About 15 minutes.

**Why do this before announcing anything.** Every stage below has been proven
in the test suite, and the whole path has been walked end to end against a
local server. What has *never* run is the same path against production
Firestore, Cloud Storage and Google Workspace mail. Those are exactly the
things a test harness cannot exercise, and exactly the things that fail in
ways nobody notices until an author is waiting.

The site is **https://journals.aaranyascholarly.com**. The old
`aaranya-scholarly.web.app` address still works and serves the same thing,
but it is no longer the canonical one — use the custom domain so what you see
matches what a reader and a search engine will see.

---

## Before you start

**Use a throwaway author account, not your own.** An author cannot review or
edit their own submission — the system blocks it deliberately — so if you
submit as `chanchalauma@gmail.com` you cannot then act as the editor on it.
Register a second account with any address you can receive mail at (a `+`
alias like `chanchalauma+testauthor@gmail.com` works and lands in the same
inbox).

**Have a real `.docx` ready.** A short one is fine — a title, a few section
headings (Introduction, Methods, Results, Discussion, References) and a
couple of paragraphs under each. It matters that it is `.docx` and not PDF:
the HTML full text can only be generated from Word.

**Expect email.** `GMAIL_ENABLED=true` and editorial notices go to
`chanchalauma@gmail.com`. You should receive mail at several points below.
Their arrival is part of what you are testing — if they do not arrive, that
is a finding, not a nuisance.

---

## 1. Submit

Register the throwaway author account, then **Submit a Manuscript**.

Fill the five steps and upload the `.docx` as the manuscript file. Put
something recognisable in the title so you can find it again.

**Checkpoint** — you should get a submission receipt, and your own inbox
should get a "new submission awaiting screening" notice.

> If no mail arrives at all, stop and tell me. Mail failures are swallowed by
> design so they cannot break the workflow, which also means they are silent.

---

## 2. Accept it

Log back in as yourself and open **Editorial Dashboard → the submission**.

For this walk, skip peer review: record **Accept and Skip Review**. (Peer
review is worth exercising separately, but it needs a second reviewer account
and adds ten minutes.)

**Checkpoint** — the stage chip changes to **Copyediting**, and the author
account gets a decision email.

---

## 3. Copyediting

The **Copyediting & Production Files** panel appears at this stage.

Upload the same `.docx` as **Final copyedited manuscript**, and tick *Ask the
author to respond*.

**Checkpoint** — the throwaway author's submission page shows the file with a
"Your response needed" flag, and they get an email. Log in as the author,
upload anything as an **Author response**, and confirm the flag clears.

This is the round-trip that had a real bug in it earlier today, so it is
worth actually doing rather than assuming.

---

## 4. Send to production, then build the galleys

Record **Send to Production**. Two new panels appear.

In **Galleys**:

1. Upload a PDF of the manuscript, labelled `PDF`.
2. Then use **Generate HTML full text**, choosing the final copyedited
   `.docx` as the source.

**Checkpoint** — two galleys listed, and the generated one reports a sensible
count of sections, paragraphs and words. If it says one section and one
paragraph, your headings were not recognised — tell me what the document
looks like and I will adjust the detection.

---

## 5. Create an issue and fill in the publication details

Go to **Issues** (top of the editorial dashboard) and create one — Volume 1,
Number 1, the current year. It starts as **Planned**, which means invisible.

Back on the submission, in **Publication Details**:

- assign it to the issue you just made
- pages: `1-8` (or whatever suits)
- leave DOI blank unless you have a real one — do not invent one
- licence: `CC BY 4.0` if that is your policy

**Checkpoint** — the panel should say **Ready to publish**. If it lists
blockers, it is telling you exactly what is missing; nothing here can be
forced past.

---

## 6. Publish, then release the issue

Record the **Publish** decision on the submission.

The article is now published but still **not public** — its issue has not
been released. Confirm that: open `/article/<id>` in a private window and you
should get a 404. That is the visibility rule doing its job.

Then go to **Issues** and **Release to public archive**.

**Checkpoint** — the author gets a "your article is published" email with a
link.

---

## 7. Verify

Run **`0-RUN-CHECK-ARTICLE.bat`** and send me `_article.txt`. It reads the
live site and reports what is actually public: the issue, the article, the
Google Scholar citation tags, the full text, and the sitemap.

Then look at the article page yourself. The things worth your eye rather than
a script:

- Does the full text read properly, with headings in the right places?
- Are the authors and affiliations right?
- Is the citation line correct?

---

## Cleaning up afterwards

If this was a throwaway article rather than a real one, do **not** leave it
public. In **Issues**, use **Withdraw from public site** — every article in
that issue goes offline immediately.

What that does not remove: the submission record, the throwaway author
account, and the issue itself remain in Firestore. There is no delete path
for submissions or accounts in the UI, by design — an editorial record is not
supposed to be casually erasable. If you want them gone, they have to be
deleted in the Firestore console (Cloud Console → Firestore → Data →
`submissions` / `users` / `issues`).

Deciding *before* you start whether this is a throwaway or your genuine first
article will save you that cleanup. If you have a real accepted paper ready,
use it and skip this section entirely.
