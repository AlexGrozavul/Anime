'use strict';

// ---------- Config ----------
const API_URL = 'https://graphql.anilist.co';
const TZ = 'Europe/Berlin';
const YEAR_FROM = 2026;
const YEAR_TO = 2027;
const CACHE_KEY = 'animeTracker.cache.v1';
const FAVS_KEY = 'animeTracker.favorites';
const COVERS_KEY = 'animeTracker.covers';
const COVER_OVERRIDES_KEY = 'animeTracker.coverOverrides'; // { [anilistId]: true|false }, beats the global switch
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const MIN_GAP_MS = 1000;      // at most ~1 request per second
const SLOW_GAP_MS = 3000;     // when X-RateLimit-Remaining is getting low
const LOW_REMAINING = 10;
const MAX_RETRIES = 6;

const QUERY = `
query ($page: Int, $perPage: Int, $status: [MediaStatus], $from: FuzzyDateInt, $to: FuzzyDateInt, $ids: [Int]) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { hasNextPage lastPage }
    media(type: ANIME, format_in: [TV, ONA, MOVIE], countryOfOrigin: "JP", isAdult: false,
          status_in: $status, startDate_greater: $from, startDate_lesser: $to, id_in: $ids,
          sort: [START_DATE, ID]) {
      id format status season seasonYear
      title { romaji english }
      coverImage { large }
      startDate { year month day }
      endDate { year month day }
      nextAiringEpisode { airingAt episode }
      externalLinks { site url type }
      relations { edges { relationType node { id type } } }
    }
  }
}`;

// Runs are merged by AniList ID. Run D (favorites) is added at fetch time.
const RUNS = [
  // A: released entries that started in 2026–2027 (20259999 includes year-only "2026-00-00")
  { key: 'A', name: 'Released 2026–27', vars: { status: ['FINISHED'], from: 20259999, to: 20280000 } },
  // B: everything currently airing or on hiatus, whenever it started
  { key: 'B', name: 'Airing', vars: { status: ['RELEASING', 'HIATUS'] } },
  // C: all upcoming; filtered client-side to 2026–27 or fully undated (TBA)
  { key: 'C', name: 'Upcoming', vars: { status: ['NOT_YET_RELEASED'] } },
];

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
const MONTHS_SHORT = MONTHS.map(m => m.slice(0, 3));
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const SEASON_NAME = { WINTER: 'Winter', SPRING: 'Spring', SUMMER: 'Summer', FALL: 'Fall' };
const SEASON_MONTH = { WINTER: 1, SPRING: 4, SUMMER: 7, FALL: 10 };
const STATUS_TEXT = { NOT_YET_RELEASED: 'Upcoming', RELEASING: 'Airing', HIATUS: 'On hiatus', FINISHED: 'Released', CANCELLED: 'Cancelled' };
const STATUS_GROUP = { NOT_YET_RELEASED: 'upcoming', RELEASING: 'airing', HIATUS: 'airing', FINISHED: 'released', CANCELLED: 'cancelled' };
const SECTIONS = [
  { key: 'airing', title: 'Airing' },
  { key: 'upcoming', title: 'Upcoming' },
  { key: 'released', title: 'Released' },
  { key: 'cancelled', title: 'Cancelled' }, // only starred entries ever get here
];

// ---------- Storage helpers (localStorage can throw or be unavailable) ----------
function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}

function sanitizeOverrides(o) {
  const out = {};
  if (o && typeof o === 'object') for (const [id, v] of Object.entries(o)) if (typeof v === 'boolean') out[id] = v;
  return out;
}

// ---------- State ----------
const state = {
  items: [],
  updatedAt: null,
  loading: false,
  filter: 'all',
  favOnly: false,
  query: '',
  covers: load(COVERS_KEY, true) !== false,
  coverOverrides: sanitizeOverrides(load(COVER_OVERRIDES_KEY, {})),
  favs: new Set(load(FAVS_KEY, [])),
  diag: null,
};

// Diagnostics for the load in progress (shown at the bottom of the page).
let stats = null;
function newStats() {
  return { startedAt: Date.now(), ms: 0, requests: 0, pageSizes: [], headersReadable: false, count429: 0, runs: { A: 0, B: 0, C: 0, D: 0 }, error: null };
}

