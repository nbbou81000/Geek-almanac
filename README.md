# Geek Almanac — TRMNL plugin

**This day in tech history, or a random article from a 14,000-entry geek encyclopedia — on your TRMNL e-ink display. Bilingual English / French.**

[![Install on TRMNL](https://img.shields.io/badge/TRMNL-Install%20recipe-black?style=flat-square)](https://trmnl.com/recipes/446649)
![Languages](https://img.shields.io/badge/languages-EN%20%7C%20FR-blue?style=flat-square)
![Server cost](https://img.shields.io/badge/server%20cost-0%20%E2%82%AC-brightgreen?style=flat-square)
![Articles](https://img.shields.io/badge/encyclopedia-14%2C168%20articles-orange?style=flat-square)

![Geek Almanac on a TRMNL display](https://trmnl-public.s3.us-east-2.amazonaws.com/eti60wy1xzfaeah3p6outgicvjes)

---

## What it does

Geek Almanac has two display modes, chosen in the plugin settings.

### 📅 Ephemeride — this day in tech history
Shows a tech or geek event that happened on today's date: a rocket launch, the release of a console, the birth of a protocol, a famous hack…
Each event comes with its year, a short witty summary, an illustration and a QR code to the Wikipedia article.
Enter your birth year and the screen tells you how old you were at the time ("You were 22"); leave it blank and it shows how many years ago it happened.

### 📚 Encyclopedia — a random geek article
Picks one article at random from **14,168 entries** covering software, hardware, gaming, space, cybersecurity, smartphones, internet culture, companies and science.
Each article is a ~150–200 word summary written from Wikipedia, in English and in French, with an illustration and a QR code to the source.

## Settings

| Setting | Options | Notes |
|---|---|---|
| **Display Mode** | Ephemeride / Encyclopedia | |
| **Language** | English / French | Titles and article text |
| **Layout Style** | Image heavy / Balanced / Information heavy | Trades illustration size for text length |
| **Show QR Code?** | Yes / No | Links to the original Wikipedia article |
| **Birth Year** | e.g. `1985` (optional) | Ephemeride mode only |

## Installation

1. Open the recipe page: **[trmnl.com/recipes/446649](https://trmnl.com/recipes/446649)**
2. Click **Install**, choose your settings, and add it to a playlist.

That's it — no API key, no account, nothing to host.

---

## How it works

Everything is **pre-generated once and served as static JSON from GitHub Pages**. The TRMNL device never calls an AI or a live API at render time, so the plugin costs nothing to run, whatever the number of users.

```
Wikipedia (On this day + categories)
        │
        ▼
GitHub Actions (manual runs)  ──►  LLM summaries (Mistral / Gemini)  ──►  static JSON
        │
        ▼
GitHub Pages  ──►  TRMNL Polling URL  ──►  Liquid template  ──►  e-ink screen
```

### Data endpoints

| Mode | URL | Content |
|---|---|---|
| Ephemeride | `https://nbbou81000.github.io/Geek-almanac/ephemeride/MM-DD.json` | 366 files, 0–4 events per day |
| Encyclopedia | `https://nbbou81000.github.io/Geek-almanac/terms/NNNNN.json` | 14,168 files, `00000` → `14167` |

Each file is wrapped as `{"entries": [ … ]}` and stays far below TRMNL's 100 KB polling limit (largest article file ≈ 6 KB).

**Ephemeride entry**
```json
{
  "year": 2012,
  "category": "internet",
  "title_en": "Massive online protest against SOPA and PIPA in the US",
  "title_fr": "Protestation massive en ligne contre SOPA et PIPA aux États-Unis",
  "text_en": "…",
  "text_fr": "…",
  "image": "https://…",
  "wiki_url": "https://en.wikipedia.org/…"
}
```

**Encyclopedia entry**
```json
{
  "category": "software",
  "title_en": ".NET",
  "title_fr": ".NET",
  "text_en": "…",
  "text_fr": "…",
  "image": "https://upload.wikimedia.org/…",
  "wiki_url": "https://en.wikipedia.org/wiki/.NET"
}
```

When Wikipedia has no usable image, `image` points to a black-and-white category icon from [`assets/icons/`](assets/icons) (hardware, software, internet, gaming, space, science, company, culture).

### Why `{"entries": [...]}`?
TRMNL's Liquid engine reads elements of a bare JSON array, or properties of a bare root object, unreliably. Wrapping every file in an `entries` array and looping over it with `{% for %}` works consistently.

---

## Repository layout

| Path | Role |
|---|---|
| `generate.js` | Builds `ephemeride.json`: fetches Wikipedia *On this day* (EN + FR), keeps tech events, writes bilingual summaries with Gemini Flash-Lite (Mistral as fallback) |
| `fixImages.js` | Re-checks every event's `wiki_url` and image; when no confident match exists, falls back to a Wikipedia search link and the category icon rather than guessing |
| `splitEphemeride.js` | Splits `ephemeride.json` into 366 per-day files in `ephemeride/` |
| `buildTermList.js` | Crawls Wikipedia tech categories (3 levels deep) to build `terms.json`, the list of candidate articles |
| `generateEncyclopedia.js` | Writes the articles in `terms/` (Mistral primary, Gemini fallback); resumable, auto-commits every 15 articles or 4 minutes |
| `wrapTerms.js` | One-off migration wrapping article files in `{"entries": [...]}` |
| `buildEncyclopediaSite.js` | Builds `encyclopedia-index.json` and `encyclopedia-stats.json` for the website |
| `encyclopedie.html` | Static website to browse and search the whole encyclopedia |
| `manifest.json` | List of already-processed titles (makes generation resumable) |
| `assets/icons/` | Fallback category icons |
| `.github/workflows/` | One manual workflow per script |

### Workflows

All workflows are started by hand from the **Actions** tab (**Run workflow** button). None runs on a schedule: the data does not change from day to day.

| Workflow | Does | Secrets |
|---|---|---|
| Generate Ephemeride | `generate.js` | `GEMINI_API_KEY`, `MISTRAL_API_KEY` |
| Fix Missing Images | `fixImages.js` | — |
| Split Ephemeride | `splitEphemeride.js` | — |
| Generate Encyclopedia | `buildTermList.js` (if needed) + `generateEncyclopedia.js` — re-run it to continue | `GEMINI_API_KEY`, `MISTRAL_API_KEY` |
| Wrap Terms | `wrapTerms.js` | — |
| Build Encyclopedia Site | `buildEncyclopediaSite.js` | — |

---

## Browse the encyclopedia

The full encyclopedia is also readable on the web, with search and category filters:
**[nbbou81000.github.io/Geek-almanac/encyclopedie.html](https://nbbou81000.github.io/Geek-almanac/encyclopedie.html)**

## In numbers

- **14,168** encyclopedia articles, ~2.7 M words in French and ~2.4 M in English
- **8,577** with a real Wikipedia illustration, the rest with a category icon
- **677** tech history events across the 366 days of the year
- Biggest categories: space, software, gaming, hardware, cybersecurity, smartphones

## Fork it

Want your own almanac — a different theme, another language? Fork the repo, add your `GEMINI_API_KEY` and/or `MISTRAL_API_KEY` under **Settings › Secrets and variables › Actions**, edit the seed categories in `buildTermList.js` or the keyword filter in `generate.js`, then run the workflows in this order:

1. Generate Ephemeride → Fix Missing Images → Split Ephemeride
2. Generate Encyclopedia (as many times as needed) → Build Encyclopedia Site

Enable **GitHub Pages** on the `main` branch (root folder) and point your TRMNL Polling URL to your own `github.io` address.

## Credits

- Content summarised from [Wikipedia](https://www.wikipedia.org/), available under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). Each entry links back to its source article.
- Images from [Wikimedia Commons](https://commons.wikimedia.org/), under their respective licenses.
- Summaries written with [Mistral AI](https://mistral.ai/) and [Google Gemini](https://ai.google.dev/). They can contain mistakes: the QR code is there to check the original.
- Built for [TRMNL](https://trmnl.com).

## Author

Made by **Nicolas Bouteiller** — [@nbbou81000](https://github.com/nbbou81000) · nb.bouteiller@gmail.com

If you enjoy it, you can [buy me a coffee on Ko-fi](https://ko-fi.com/nicolasbouteiller) ☕

## License

Code under the MIT License — see [`LICENSE`](LICENSE). Generated text derived from Wikipedia remains under CC BY-SA 4.0.
