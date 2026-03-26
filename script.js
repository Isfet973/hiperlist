const mdPath = './movie-list.md';
const tmdbImageBase = 'https://image.tmdb.org/t/p/w500';
const posterPlaceholder = 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="900" viewBox="0 0 600 900"><defs><linearGradient id="g" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="#1e293b"/><stop offset="100%" stop-color="#020617"/></linearGradient></defs><rect width="600" height="900" fill="url(#g)"/><rect x="60" y="60" width="480" height="780" rx="36" fill="rgba(124,58,237,0.12)" stroke="rgba(167,139,250,0.20)"/><text x="300" y="420" font-family="Arial, sans-serif" font-size="34" fill="#e2e8f0" text-anchor="middle">Poster indisponível</text></svg>`);

const state = {
  sections: [],
  activeKey: 'all',
  sectionCache: new Map(),
  posterCache: loadPosterCache(),
  posterRequests: new Map(),
  posterQueue: [],
  running: 0,
  tmdbToken: localStorage.getItem('hiperlist_tmdb_token') || ''
};

const $tabs = document.getElementById('tabs');
const $content = document.getElementById('content');
const $stats = document.getElementById('stats');
const $configureToken = document.getElementById('configureToken');
const $clearPosterCache = document.getElementById('clearPosterCache');

let posterObserver = null;

const escapeHtml = (value = '') => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&quot;').replace(/'/g, '&#39;');

function parseRow(line) {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map(cell => cell.trim());
}

function parseMarkdown(md) {
  const lines = md.split(/\r?\n/);
  const sections = [];
  let current = null;
  let headers = null;
  let inTable = false;

  for (const line of lines) {
    const heading = line.match(/^##\s+(NÍVEL\s+\d+.*)$/);
    if (heading) {
      current = { title: heading[1].trim(), items: [] };
      sections.push(current);
      headers = null;
      inTable = false;
      continue;
    }

    if (!current) continue;

    if (/^\|\s*#\s*\|/.test(line)) {
      headers = parseRow(line);
      inTable = true;
      continue;
    }

    if (inTable && /^\|/.test(line) && !/^\|\s*-+/.test(line)) {
      const row = parseRow(line);
      if (headers && row.length === headers.length) {
        const item = Object.fromEntries(headers.map((h, i) => [h, row[i] ?? '']));
        if (item['#']) current.items.push(item);
      }
      continue;
    }

    if (inTable && line.trim() === '') continue;

    if (inTable && !/^\|/.test(line)) {
      inTable = false;
      headers = null;
    }
  }

  return sections;
}

function loadPosterCache() {
  try {
    const raw = localStorage.getItem('hiperlist_poster_cache_v1');
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function savePosterCache() {
  try {
    localStorage.setItem('hiperlist_poster_cache_v1', JSON.stringify(state.posterCache));
  } catch {}
}

function normalizeKey({ title, year, kind }) {
  return [kind, String(year || ''), String(title || '').trim().toLowerCase()].join('::').replace(/\s+/g, ' ');
}

function guessKind(item) {
  const media = (item['Midia'] || '').toLowerCase();
  const type = item['Tipo'] || '';
  if (media.includes('anime') || /\bAN\b/.test(type)) return 'anime';
  if (media.includes('serie') || media.includes('série')) return 'tv';
  return 'movie';
}

function getItemData(item) {
  return {
    title: item['Titulo'] || item['Título'] || '',
    year: Number.parseInt(item['Ano'], 10) || null,
    kind: guessKind(item),
    media: item['Midia'] || '',
    type: item['Tipo'] || ''
  };
}

function makeFallbackLabel(title = '') {
  const words = String(title).trim().split(/\s+/).filter(Boolean);
  const initials = words.slice(0, 2).map(w => w[0]).join('').toUpperCase();
  return initials || 'HL';
}

function enqueue(fn) {
  return new Promise((resolve, reject) => {
    state.posterQueue.push({ fn, resolve, reject });
    pumpQueue();
  });
}

function pumpQueue() {
  while (state.running < 4 && state.posterQueue.length) {
    const task = state.posterQueue.shift();
    state.running += 1;
    Promise.resolve()
      .then(task.fn)
      .then(task.resolve, task.reject)
      .finally(() => {
        state.running -= 1;
        pumpQueue();
      });
  }
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) return null;
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function chooseBestTmdbResult(results, title, year) {
  if (!Array.isArray(results) || results.length === 0) return null;
  const normalizedTitle = title.trim().toLowerCase();
  const scored = results.map(result => {
    const resultTitle = String(result.title || result.name || result.original_title || result.original_name || '').trim().toLowerCase();
    const release = String(result.release_date || result.first_air_date || '').slice(0, 4);
    let score = 0;
    if (resultTitle === normalizedTitle) score += 100;
    else if (resultTitle.includes(normalizedTitle) || normalizedTitle.includes(resultTitle)) score += 40;
    if (year && release && Number(release) === year) score += 30;
    if (result.poster_path) score += 15;
    if (result.popularity) score += Math.min(10, Math.log10(Number(result.popularity) + 1));
    return { result, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.result || null;
}

async function fetchTmdbPoster({ title, year, kind }) {
  if (!state.tmdbToken) return null;
  const endpoint = kind === 'tv' ? 'search/tv' : 'search/movie';
  const params = new URLSearchParams({ query: title, language: 'pt-BR', include_adult: 'false' });
  if (kind === 'movie' && year) params.set('year', String(year));
  if (kind === 'tv' && year) params.set('first_air_date_year', String(year));
  const data = await fetchJsonWithTimeout(`https://api.themoviedb.org/3/${endpoint}?${params.toString()}`, {
    headers: { accept: 'application/json', Authorization: `Bearer ${state.tmdbToken}` }
  });
  const best = chooseBestTmdbResult(data?.results || [], title, year);
  if (!best || !best.poster_path) return null;
  return { url: `${tmdbImageBase}${best.poster_path}`, source: 'TMDB', title: best.title || best.name || title };
}