// ---------- Fetching ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));
let nextAllowedAt = 0;

class ComplexityError extends Error {}

function parseRetryAfter(headers) {
  const v = headers.get('Retry-After');
  if (v) {
    const secs = Number(v);
    if (Number.isFinite(secs)) return Math.max(1, secs) * 1000 + 500;
    const date = Date.parse(v);
    if (!Number.isNaN(date)) return Math.max(1000, date - Date.now() + 500);
  }
  const reset = Number(headers.get('X-RateLimit-Reset'));
  if (reset > 0) return Math.max(1000, reset * 1000 - Date.now() + 500);
  return 60000;
}

// Spaces requests out; slows down when AniList says few requests remain.
// (If the browser can't read these headers, we just stay at the 1/s pace.)
function scheduleNext(headers) {
  const remaining = headers.get('X-RateLimit-Remaining');
  let gap = MIN_GAP_MS;
  if (remaining != null && remaining !== '') {
    const left = Number(remaining);
    if (left <= 1) {
      const reset = Number(headers.get('X-RateLimit-Reset'));
      gap = reset > 0 ? Math.max(MIN_GAP_MS, reset * 1000 - Date.now() + 500) : 60000;
    } else if (left < LOW_REMAINING) {
      gap = SLOW_GAP_MS;
    }
  }
  nextAllowedAt = Date.now() + gap;
}

async function waitWithCountdown(ms, label) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    setProgress(`${label} — waiting ${Math.ceil((end - Date.now()) / 1000)}s…`);
    await sleep(Math.min(1000, end - Date.now()));
  }
}

async function gql(variables, progress) {
  for (let attempt = 0; ; attempt++) {
    const wait = nextAllowedAt - Date.now();
    if (wait > 0) {
      if (wait > 2500) await waitWithCountdown(wait, 'Slowing down for AniList rate limit');
      else await sleep(wait);
    }
    if (stats) stats.requests++;
    progress();
    let res;
    try {
      res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ query: QUERY, variables }),
      });
    } catch (e) {
      nextAllowedAt = Date.now() + MIN_GAP_MS;
      if (attempt < 3) { await sleep(2000 * 2 ** attempt); continue; }
      throw new Error('Network error — could not reach AniList.');
    }
    scheduleNext(res.headers);
    if (stats && (res.headers.get('X-RateLimit-Remaining') != null || res.headers.get('X-RateLimit-Limit') != null)) stats.headersReadable = true;

    if (res.status === 429) {
      if (stats) stats.count429++;
      if (attempt >= MAX_RETRIES) throw new Error('AniList rate limit keeps rejecting requests. Try again later.');
      const ms = parseRetryAfter(res.headers);
      nextAllowedAt = Date.now() + ms;
      await waitWithCountdown(ms, 'AniList rate limit hit');
      continue;
    }
    const json = await res.json().catch(() => null);
    const errors = json && json.errors;
    if (errors && errors.some(e => /complex/i.test(e.message || ''))) throw new ComplexityError(errors[0].message);
    if (res.status >= 500 && attempt < 3) { await sleep(2000 * 2 ** attempt); continue; }
    if (!res.ok || !json || errors || !json.data) {
      const msg = (errors && errors[0] && errors[0].message) || `HTTP ${res.status}`;
      throw new Error(`AniList error: ${msg}`);
    }
    return json.data.Page;
  }
}

async function fetchRun(vars, onPage) {
  let perPage = 50;
  for (;;) {
    try {
      const media = [];
      for (let page = 1; ; page++) {
        const data = await gql({ ...vars, page, perPage }, () => onPage(page, media.length));
        media.push(...data.media);
        if (!data.pageInfo.hasNextPage) {
          if (stats) stats.pageSizes.push(perPage);
          return media;
        }
      }
    } catch (e) {
      // Query too complex for AniList at this page size: retry the run with smaller pages.
      if (e instanceof ComplexityError && perPage > 10) { perPage = Math.floor(perPage / 2); continue; }
      throw e;
    }
  }
}

