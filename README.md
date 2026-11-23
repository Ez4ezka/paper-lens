# Paper Lens

Read research papers with AI. Open any PDF, then:

- **Ask**: draw a box or a freehand shape around anything (a word, an equation, a figure, a paragraph), type your question and press Enter. The answer appears on the right, and follow-ups stack under it.
- **Highlight**: pick the highlighter and one of five colors, then drag over text, formulas or figures. Click a highlight to add a note, change its color, or ask AI about it.
- **Home page**: every paper you've read, plus every highlight from every paper in one place. Filter by color, search, group by paper or color, and export to Markdown.

It works with **Claude** (Anthropic API), **ChatGPT** (OpenAI API) or **any model on OpenRouter**. You can switch models from the menu at the top of the page at any time.

## How it works

Paper Lens is a static website (plain HTML, CSS and JavaScript, no build step), so it runs on GitHub Pages for free.

- **AI**: your browser calls the AI provider directly with **your own API key**. Keys are stored only in that browser. API usage is billed by the provider and is separate from a ChatGPT Plus or Claude Pro subscription.
- **Your library**: papers, highlights and notes are saved in the browser first (IndexedDB), so everything works offline and instantly.
- **Sync across devices** (optional): Paper Lens keeps a copy in a **private GitHub repository you own**, using a fine-grained token that can only touch that one repository:

  ```
  library/index.json          your papers (title, counts, small cover image)
  library/papers/<id>.json    highlights and notes for one paper
  library/pdfs/<id>.pdf       the PDF itself (optional, up to 45 MB each)
  ```

## Set up

1. **Add an AI key.** Open Settings (gear icon) → *AI models*. Paste a key from one or more of:
   - Claude: https://console.anthropic.com/settings/keys
   - ChatGPT: https://platform.openai.com/api-keys (OpenAI sometimes blocks calls made directly from web pages; if so, use OpenRouter)
   - OpenRouter: https://openrouter.ai/keys (one key for GPT, Claude, Gemini and more)

   Press *Load models*, then pick a model from the menu at the top.
2. **Turn on sync** (to use it on your phone and other computers). Settings → *Sync*:
   1. Create a **private** repository, for example `paper-lens-data`.
   2. Create a **fine-grained personal access token** at https://github.com/settings/personal-access-tokens/new. Under *Repository access*, choose *Only select repositories* and pick that repository. Under *Repository permissions*, set *Contents* to *Read and write*.
   3. Paste the repository (`your-name/paper-lens-data`) and the token, then press *Connect*.
3. **Set up your other devices.** Settings → *Other devices* → choose a passphrase → *Copy setup link*. Open that link on your phone and enter the passphrase. It brings over your keys, models, sync settings and colors, encrypted with the passphrase.

On a phone you can use *Add to Home Screen* so it opens like an app.

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

## Hosting it yourself

Push this folder to a GitHub repository, then go to **Settings → Pages**, set *Source* to *Deploy from a branch*, and choose `main` and `/ (root)`. The site will be at `https://<your-name>.github.io/<repo>/`.

## Privacy and security notes

- API keys and the GitHub token are stored in your browser's local storage on each device. Anyone with access to that browser profile could read them. Use a fine-grained GitHub token limited to the one data repository, and set spending limits on your AI provider accounts.
- Your data repository must be **private** if your papers or notes are private.

## Credits

PDF rendering by [PDF.js](https://mozilla.github.io/pdf.js/) (Apache 2.0, bundled in `vendor/pdfjs`). Math rendering by [MathJax](https://www.mathjax.org/) (loaded from a CDN).
