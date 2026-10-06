# Anime Tracker

Mobile-first static web app listing Japanese anime (TV, ONA, movies) starting in 2026–2027 or currently airing, with data from the [AniList GraphQL API](https://docs.anilist.co/). Plain `index.html`, `app.js` and `style.css`: no build step, no backend, no API keys.

## Deploy on GitHub Pages

Settings → Pages → Source: "Deploy from a branch" → pick the branch and `/ (root)`.

## How it works

- Four query runs, merged by AniList ID: **A** finished entries that started 2026–27, **B** everything releasing or on hiatus, **C** everything not yet released (kept if it starts in 2026–27 or has no date at all → "TBA"), **D** starred entries none of the runs returned, so favorites never drop out.
- About 1 request/second; slower when `X-RateLimit-Remaining` gets low; on HTTP 429 waits for `Retry-After` (60 s if the browser can't read it) and retries.
- Results cached in `localStorage` for 12 hours; ↻ forces a refresh.
- Label: Movie (format MOVIE), Sequel (has a PREQUEL relation to another anime), otherwise New.
- Airing times come from `nextAiringEpisode.airingAt`, formatted with `Intl.DateTimeFormat` in `Europe/Berlin` (DST handled by the browser). These are Japanese TV broadcast times; streaming can be later.
- Favorites (by AniList ID) and the covers setting are stored in `localStorage`. With covers off, no images are requested at all.