function chooseBestJikanResult(results, title, year) {
  if (!Array.isArray(results) || results.length === 0) return null;
  const normalizedTitle = title.trim().toLowerCase();
  const scored = results.map(result => {
    const resultTitle = String(result.title || result.title_english || result.title_japanese || '').trim().toLowerCase();
    const aired = String(result.aired?.prop?.from?.year || result.aired?.from || '').slice(0, 4);
    let score = 0;
    if (resultTitle === normalizedTitle) score += 100;
    else if (resultTitle.includes(normalizedTitle) || normalizedTitle.includes(resultTitle)) score += 40;
    if (year && aired && Number(aired) === year) score += 30;
    if (result.images?.webp?.large_image_url || result.images?.jpg?.large_image_url) score += 15;
    return { result, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.result || null;
}

async function fetchJikanPoster({ title, year }) {
  const params = new URLSearchParams({ q: title, limit: '5', sfw: 'true' });
  const data = await fetchJsonWithTimeout(`https://api.jikan.moe/v4/anime?${params.toString()}`);
  const best = chooseBestJikanResult(data?.data || [], title, year);
  if (!best) return null;
  const url = best.images?.webp?.large_image_url || best.images?.jpg?.large_image_url || best.images?.webp?.image_url || best.images?.jpg?.image_url || null;
  if (!url) return null;
  return { url, source: 'Jikan', title: best.title || title };
}

async function resolvePosterForItem(item) {
  const data = getItemData(item);
  const cacheKey = normalizeKey(data);
  if (state.posterCache[cacheKey]) return state.posterCache[cacheKey];
  if (state.posterRequests.has(cacheKey)) return state.posterRequests.get(cacheKey);

  const promise = enqueue(async () => {
    let result = null;
    try {
      result = data.kind === 'anime' ? await fetchJikanPoster(data) : await fetchTmdbPoster(data);
    } catch (error) {
      console.warn('Poster lookup failed:', data.title, error);
    }
    const value = result || { url: posterPlaceholder, source: 'Fallback', title: data.title };
    state.posterCache[cacheKey] = value;
    savePosterCache();
    return value;
  });
  state.posterRequests.set(cacheKey, promise);
  promise.finally(() => state.posterRequests.delete(cacheKey));
  return promise;
}

function buildStats(sections) {
  const total = sections.reduce((sum, s) => sum + s.items.length, 0);
  $stats.innerHTML = `<div class="stat"><span class="label">Seções</span><span class="value">${sections.length}</span></div><div class="stat"><span class="label">Mídias</span><span class="value">${total}</span></div><div class="stat"><span class="label">Poster cache</span><span class="value">${Object.keys(state.posterCache).length}</span></div>`;
}

function renderTabs(sections) {
  const allCount = sections.reduce((sum, s) => sum + s.items.length, 0);
  const tabs = [
    { key: 'all', title: 'Todas', count: allCount },
    ...sections.map((s, i) => ({ key: String(i), title: s.title, count: s.items.length }))
  ];
  $tabs.innerHTML = tabs.map(tab => `<button class="tab ${tab.key === state.activeKey ? 'active' : ''}" data-key="${escapeHtml(tab.key)}" type="button">${escapeHtml(tab.title)} <span style="opacity:.7">(${tab.count})</span></button>`).join('');
}

function cardTemplate(item) {
  const title = item['Titulo'] || '';
  const year = item['Ano'] || '';
  const media = item['Midia'] || '';
  const notes = item['Notas'] || '';
  const typeTags = (item['Tipo'] || '').split(',').map(s => s.trim()).filter(Boolean);
  const recTags = (item['REC'] || '').split(',').map(s => s.trim()).filter(Boolean);
  const initials = makeFallbackLabel(title);

  const badges = [
    ['EROT', item['EROT']],
    ['EXPL', item['EXPL']],
    ['PROF', item['PROF']],
    ['PERT', item['PERT']],
    ['TABU', item['TABU']],
    ['RARI', item['RARI']],
    ['CULT', item['CULT']]
  ];

  return `<article class="card"><div class="poster-shell"><img class="poster" alt="Poster de ${escapeHtml(title)}" data-poster="1" data-title="${escapeHtml(title)}" data-year="${escapeHtml(year)}" data-media="${escapeHtml(media)}" data-type="${escapeHtml(item['Tipo'] || '')}" /><div class="poster-fallback"><div class="poster-initials">${escapeHtml(initials)}</div><div class="poster-hint">Carregando capa sob demanda.</div></div></div><div class="card-body"><h3>${escapeHtml(title)}</h3><div class="meta"><span>${escapeHtml(year)}</span><span>•</span><span>${escapeHtml(media)}</span></div><div class="chips">${typeTags.map(tag => `<span class="chip">${escapeHtml(tag)}</span>`).join('')}</div><div class="badges">${badges.map(([k, v]) => `<div class="badge"><span class="k">${escapeHtml(k)}</span><span class="v">${escapeHtml(v)}</span></div>`).join('')}</div><div class="chips">${recTags.map(tag => `<span class="chip">${escapeHtml(tag)}</span>`).join('')}</div><div class="footer-row"><div class="poster-source" data-poster-source>aguardando</div></div><div class="notes">${escapeHtml(notes)}</div></div></article>`;
}

function attachPosterObserver() {
  if (posterObserver) posterObserver.disconnect();
  posterObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const img = entry.target;
      posterObserver.unobserve(img);
      loadPosterIntoImage(img);
    }
  }, { root: null, rootMargin: '600px 0px', threshold: 0.01 });
  document.querySelectorAll('img[data-poster="1"]').forEach(img => posterObserver.observe(img));
}