async function fetchAll() {
  const byId = new Map();
  const progress = (name) => (page) => {
    setProgress(`Loading ${name} (page ${page}) · ${stats.requests} requests · ${byId.size} titles`);
  };
  for (const run of RUNS) {
    const media = await fetchRun(run.vars, progress(run.name));
    stats.runs[run.key] = media.length;
    for (const m of media) byId.set(m.id, m);
  }
  // D: starred entries that the runs above didn't return, so favorites never disappear.
  const missingFavs = [...state.favs].filter(id => !byId.has(id));
  if (missingFavs.length) {
    const media = await fetchRun({ ids: missingFavs }, progress('Favorites'));
    stats.runs.D = media.length;
    for (const m of media) byId.set(m.id, m);
  }
  // Out-of-scope entries (incl. cancelled ones) are only kept while starred.
  return [...byId.values()].map(normalize).filter(it => it && (it.inScope || state.favs.has(it.id)));
}

// ---------- Normalisation ----------
function inYearRange(y) { return y >= YEAR_FROM && y <= YEAR_TO; }

function isInScope(m) {
  switch (m.status) {
    case 'RELEASING':
    case 'HIATUS':
      return true;
    case 'FINISHED':
      return inYearRange(m.startDate && m.startDate.year);
    case 'NOT_YET_RELEASED': {
      const y = (m.startDate && m.startDate.year) || m.seasonYear;
      return !y || inYearRange(y); // fully undated → TBA
    }
    default:
      return false;
  }
}

function labelFor(m) {
  if (m.format === 'MOVIE') return 'Movie';
  const edges = (m.relations && m.relations.edges) || [];
  const hasPrequel = edges.some(e => e.relationType === 'PREQUEL' && e.node && e.node.type === 'ANIME');
  return hasPrequel ? 'Sequel' : 'New';
}

function safeUrl(u) {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch { return null; }
}

function normalize(m) {
  if (!STATUS_GROUP[m.status]) return null;
  const seen = new Set();
  const links = [];
  for (const l of m.externalLinks || []) {
    const url = l && l.type === 'STREAMING' ? safeUrl(l.url) : null;
    if (!url || seen.has(l.site)) continue;
    seen.add(l.site);
    links.push({ site: l.site, url });
  }
  const t = m.title || {};
  return {
    id: m.id,
    title: t.english || t.romaji || `#${m.id}`,
    romaji: t.romaji || '',
    format: m.format,
    status: m.status,
    label: labelFor(m),
    cover: (m.coverImage && m.coverImage.large) || null,
    start: m.startDate || {},
    end: m.endDate || {},
    season: m.season,
    seasonYear: m.seasonYear,
    next: m.nextAiringEpisode ? { at: m.nextAiringEpisode.airingAt, ep: m.nextAiringEpisode.episode } : null,
    links,
    inScope: isInScope(m),
  };
}

// ---------- Dates & times ----------
function fmtFuzzy(d, season, seasonYear) {
  if (d && d.year && d.month && d.day) return `${d.day} ${MONTHS_SHORT[d.month - 1]} ${d.year}`;
  if (d && d.year && d.month) return `${MONTHS[d.month - 1]} ${d.year}`;
  if (season && seasonYear && (!d || !d.year || d.year === seasonYear)) return `${SEASON_NAME[season]} ${seasonYear}`;
  if (d && d.year) return String(d.year);
  return 'TBA';
}

const berlinFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, weekday: 'long', day: 'numeric', month: 'numeric',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
function berlinParts(unixSeconds) {
  const p = {};
  for (const { type, value } of berlinFmt.formatToParts(new Date(unixSeconds * 1000))) p[type] = value;
  return {
    weekday: p.weekday,
    weekdayIdx: WEEKDAYS.indexOf(p.weekday),
    day: Number(p.day),
    month: Number(p.month),
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
  };
}
const pad2 = n => String(n).padStart(2, '0');

function airingText(item) {
  if (!item.next) return null;
  const p = berlinParts(item.next.at);
  const time = `${pad2(p.hour)}:${pad2(p.minute)}`;
  const when = `${p.weekday.slice(0, 3)} ${p.day} ${MONTHS_SHORT[p.month - 1]}`;
  const aired = item.next.at * 1000 <= Date.now();
  return `${p.weekday}s ${time} · Ep ${item.next.ep} ${aired ? 'aired' : 'on'} ${when}`;
}

