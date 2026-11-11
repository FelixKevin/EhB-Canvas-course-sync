# canvas-course-sync

Markdown → Canvas pages, with a generated course overview (Cursusoverzicht) on every page, syntax-highlighted code and a `ti_`-prefixed template that doesn't touch colleagues' courses.

```
content/*.md ──► render (markdown-it) ──► highlight (Shiki) ──► + overview ──► template ──► juice (inline css/style.css) ──► Canvas API
```

## Setup

```bash
npm install
cp .env.example .env          # paste a Canvas access token
# edit course.config.json: courseId, block logos, extraTocGroups
node sync.js --dry-run        # writes ./out/*.html, no Canvas calls
node sync.js                  # publish changed pages
```

Run `npm run theme`, then upload `theme-upload/canvas-upload.css` (CSS file) and `theme-upload/canvas-mobile.css` (Mobile app CSS file) in the sub-account Theme Editor. `canvas-upload.css` = `theme/existing.css` (what was already on the sub-account: Prism theme + `.gdt` rules, unchanged) + `theme/canvas-theme.css`. Edit those two, never the generated file.

Commit `canvas-map.json` (page ids, slugs and content hashes; no secrets). Never commit `.env`.

## Files per module

The [Schrijfwijzer](https://claude.ai/artifact/XCzfwcBv8Jm3rTg5NMYgv5) (chapter 17) splits each module over three files:

| File | Content | Published |
|---|---|---|
| `content/module-N.md` | Course text, with a Test jezelf after each section | Page + one quiz per Test jezelf |
| `content/module-N-oefeningen.md` | Exercises (core + extra) | Page |
| `review/module-N.md` | Notes for the reviewer: new terms, open questions, markers, content changes | Never |
| `content/images/module-N/` | Images | Course files |
| `content/files/module-N/` | Files students download (zip, pdf, xlsx, ...) | Course files |

Only `.md` files directly in `content/` are read; files whose name starts with `_` are skipped. Keep reviewer notes in `review/`.

**Markers.** `[CONTROLEREN]` and `[NIET GETEST]` stay in the course text where they apply. A page that still contains one is not published while its front matter says `published: true`; on an unpublished page the marker only gives a warning. Set other blocking markers with `blockingMarkers` in the config.

## Commands

| Command | Effect |
|---|---|
| `node sync.js --dry-run` | Build into `./out` only. Links use predicted slugs. |
| `node sync.js` | Create/adopt/rename pages as needed, then push pages whose HTML changed. |
| `node sync.js --force` | Push every page regardless of hash, e.g. after a change to `style.css`. |
| `node sync.js --only module-3.md` | Push one page (the overview still includes all pages). |
| `node sync.js --allow-missing-images` | Publish even if an image is missing or unsupported (it shows as broken). |
| `node sync.js --with-pdf` | Also build the PDF of the **published** pages, upload it and link it at the bottom of every TOC (see "PDF in the course"). |
| `npm run pdf` | Whole course as one PDF in `out/pdf/` (see "PDF of the whole course"). Never touches Canvas. |

## Front matter

```yaml
---
module: 1                       # overview group; pages with the same number are grouped
order: 1                        # order within the group
moduleTitle: "Module 1: Variabelen"   # group label (default: title of the first page in the group)
title: "..."                    # optional; default is the "# " heading
published: true                 # true/false sets Canvas publish state; false also hides it from the overview
toc: false                      # leave out of the overview entirely
tocMode: page                   # "sections" (default if the page has ## headings) or "page" (one link)
tocLabel: Oefeningen            # link text when tocMode is page
---
```

## Markdown conventions

| Markdown | HTML |
|---|---|
| `# Title` | Not rendered; used as the Canvas page title |
| `## 1.1 Wat is een variabele?` | `<div class="ti_section"><a id="1_1"></a><h3>… <a class="ti_top">Terug naar boven</a></h3>` |
| `## Titel {#eigen-id}` | Same, with your own anchor id |
| `## Oefening 3 {.hard}` | Variant header: `.letop`, `.easy`, `.hard`, `.home` (prefixed automatically) |
| `### Subtitel` | `<h5>` (see `headingMap`) |
| `---` | Dropped (sections are boxes) |
| ` ```php ` (any language Shiki knows) | Highlighted code block with a language label |
| ` ```output ` / ` ```console ` / ` ```text ` | Black-and-lime output block, no highlighting |
| `` `ping` `` | `<span class="ti_mono">` |
| `` `foreach`{.keyword} `` | `<span class="ti_keyword">` |
| Paragraph starting with `Dit betekent voor jou:` | Takeaway box with bold label (`takeawayPrefix`) |
| `::: tip` / `info` / `warning` | Callout box |
| `::: oefening` / `github` / `jsfiddle` … `:::` | Link block with logo and heading (`blocks` in the config) |
| Markdown table | `ti_table`, dark header row, zebra rows |
| `![Alt-tekst](images/router.png)` | Image, uploaded to the course's Files on publish |
| `![Alt-tekst](images/router.png "Bijschrift")` | Same, with a caption under it |
| `![Alt-tekst](images/router.png){width=480}` | Same, displayed at most 480px wide |
| `### Test jezelf 1.1 – Titel` + ` ```text ` blocks in the quiz format | A Canvas New Quiz, and a "Start de quiz" block in its place (see Test jezelf) |
| `[tekst](./module-2.md#2_1)` | Rewritten to the real Canvas URL of that page |
| Raw HTML | Passed through as-is (you write its classes yourself) |

Classes you write as `{.name}` get the `ti_` prefix automatically. Section ids come from the leading number (`1.1` → `1_1`), otherwise a slug. Keep numbering stable: student bookmarks and cross-links depend on it.

## Images

Put images next to the Markdown (for example `content/images/`) and reference them with a relative path. Block logos in `course.config.json` (`blocks.*.logo`) can be local paths too, relative to the project root (for example `assets/oefening.png`). Then the logo lives in the course itself, instead of in a course students may not be enrolled in.

On `node sync.js`:

1. **Check.** Every referenced image must exist and be a png, jpg, gif, svg or webp. Any problem stops the publish, so no page goes out with a broken image. Override with `--allow-missing-images`.
2. **Upload.** New or changed images go to the course's Files, under `course-sync/` plus the image's path in the repo (`course-sync/content/images/router.png`). Canvas's own 3-step upload is used, with `on_duplicate: overwrite`, so a changed image replaces the old file instead of creating `router-1.png`.
3. **Track.** `canvas-map.json` (`_files`) stores each image's content hash and Canvas file id. Unchanged images are not uploaded again.
4. **Link.** Pages point at `<course>/files/<id>/preview`, the same URL the Canvas editor uses. When an image changes, only the pages that show it are republished.

In a dry run, images point at the local file, so `out/*.html` previews correctly in a browser.

Options in `course.config.json`:

| Option | Default | Effect |
|---|---|---|
| `files.folder` | `course-sync` | Top folder in the course's Files |
| `files.usageRights` | `null` | Set to `own_copyright` (or `public_domain`, `used_by_permission`, `fair_use`, `creative_commons`) if the course requires copyright info before files are visible to students. Without it, uploaded images stay invisible to students in such courses |
| `files.hidden` | `false` | `true` hides the files from the Files list; students still see them in pages. Only works if "only available with link" is enabled for files in your Canvas |

Images without alt text get a warning. Write alt text for every image that carries information; screen readers and the mobile app depend on it.

## Files to download

Put downloads in `content/files/module-N/` (any folder under `content/` works) and link to them from the Markdown with a path relative to `content/`:

```markdown
Download het [startproject](files/module-1/start.zip) en pak het uit.
```

On `node sync.js` the file goes through the same steps as an image: it is checked (a missing file stops the publish, override with `--allow-missing-files`), uploaded to the course's Files under `course-sync/content/files/module-1/` with `on_duplicate: overwrite`, tracked by content hash in `canvas-map.json` (`_files`) and not uploaded again while unchanged. The link on the page becomes `<course>/files/<id>/download?download_frd=1`, so clicking it downloads the file. A changed file replaces the old one under the same id: the link stays valid and no page needs to be republished.

- **Links only.** Any link to a local file that is not a `.md` page, an anchor or a web address is treated as a file. Images keep using `![alt](images/x.png)`.
- **`files.linkStyle`** in `course.config.json`: `"download"` (default) or `"preview"` (opens Canvas's file preview, `?wrap=1`, useful for PDFs).
- **`files.hidden`, `files.usageRights`, `files.folder`** apply to images and downloads alike.
- **Dry run:** the link points at the local file, so `out/*.html` can be tested.
- **PDF:** a download link cannot work on paper. `convert-pdf.js` keeps the link text and adds "(bestand in Canvas: start.zip)", set with `fileNote` in `pdf.config.json` (`""` hides it).
- Spaces in file names do not work in Markdown links: use `-` or `_`.

## Test jezelf (Canvas New Quizzes)

A heading that starts with `Test jezelf`, followed directly by one or more ` ```text ` blocks in the Schrijfwijzer quiz format, becomes one New Quiz. On the page, the heading and the blocks are replaced by a quiz block inside the section: the title, a **Start de quiz** button and "3 vragen · telt niet mee · onbeperkt pogingen".

````markdown
### Test jezelf 1.1 – Algorithm

```text
Sectie: 1.1
Type: meerkeuze (één antwoord is juist)
Vraag: Welke instructie is ondubbelzinnig?
...
```
````

A block may hold one question or several, separated by a blank line. Each question starts with `Sectie:` (or `Type:` when there is no `Sectie:`). Text in parentheses after the type is for authors only.

### Fields per type

| Type | Fields (besides `Sectie`, `Type`, `Vraag`, optional `Code`) | Canvas type |
|---|---|---|
| `meerkeuze` | `Opties` (A. … D.), `Juist: A`, `Feedback A` … `Feedback D` | Multiple choice, feedback per answer |
| `meerdere antwoorden` | `Opties`, `Juist: A, C`, `Feedback A` … | Multiple answer, partial credit; the per-answer feedback is shown together after the attempt (Canvas has no per-answer feedback here) |
| `juist/fout` | `Juist: juist` or `fout` | True/False, shown as *Juist* / *Fout* |
| `koppelen` | `Paren:` lines `links → rechts`, optional `Afleiders:` (extra wrong answers) | Matching, partial credit |
| `ordenen` | `Volgorde:` the lines in the **correct** order | Ordering |
| `categoriseren` | `Indeling:` lines `item → categorie`, optional `Afleiders:` (items in no category) | Categorization |
| `numeriek` | `Juist: 1` · `3,5` · `1,5 ± 0,1` · `10 ± 5 %` · `190 tot 210`, several separated by `\|` | Numeric (exact, margin, range) |
| `dropdown` *(experimental)* | Blanks in `Vraag`: `[[*juist\|fout\|fout]]`, the `*` marks the right option | Fill in the blank, dropdown |
| `woordenbank` *(experimental)* | Blanks in `Vraag`: `[[woord]]`, optional `Afleiders:` | Fill in the blank, word bank |
| `invullen` *(experimental)* | `Juist: variant \| variant` (one blank after the question), or `[[a\|b]]` blanks in `Vraag` | Fill in the blank, open entry; any listed variant counts |

Every type also takes `Feedback:` (always shown after the attempt), and optionally `Feedback bij juist antwoord:` and `Feedback bij fout antwoord:`. `Code:` takes indented lines and becomes a code block under the question. Backticks and `**vet**` work in questions, options and feedback.

### What the tool does

- **Validates first.** Every question is checked before anything is sent: a known type, `Juist` matching an option, feedback for every option, a parseable number. Any problem stops the publish and names the file, the quiz and the question number. A dry run shows the same warnings.
- **Applies the Schrijfwijzer (Q7).** If a `meerkeuze` question doesn't say *Kies één antwoord*, that sentence is appended; `meerdere antwoorden` gets *Kies alle juiste antwoorden.* Turn this off with `quizzes.addAnswerHint: false`.
- **Links section references.** *zie 1.1* in feedback becomes a link to section 1.1 on its page (opens in a new tab). In the question itself it stays plain text, so students don't leave the attempt.
- **Uses Test jezelf settings.** Unlimited attempts, latest attempt kept, results with feedback and correct answers shown after each attempt, not counted towards the final grade, in an assignment group *Test jezelf* (weight 0, created if missing). Published when the page is `published: true`.
- **Keeps quizzes stable.** One quiz per heading, tracked in `canvas-map.json` (`_quizzes`), keyed by file and heading. An unchanged quiz is skipped. A changed quiz keeps its id and link: settings are updated and the questions are replaced. A quiz deleted in Canvas is created again, and the page link is updated.
- **Doesn't delete.** Removing a Test jezelf from the Markdown leaves the quiz in Canvas; the tool reports it so you can delete it there.

In a dry run, `out/quizzes/*.json` holds the exact payload per quiz, and the quiz block links to `#ti_quiz_not_published` until the quiz exists.

### Caveats

- **Editing after attempts.** Replacing questions in a quiz students already took may be refused by Canvas or may affect their earlier results. For a Test jezelf that's usually acceptable. If Canvas refuses, either edit that question in Canvas, or give the heading a new id (`### Test jezelf 1.1 – Titel {#tj-1-1-v2}`) to create a fresh quiz.
- **Renaming a heading** creates a new quiz (the key is based on the heading). Give the heading a fixed id with `{#…}` if you expect to rename it.
- **Experimental types.** Instructure documents fill-in-the-blank scoring, but not how blanks are positioned in the question. Check `dropdown`, `woordenbank` and `invullen` questions in Canvas after the first publish.
- **Ordering.** The tool sends the items in the correct order and relies on Canvas to shuffle them for students. Check this once in Student View.

Options in `course.config.json` (`quizzes`):

| Option | Default | Effect |
|---|---|---|
| `enabled` | `true` | `false` leaves Test jezelf blocks as plain code blocks |
| `headingPattern` | `^Test jezelf\\b` | Which headings start a quiz |
| `assignmentGroup` | `Test jezelf` | Assignment group for the quizzes; `null` keeps Canvas's default group |
| `omitFromFinalGrade` | `true` | "Do not count this assignment towards the final grade" |
| `pointsPerQuestion` | `1` | |
| `shuffleChoices` | `true` | Shuffle answer options, matching and categorization items |
| `multiAnswerScoring` | `PartialScore` | Or `AllOrNothing` |
| `matchingScoring` | `PartialDeep` | Or `DeepEquals` (all or nothing) |
| `addAnswerHint` | `true` | Append *Kies één antwoord.* / *Kies alle juiste antwoorden.* when missing |
| `instructions` | Dutch text | Shown at the top of every quiz |
| `metaText` | `{n} vragen · telt niet mee · onbeperkt pogingen` | Line under the button on the page |

`blocks.quiz` sets the block's `logo`, `linkText` and `linkTarget`.

## PDF of the whole course

```bash
npm install && npx playwright install chromium     # once; Chromium does the printing
npm run pdf                                          # = node convert-pdf.js -> out/pdf/<title>.pdf
node convert-pdf.js --module 1                       # only module 1 (comma separated: 1,3)
node convert-pdf.js --published-only                 # only pages with `published: true`
node convert-pdf.js --out ~/Desktop/cursus.pdf       # other output path
```

`convert-pdf.js` is separate from `sync.js`: no Canvas calls, no token, and it never reads or writes `canvas-map.json`.

- **Order:** cover, table of contents with page numbers, then per module (front matter `module`) the module page(s) followed by the exercises, in `order`. A page with `pdf: false` in its front matter is skipped. Review notes in `review/` are never included.
- **Look:** `css/style.css` (the same CSS as the Canvas pages: section banners, code blocks, callouts, tables) plus `css/pdf.css` (everything PDF-only: wide unframed body text, square banners, page breaks, cover, table of contents, quiz text). Code is highlighted by the same Shiki step as the pages. Bookmarks and internal links (`./module-1.md#1_6`) work.
- **Table of contents:** modules and their sections only; the exercise pages are not listed (`tocExercises: true` lists them).
- **Hidden blocks:** the GitHub and exercise-link blocks are left out (`hideBlocks`; add `"jsfiddle"` to hide those too, `[]` keeps all).
- **Test jezelf:** printed as numbered questions with answer boxes. **No answers and no feedback.** Matching, ordering and categorising items, and dropdown choices, are shown in a scrambled but fixed order, so the order never gives the answer.

### PDF in the course (`sync.js --with-pdf`)

`node sync.js --with-pdf` does the normal sync and additionally:

1. builds the PDF from the pages with `published: true` (a page without that key counts as unpublished, as everywhere else in the sync). The PDF is built first, so a problem (for example Chromium not installed) stops the run before anything is sent to Canvas;
2. uploads it to the course's Files under `course-sync/pdf/<title>.pdf` (`on_duplicate: overwrite`: the file keeps its id, so the link stays valid). The upload is skipped when nothing in the PDF changed since the last upload (`_pdf` in `canvas-map.json`);
3. adds **Download deze cursus (PDF)** as the last item of the course overview on every page (`pdfLinkTitle` in `course.config.json`).

The first run with `--with-pdf` republishes every page because the overview changed; later runs only republish pages whose content changed. The link stays on later runs without `--with-pdf` and points at the last uploaded PDF (the run says so). To remove the link, delete `"_pdf"` from `canvas-map.json` and run `node sync.js --force`. `--dry-run --with-pdf` builds `out/pdf/<title>.pdf` and links it from `out/*.html`.

The PDF is built with `pdf.config.json` (title, author, date, ...), exactly like `npm run pdf`. The title also decides the file name.

### pdf.config.json

All PDF settings live in `pdf.config.json` (`--config other.json` uses another file). Every key is optional.

| Key | Default | Used for |
|---|---|---|
| `title` | `Cursus` | Cover title, PDF title, file name (`out/pdf/<title>.pdf`) |
| `subtitle` | | Cover, under the title |
| `author` | | Cover, under the subtitle |
| `organisation` | | Cover, under the logo |
| `date` | `auto` | Cover, bottom left. `auto` = current month; or any text, e.g. `Academiejaar 2026-2027` |
| `edition` | | Cover, bottom right, e.g. `Versie 1.2` |
| `logo` | `null` | Cover image (png, jpg, svg) relative to the project. Chromium cannot embed `.eps`: use the PNG (`assets/ehb-logo.png`, 1063 px = about 400 dpi at 66 mm) |
| `footer` | `{title}` | Footer text, left of the page number. Placeholders: `{title}` `{subtitle}` `{author}` `{organisation}` `{date}` `{edition}` |
| `runningHeader` | `true` | Module title at the top of each page |
| `headerPrefix` | | Text in front of the module title in the running header, e.g. `{title}` gives `Netwerken · Module 1: ...` (same placeholders as `footer`) |
| `accent` | `#E30613` | Main colour of the PDF (the red of the EhB logo). Every teal of `style.css` is replaced by a shade of it, in the PDF only; the Canvas pages are untouched |
| `palette` | `{}` | Override single colours, e.g. `{"#d4560b": "#aa3300"}` (warning callout / let-op banner are orange-red by default) |
| `tocTitle` | `Inhoud` | Heading of the table of contents |
| `tocExercises` | `false` | List the exercise pages in the table of contents |
| `hideBlocks` | `["github","oefening"]` | Link blocks left out of the PDF |
| `quizNote` | | Line under each quiz; empty hides it |
| `fileNote` | `bestand in Canvas: {name}` | Added after a link to a downloadable file; empty hides it |
| `pageSize` | `A4` | `A4`, `Letter`, ... |
- The font is Lato if installed, then Inter, Segoe UI, Arial; the PDF embeds whatever the machine has.

## Styling: what lives where

| | `css/style.css` → inlined | `theme/canvas-theme.css` → sub-account theme |
|---|---|---|
| Scope | Only the generated pages | Whole sub-account; every selector starts with a `ti_` class |
| Contents | Colours, boxes, typography, code colours, overview look, float layout | Sticky overview, narrow-screen stacking, hover/focus, smooth scroll, print |
| Works in mobile app / course copies / Commons | Yes | Desktop file: no. `canvas-mobile.css` covers the app (stacked layout) |
| Change takes effect | After `node sync.js --force` | Immediately |

Rule of thumb: anything a page needs to be readable goes inline. Only pseudo-classes, media queries, `position: sticky` and `:has()` go in the theme.

Canvas' sanitizer may drop some inline properties. Publish one page to a sandbox course and compare it with the dry-run output. Anything stripped can move to the theme file, scoped to its `ti_` class.

### Palette (WCAG contrast)

| Colour | Use | Contrast |
|---|---|---|
| `#25b4b1` | Borders and accents only | 2.55:1 with white, so never behind text |
| `#167572` | Header bars with white text | 5.5:1 |
| `#0d5c5a` | Exercise blocks, table header, labels | 7.8:1 |
| `#0f6e6b` | Teal text and links on white | 6.1:1 |

### Syntax highlighting

Done at build time by Shiki (`code.theme`, default `github-dark-default`). Every token becomes `<span style="color:…">`, so no theme CSS or JavaScript is needed and it also works in the mobile app.

- **Switch theme:** change `code.theme` to any Shiki theme name (for a light theme, also change `code.background` and the `.ti_codeblock` colours).
- **Add a language label:** add an entry to `code.labels`.
- **Add a language alias:** add it to `code.aliases`.

## How publishing works

1. **Match each file to a page.** List the course's pages and match each `.md` file by its stored `page_id`. On the first run, an existing page with the **same title** is adopted, so your current pages are taken over, not duplicated. Otherwise a new page is created, unpublished unless `published: true`.
2. **Update titles first.** If a title changed, it is updated before anything else. Canvas then changes the page's URL slug, so every page is re-rendered with the new links.
3. **Sync quizzes and images.** Images are uploaded and Test jezelf quizzes are created or updated, so pages can link to them.
4. **Render every page** with its own overview: the current module is open and highlighted, and links within the page are `#anchor`s.
5. **Push only what changed.** Pages whose final HTML hash matches `canvas-map.json` are skipped, which keeps page history clean.

**The build owns these pages.** Edits made directly in Canvas are overwritten on the next publish.

## Running from GitHub Actions (optional)

```yaml
on: { push: { branches: [main], paths: ['content/**', 'css/**'] } }
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci && node sync.js
        env: { CANVAS_TOKEN: '${{ secrets.CANVAS_TOKEN }}' }
      - run: git config user.name bot && git config user.email bot@users.noreply.github.com && git commit -am "update canvas-map" || true && git push
```

The token has your full Canvas permissions, including sub-account admin. Give it an expiry date and keep it in repository secrets.

## Not handled (yet)

- Images in raw HTML (`<img src="...">`) are passed through as-is, not uploaded. Use Markdown image syntax.
- Old image files are not deleted from Canvas when you remove them from the Markdown.
- Images inside quiz questions.
- Quizzes are not deleted from Canvas when you remove them from the Markdown (they are reported).
- Module items. Pages are not added to Canvas Modules automatically.
- Deleting pages when a `.md` file is removed. This is deliberately manual.