async function loadPosterIntoImage(img) {
  const card = img.closest('.card');
  if (!card || img.dataset.loaded === '1') return;

  const item = {
    Titulo: img.dataset.title || '',
    Ano: img.dataset.year || '',
    Midia: img.dataset.media || '',
    Tipo: img.dataset.type || ''
  };
  const sourceLabel = card.querySelector('[data-poster-source]');

  try {
    const poster = await resolvePosterForItem(item);
    if (poster?.url) {
      img.src = poster.url;
      img.alt = `Poster de ${item.Titulo}`;
      img.addEventListener('load', () => {
        card.querySelector('.poster-shell')?.classList.add('has-image');
        img.classList.add('is-loaded');
      }, { once: true });
      img.addEventListener('error', () => {
        img.src = posterPlaceholder;
      }, { once: true });
      if (sourceLabel) sourceLabel.textContent = poster.source === 'Fallback' ? 'sem poster' : poster.source;
    } else {
      img.src = posterPlaceholder;
      if (sourceLabel) sourceLabel.textContent = 'sem poster';
    }
  } catch (error) {
    console.warn(error);
    img.src = posterPlaceholder;
    if (sourceLabel) sourceLabel.textContent = 'sem poster';
  } finally {
    img.dataset.loaded = '1';
  }
}

