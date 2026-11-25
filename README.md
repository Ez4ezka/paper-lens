# Paper Lens

Read research papers with AI. Open any PDF, then:

- **Ask**: draw a box or a freehand shape around anything (a word, an equation, a figure, a paragraph), type your question and press Enter. The answer appears on the right, and follow-ups stack under it.
- **Highlight**: pick the highlighter and one of five colors, then drag over text, formulas or figures. Click a highlight to add a note, change its color, or ask AI about it.
- **Home page**: every paper you've read, plus every highlight from every paper in one place. Filter by color, search, group by paper or color, and export to Markdown.
- **Overview** (a tab beside your notes in each paper):
  - **AI summary**: what the paper is about, its main claim, each of its main parts with page numbers, key results, limitations and terms to know.
  - **AI dissection**: see-through colored boxes over the pages that show how the paper is built (title, abstract, problem, **thesis**, background, method, setup, results, discussion, limitations, conclusion, references), with the thesis sentence outlined. Click a part in the list to jump to it, or a label on the page to read what that part does. Paper Lens splits each page into text blocks itself and the AI only says which blocks form which part, so the boxes line up with the real text.
  - Both are saved with the paper and sync to your other devices.
- **Light and dark**: white and blue, or black and neon blue. It follows your device until you pick one with the theme button at the top.
- **Questions**: every question you've asked, from every paper, on the home page. Each one gets a short topic from AI after its first answer (using a small, cheap model from the same provider when one is in your menu), so related questions from different papers sit together. Star (☆) questions to save them for later, filter by topic, paper or saved, search the questions and answers, click a topic to change it, and export to Markdown. *Sort with AI* tags any older questions that don't have a topic yet.

It works with **Claude** (Anthropic API), **ChatGPT** (OpenAI API) or **any model on OpenRouter**. You can switch models from the menu at the top of the page at any time, and your library is saved to the cloud so it's the same on every device.

## How it works

Paper Lens runs on **Vercel**: a static front end plus a few small server functions in `api/`.

- **Sign-in**: one password (the `APP_PASSWORD` environment variable). Sign in on any device to see the same library.
- **Your library** lives in a **private Vercel Blob store**: PDFs, highlights, notes and preferences. Each device also keeps a local copy, so it opens instantly and works offline, then syncs.

  ```
  library/index.json          your papers (title, small cover image)
  library/papers/<id>.json    highlights and notes for one paper
  library/pdfs/<id>.pdf       the PDF (stored in parts if it is over 3.5 MB)
  library/prefs.json          model choices, colors, answer style
  config/secrets.json         your AI keys (never sent to the browser)
  ```
- **AI**: the browser sends your question to `/api/ai`, which adds your saved API key and streams the answer back from Claude, OpenAI or OpenRouter. API use is billed by the provider, separately from a ChatGPT Plus or Claude Pro subscription.
- **Free-plan limits**: Vercel's Hobby plan includes 1 GB of Blob storage and about 2,000 writes a month, so changes are saved in batches (about every 45 seconds, and whenever you leave the page).

## Set up

1. Open the site and sign in with your password.
2. Settings (gear icon) → *AI models*: paste a key from Claude (https://console.anthropic.com/settings/keys), OpenAI (https://platform.openai.com/api-keys) or OpenRouter (https://openrouter.ai/keys) and press *Save*. Pick a model from the menu at the top.
3. On your phone, open the same address and sign in. Use *Add to Home Screen* so it opens like an app.

## Deploying your own copy

1. Import this repository into Vercel (no build step, no framework).
2. Create a **private** Blob store and connect it to the project.
3. Add an environment variable `APP_PASSWORD` (your sign-in password). Optionally add `SESSION_SECRET` (a long random string). Changing either one signs out every device.

## Keyboard shortcuts (in a paper)

| Key | Action |
| --- | --- |
| `A` | Ask tool |
| `M` | Highlighter |
| `H` | Scroll tool |
| `B` / `F` | Box / freehand shape |
| `1`–`5` | Highlight color |
| `+` / `-` | Zoom |
| `Enter` | Send the question |
| `Esc` | Cancel the selection |

## Privacy and security notes

- Everything is stored in a private Blob store that only the server functions can read, and only after sign-in.
- Choose a strong password. Changing `APP_PASSWORD` (or `SESSION_SECRET`) signs out every device.

## Credits

PDF rendering by [PDF.js](https://mozilla.github.io/pdf.js/) (Apache 2.0, bundled in `vendor/pdfjs`). Math rendering by [MathJax](https://www.mathjax.org/) (loaded from a CDN).