function datesText(item) {
  switch (STATUS_GROUP[item.status]) {
    case 'released': {
      const s = fmtFuzzy(item.start, item.season, item.seasonYear);
      const e = fmtFuzzy(item.end);
      return s === e ? s : `${s} – ${e}`;
    }
    case 'upcoming': {
      const s = fmtFuzzy(item.start, item.season, item.seasonYear);
      return s === 'TBA' ? 'Start: TBA' : `Starts ${s}`;
    }
    case 'cancelled': {
      const s = fmtFuzzy(item.start, item.season, item.seasonYear);
      return item.end && item.end.year ? `${s} – ${fmtFuzzy(item.end)}` : `Planned start: ${s}`;
    }
    default:
      return `Started ${fmtFuzzy(item.start, item.season, item.seasonYear)}`;
  }
}

// ---------- Sorting ----------
const fuzzyNum = d => (d && d.year ? d.year * 10000 + (d.month || 0) * 100 + (d.day || 0) : 0);

function upcomingKey(item) {
  const d = item.start || {};
  const y = d.year || item.seasonYear;
  if (!y) return Infinity; // TBA last
  if (d.year && d.month && d.day) return y * 10000 + d.month * 100 + d.day;
  if (d.year && d.month) return y * 10000 + d.month * 100 + 32;            // after exact dates that month
  if (item.season && (!d.year || d.year === item.seasonYear)) return y * 10000 + SEASON_MONTH[item.season] * 100 + 33;
  return y * 10000 + 1300;                                                  // year only: end of year
}

function airingKey(item) {
  if (!item.next) return Infinity; // no scheduled episode → last
  const p = berlinParts(item.next.at);
  return p.weekdayIdx * 1440 + p.hour * 60 + p.minute;
}

const byTitle = (a, b) => a.title.localeCompare(b.title);
const SORTERS = {
  airing: (a, b) => airingKey(a) - airingKey(b) || byTitle(a, b),
  upcoming: (a, b) => {
    const ka = upcomingKey(a), kb = upcomingKey(b);
    return ka === kb ? byTitle(a, b) : ka - kb;
  },
  cancelled: byTitle,
  released: (a, b) => (fuzzyNum(b.end) || fuzzyNum(b.start)) - (fuzzyNum(a.end) || fuzzyNum(a.start)) || byTitle(a, b),
};

// ---------- Rendering ----------
const $ = sel => document.querySelector(sel);
const listEl = $('#list');

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function setProgress(text) { $('#progress').textContent = text || ''; }

function renderDiag() {
  const d = state.diag;
  const el = $('#diag');
  if (!d || state.loading) { el.hidden = true; return; }
  const sizes = [...new Set(d.pageSizes)];
  const size = !sizes.length ? 'n/a' : sizes.length === 1 && sizes[0] === 50 ? '50' : `${sizes.join('/')} (fallback)`;
  el.hidden = false;
  el.textContent = [
    `Diagnostics${d.fromCache ? ' (last refresh)' : ''}: load ${(d.ms / 1000).toFixed(1)} s`,
    `${d.requests} requests`,
    `page size ${size}`,
    `rate-limit headers readable: ${d.headersReadable ? 'yes' : 'no'}`,
    `429s: ${d.count429}`,
    `entries A ${d.runs.A} / B ${d.runs.B} / C ${d.runs.C} / D ${d.runs.D}`,
    ...(d.error ? [`error: ${d.error}`] : []),
  ].join(' · ');
}

function renderUpdated() {
  const el = $('#last-updated');
  if (!state.updatedAt) { el.textContent = 'Not loaded yet'; return; }
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  el.textContent = `Last updated ${f.format(new Date(state.updatedAt))}`;
}

// Per-title override wins over the global Covers switch.
function coverOn(id) {
  return id in state.coverOverrides ? state.coverOverrides[id] : state.covers;
}