function renderSection(sections, key) {
  const cacheKey = key;
  if (state.sectionCache.has(cacheKey)) {
    $content.innerHTML = state.sectionCache.get(cacheKey);
    attachPosterObserver();
    return;
  }

  let html = '';
  if (key === 'all') {
    const items = sections.flatMap((s) => s.items);
    html = `<div class="section-head"><h2>Todas as mídias</h2><div class="count">${items.length} itens</div></div><div class="grid">${items.map(item => cardTemplate(item)).join('')}</div>`;
  } else {
    const section = sections[Number(key)];
    html = `<div class="section-head"><h2>${escapeHtml(section.title)}</h2><div class="count">${section.items.length} itens</div></div><div class="grid">${section.items.map(item => cardTemplate(item)).join('')}</div>`;
  }

  state.sectionCache.set(cacheKey, html);
  $content.innerHTML = html;
  attachPosterObserver();
}

function setActive(key) {
  state.activeKey = key;
  renderTabs(state.sections);
  renderSection(state.sections, key);
}

async function init() {
  $content.innerHTML = '<div class="loading">Carregando catálogo...</div>';
  try {
    const res = await fetch(mdPath, { cache: 'force-cache' });
    if (!res.ok) throw new Error(`Não foi possível carregar ${mdPath}`);
    const md = await res.text();
    state.sections = parseMarkdown(md);
    buildStats(state.sections);
    renderTabs(state.sections);
    renderSection(state.sections, state.activeKey);
  } catch (err) {
    console.error(err);
    $content.innerHTML = '<div class="error">Não consegui ler o arquivo markdown. Coloque <strong>movie-list.md</strong> na mesma pasta do <strong>index.html</strong>.</div>';
  }
}

$tabs.addEventListener('click', (event) => {
  const btn = event.target.closest('.tab');
  if (!btn) return;
  setActive(btn.dataset.key);
});

$configureToken.addEventListener('click', () => {
  const current = state.tmdbToken || '';
  const token = prompt('Cole seu TMDB v4 Read Access Token.\nEle será salvo apenas neste navegador.', current);
  if (token === null) return;
  const cleaned = token.trim();
  state.tmdbToken = cleaned;

  // Limpa todos os caches para que os posters sejam buscados com o novo token imediatamente
  state.posterCache = {};
  state.sectionCache.clear();
  state.posterRequests.clear();
  state.posterQueue.length = 0;
  state.running = 0;
  savePosterCache();

  if (cleaned) {
    localStorage.setItem('hiperlist_tmdb_token', cleaned);
    buildStats(state.sections);
    renderSection(state.sections, state.activeKey);
    alert('Token salvo! Os posters estao sendo carregados agora.');
  } else {
    localStorage.removeItem('hiperlist_tmdb_token');
    buildStats(state.sections);
    renderSection(state.sections, state.activeKey);
    alert('Token removido.');
  }
});

$clearPosterCache.addEventListener('click', () => {
  if (!confirm('Limpar o cache de posters deste navegador?')) return;
  state.posterCache = {};
  state.sectionCache.clear();
  savePosterCache();
  buildStats(state.sections);
  renderSection(state.sections, state.activeKey);
});

init();