function toggleCover(id) {
  const next = !coverOn(id);
  // Same as the global setting → drop the override so the title follows the switch again.
  if (next === state.covers) delete state.coverOverrides[id]; else state.coverOverrides[id] = next;
  save(COVER_OVERRIDES_KEY, state.coverOverrides);
  const item = state.items.find(i => i.id === id);
  const card = listEl.querySelector(`.card[data-id="${id}"]`);
  if (!item || !card) { render(); return; }
  const tmp = document.createElement('div');
  tmp.innerHTML = cardHtml(item).trim();
  card.replaceWith(tmp.firstElementChild);
}

function cardHtml(item) {
  const fav = state.favs.has(item.id);
  const group = STATUS_GROUP[item.status];
  const air = group === 'airing' ? airingText(item) : null;
  const airingBlock = group !== 'airing' ? '' : air
    ? `<div class="airing"><span class="air-main">${esc(air)}</span><span class="note">Japanese TV broadcast time (Berlin time); streaming can be later.</span></div>`
    : `<div class="airing"><span class="air-main muted">No upcoming episode scheduled</span></div>`;
  const links = item.links.length
    ? `<div class="chips-sm">${item.links.map(l =>
        `<a class="watch-chip" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(l.site)}</a>`).join('')}</div>`
    : `<div class="muted small">No streaming listed yet</div>`;
  const showCover = coverOn(item.id);
  const cover = showCover && item.cover
    ? `<img class="cover" src="${esc(item.cover)}" alt="" loading="lazy" decoding="async">`
    : showCover ? '<div class="cover cover-empty"></div>' : '';
  const overridden = item.id in state.coverOverrides;
  return `
<article class="card" data-id="${item.id}">
  ${cover}
  <div class="card-body">
    <div class="card-top">
      <h3 class="title">${esc(item.title)}</h3>
      <button type="button" class="cover-btn${showCover ? ' on' : ''}${overridden ? ' custom' : ''}" data-id="${item.id}" aria-pressed="${showCover}" aria-label="${showCover ? 'Hide' : 'Show'} cover for this title" title="${showCover ? 'Hide' : 'Show'} cover for this title"><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="9" cy="10" r="1.6" fill="currentColor"/><path d="M4 18l5-5 3 3 3-4 5 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>${showCover ? '' : '<path d="M3 3l18 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'}</svg></button>
      <button type="button" class="star${fav ? ' on' : ''}" data-id="${item.id}" aria-pressed="${fav}" aria-label="${fav ? 'Remove from' : 'Add to'} favorites">${fav ? '★' : '☆'}</button>
    </div>
    <div class="badges">
      <span class="badge label-${item.label.toLowerCase()}">${item.label}</span>
      <span class="badge status-${item.status === 'HIATUS' ? 'hiatus' : group}">${STATUS_TEXT[item.status]}</span>
    </div>
    <div class="dates">${esc(datesText(item))}</div>
    ${airingBlock}
    <div class="watch">
      <div class="watch-h">Listed on <span class="muted">(availability in Germany may differ)</span></div>
      ${links}
    </div>
  </div>
</article>`;
}

function visibleItems() {
  const q = state.query.trim().toLowerCase();
  return state.items.filter(it =>
    (it.inScope || state.favs.has(it.id)) &&
    (!state.favOnly || state.favs.has(it.id)) &&
    (!q || it.title.toLowerCase().includes(q) || it.romaji.toLowerCase().includes(q)));
}

function render() {
  document.body.classList.toggle('compact', !state.covers);
  $('#covers-toggle').checked = state.covers;
  $('#fav-toggle').setAttribute('aria-pressed', String(state.favOnly));
  $('#fav-toggle').classList.toggle('active', state.favOnly);

  const items = visibleItems();
  const groups = { airing: [], upcoming: [], released: [], cancelled: [] };
  for (const it of items) groups[STATUS_GROUP[it.status]].push(it);
  for (const k of Object.keys(groups)) groups[k].sort(SORTERS[k]);

  document.querySelectorAll('.chip[data-filter]').forEach(btn => {
    const f = btn.dataset.filter;
    const n = f === 'all' ? items.length : groups[f].length;
    const name = { all: 'All', airing: 'Airing', upcoming: 'Upcoming', released: 'Released' }[f];
    btn.textContent = `${name} ${n}`;
    btn.classList.toggle('active', state.filter === f);
    btn.setAttribute('aria-pressed', String(state.filter === f));
  });

  if (!state.items.length) {
    listEl.innerHTML = state.loading ? '<p class="empty">Loading from AniList…</p>' : '<p class="empty">No data yet. Tap ↻ to load.</p>';
    return;
  }
  const sections = state.filter === 'all' ? SECTIONS : SECTIONS.filter(s => s.key === state.filter);
  const html = sections.map(s => {
    const list = groups[s.key];
    if (state.filter === 'all' && !list.length) return '';
    const head = state.filter === 'all' ? `<h2 class="section-h">${s.title} <span class="count">${list.length}</span></h2>` : '';
    return `${head}<div class="cards">${list.map(cardHtml).join('')}</div>`;
  }).join('');
  listEl.innerHTML = html.trim() || '<p class="empty">Nothing matches.</p>';
}

// ---------- Actions ----------
async function refresh() {
  if (state.loading) return;
  state.loading = true;
  $('#refresh-btn').disabled = true;
  $('#refresh-btn').classList.add('spinning');
  renderDiag();
  if (!state.items.length) render();
  stats = newStats();
  try {
    const items = await fetchAll();
    stats.ms = Date.now() - stats.startedAt;
    state.items = items;
    state.updatedAt = Date.now();
    state.diag = stats;
    save(CACHE_KEY, { updatedAt: state.updatedAt, items, diag: stats });
    setProgress('');
  } catch (e) {
    console.error(e);
    stats.ms = Date.now() - stats.startedAt;
    stats.error = e.message || 'Loading failed';
    state.diag = stats;
    setProgress(`${e.message || 'Loading failed.'}${state.items.length ? ' Showing cached data.' : ''}`);
  } finally {
    stats = null;
    state.loading = false;
    $('#refresh-btn').disabled = false;
    $('#refresh-btn').classList.remove('spinning');
    renderUpdated();
    renderDiag();
    render();
  }
}

function toggleFav(id) {
  if (state.favs.has(id)) state.favs.delete(id); else state.favs.add(id);
  save(FAVS_KEY, [...state.favs]);
  const item = state.items.find(i => i.id === id);
  if (state.favOnly || (item && !item.inScope)) { render(); return; }
  const btn = listEl.querySelector(`.star[data-id="${id}"]`);
  if (btn) {
    const on = state.favs.has(id);
    btn.classList.toggle('on', on);
    btn.textContent = on ? '★' : '☆';
    btn.setAttribute('aria-pressed', String(on));
    btn.setAttribute('aria-label', `${on ? 'Remove from' : 'Add to'} favorites`);
  }
}

// ---------- Init ----------
function init() {
  listEl.addEventListener('click', e => {
    const star = e.target.closest('.star');
    if (star) { toggleFav(Number(star.dataset.id)); return; }
    const cb = e.target.closest('.cover-btn');
    if (cb) toggleCover(Number(cb.dataset.id));
  });
  document.querySelectorAll('.chip[data-filter]').forEach(btn =>
    btn.addEventListener('click', () => { state.filter = btn.dataset.filter; render(); }));
  $('#fav-toggle').addEventListener('click', () => { state.favOnly = !state.favOnly; render(); });
  $('#covers-toggle').addEventListener('change', e => {
    state.covers = e.target.checked;
    save(COVERS_KEY, state.covers);
    // Overrides that now equal the global setting are redundant.
    for (const [id, v] of Object.entries(state.coverOverrides)) if (v === state.covers) delete state.coverOverrides[id];
    save(COVER_OVERRIDES_KEY, state.coverOverrides);
    render();
  });
  let t;
  $('#search').addEventListener('input', e => {
    clearTimeout(t);
    t = setTimeout(() => { state.query = e.target.value; render(); }, 120);
  });
  $('#refresh-btn').addEventListener('click', refresh);

  const cache = load(CACHE_KEY, null);
  if (cache && Array.isArray(cache.items)) {
    state.items = cache.items;
    state.updatedAt = cache.updatedAt;
    if (cache.diag) state.diag = { ...cache.diag, fromCache: true };
  }
  renderUpdated();
  renderDiag();
  render();
  if (!state.updatedAt || Date.now() - state.updatedAt > CACHE_TTL_MS) refresh();
}

init();
