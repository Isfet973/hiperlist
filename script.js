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

// ── CARD MODAL STATE ──
const cmState = {
  item: null,
  results: [],       // lista de resultados TMDB/Jikan
  resultIdx: 0,      // índice atual na lista
  customUrl: null,   // poster manual do usuário
  listChoice: null,  // 'watched' | 'want' | null
};

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

// ══════════════════════════════════════════════
//  CARD MODAL
// ══════════════════════════════════════════════

const CRITERIA_CM = {
  filme:[{key:'roteiro',label:'Roteiro'},{key:'direcao',label:'Direção'},{key:'atuacao',label:'Atuações'},{key:'trilha',label:'Trilha sonora'},{key:'impacto',label:'Impacto emocional'}],
  serie:[{key:'roteiro',label:'Roteiro'},{key:'personagens',label:'Personagens'},{key:'ritmo',label:'Ritmo'},{key:'atuacao',label:'Atuações'},{key:'vicio',label:'Fator viciante'}],
  anime:[{key:'historia',label:'História'},{key:'personagens',label:'Personagens'},{key:'animacao',label:'Animação'},{key:'trilha',label:'Trilha/OST'},{key:'emocao',label:'Impacto emocional'}],
};

function cmGuessType(item){
  const m=(item['Midia']||'').toLowerCase();
  if(m.includes('anime'))return'anime';
  if(m.includes('serie')||m.includes('série'))return'serie';
  return'filme';
}

function cmCalcScore(form){
  const sliders=[...form.querySelectorAll('input[type=range]')];
  if(!sliders.length)return null;
  const avg=sliders.reduce((a,s)=>a+Number(s.value),0)/sliders.length;
  return avg.toFixed(1);
}

function cmLoadStorage(key,fb){try{return JSON.parse(localStorage.getItem(key))??fb;}catch{return fb;}}
function cmSaveStorage(key,val){try{localStorage.setItem(key,JSON.stringify(val));}catch{}}
function cmGenId(){return Date.now().toString(36)+Math.random().toString(36).slice(2,6);}

function buildCardModal(){
  if(document.getElementById('cmOverlay'))return;
  const el=document.createElement('div');
  el.className='cm-overlay';
  el.id='cmOverlay';
  el.innerHTML=`
<div class="cm-box" id="cmBox">
  <div class="cm-poster-col">
    <div class="cm-poster-wrap" id="cmPosterWrap" title="Clique para trocar foto">
      <img id="cmPosterImg" src="" alt="Poster"/>
      <div class="cm-poster-overlay">
        <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M2 11l3-3 2 2 3-4 4 5H2z"/><circle cx="5.5" cy="5.5" r="1.5"/><rect x="1" y="1" width="14" height="14" rx="3"/></svg>
        Trocar imagem
      </div>
    </div>
    <div class="cm-poster-arrows">
      <button class="cm-arr" id="cmArrPrev">&#8592; Anterior</button>
      <button class="cm-arr" id="cmArrNext">Próximo &#8594;</button>
    </div>
    <div class="cm-poster-src" id="cmPosterSrc"></div>
    <div class="cm-poster-input-row">
      <label class="cm-label" style="padding:0">Ou cole um link</label>
      <div style="display:flex;gap:6px">
        <input class="cm-link-input" id="cmLinkInput" placeholder="https://..."/>
        <button class="cm-link-btn" id="cmLinkBtn">Usar</button>
      </div>
    </div>
    <input type="file" id="cmFileInput" accept="image/*" style="display:none"/>
  </div>
  <div class="cm-right" id="cmRight">
    <button class="cm-close" id="cmClose">
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M4 4l8 8M12 4l-8 8" stroke-linecap="round"/></svg>
    </button>
    <div class="cm-title" id="cmTitle"></div>
    <div class="cm-meta" id="cmMeta"></div>
    <div class="cm-section">
      <div class="cm-label">Adicionar à lista</div>
      <div class="cm-list-btns">
        <button class="cm-list-btn" id="cmBtnWant">📋 Quero ver</button>
        <button class="cm-list-btn" id="cmBtnWatched">✅ Já vi</button>
      </div>
    </div>
    <div id="cmWantForm" class="cm-want-form" style="display:none">
      <div class="cm-section"><div class="cm-label">Prioridade</div>
        <select class="cm-select" id="cmPriority">
          <option value="alta">🔴 Alta</option>
          <option value="media" selected>🟡 Média</option>
          <option value="baixa">🟢 Baixa</option>
        </select>
      </div>
      <div class="cm-section"><div class="cm-label">Anotação</div>
        <textarea class="cm-textarea" id="cmWantNotes" placeholder="Por que quer assistir?"></textarea>
      </div>
      <button class="cm-save-btn" id="cmSaveWant">Salvar na lista</button>
    </div>
    <div id="cmWatchedForm" class="cm-watched-form" style="display:none">
      <div class="cm-row">
        <div class="cm-section"><div class="cm-label">Data início</div><input class="cm-input" id="cmDateStart" type="date"/></div>
        <div class="cm-section"><div class="cm-label">Data fim</div><input class="cm-input" id="cmDateEnd" type="date"/></div>
      </div>
      <div class="cm-section">
        <div class="cm-label" style="display:flex;justify-content:space-between;align-items:center">
          Avaliação <span class="cm-score-badge" id="cmScoreBadge">— / 10</span>
        </div>
        <div class="cm-criteria" id="cmCriteria"></div>
      </div>
      <div class="cm-section"><div class="cm-label">Notas pessoais</div>
        <textarea class="cm-textarea" id="cmWatchedNotes" placeholder="Impressões, spoilers…"></textarea>
      </div>
      <button class="cm-save-btn" id="cmSaveWatched">Salvar como assistido</button>
    </div>
  </div>
</div>`;
  document.body.appendChild(el);

  // fechar
  document.getElementById('cmClose').onclick=()=>el.classList.remove('open');
  el.addEventListener('click',e=>{if(e.target===el)el.classList.remove('open');});

  // trocar lista
  document.getElementById('cmBtnWant').onclick=()=>cmToggleList('want');
  document.getElementById('cmBtnWatched').onclick=()=>cmToggleList('watched');

  // setas poster
  document.getElementById('cmArrPrev').onclick=()=>cmStepPoster(-1);
  document.getElementById('cmArrNext').onclick=()=>cmStepPoster(1);

  // upload clique no poster
  document.getElementById('cmPosterWrap').onclick=()=>document.getElementById('cmFileInput').click();
  document.getElementById('cmFileInput').onchange=e=>{
    const f=e.target.files[0]; if(!f)return;
    const r=new FileReader();
    r.onload=ev=>{cmState.customUrl=ev.target.result;cmSetPosterImg(ev.target.result,'Upload');};
    r.readAsDataURL(f);
  };

  // link manual
  document.getElementById('cmLinkBtn').onclick=()=>{
    const url=document.getElementById('cmLinkInput').value.trim();
    if(!url)return;
    cmState.customUrl=url;
    cmSetPosterImg(url,'Link');
    document.getElementById('cmLinkInput').value='';
  };

  // sliders → score ao vivo
  document.getElementById('cmCriteria').addEventListener('input',e=>{
    if(e.target.type!=='range')return;
    e.target.previousElementSibling.textContent=e.target.value;
    cmUpdateScore();
  });

  // salvar quero ver
  document.getElementById('cmSaveWant').onclick=cmSaveWant;
  // salvar já vi
  document.getElementById('cmSaveWatched').onclick=cmSaveWatched;
}

function cmToggleList(choice){
  const wantBtn=document.getElementById('cmBtnWant');
  const watchBtn=document.getElementById('cmBtnWatched');
  const wantForm=document.getElementById('cmWantForm');
  const watchedForm=document.getElementById('cmWatchedForm');

  if(cmState.listChoice===choice){
    // desmarcar
    cmState.listChoice=null;
    wantBtn.classList.remove('active-want');
    watchBtn.classList.remove('active-watched');
    wantForm.style.display='none';
    watchedForm.style.display='none';
    return;
  }
  cmState.listChoice=choice;
  wantBtn.classList.toggle('active-want',choice==='want');
  watchBtn.classList.toggle('active-watched',choice==='watched');
  wantForm.style.display=choice==='want'?'flex':'none';
  watchedForm.style.display=choice==='watched'?'flex':'none';
  if(choice==='watched')cmBuildCriteria();
}

function cmBuildCriteria(){
  const type=cmGuessType(cmState.item||{});
  const list=CRITERIA_CM[type]||CRITERIA_CM.filme;
  const container=document.getElementById('cmCriteria');
  container.innerHTML=list.map(c=>`
    <div class="cm-crit-row">
      <span>${c.label}</span>
      <span class="cm-crit-val">${7}</span>
      <input type="range" min="0" max="10" step="0.5" value="7" data-key="${c.key}" style="width:100%"/>
    </div>`).join('');
  cmUpdateScore();
}

function cmUpdateScore(){
  const sliders=[...document.querySelectorAll('#cmCriteria input[type=range]')];
  if(!sliders.length)return;
  const avg=(sliders.reduce((a,s)=>a+Number(s.value),0)/sliders.length).toFixed(1);
  const badge=document.getElementById('cmScoreBadge');
  badge.textContent=`${avg} / 10`;
  const n=Number(avg);
  badge.style.color=n>=8?'#6ee7b7':n>=5?'#fcd34d':'#fca5a5';
}

function cmSetPosterImg(url,source){
  const img=document.getElementById('cmPosterImg');
  img.src=url;
  document.getElementById('cmPosterSrc').textContent=source||'';
}

async function cmStepPoster(dir){
  const results=cmState.results;
  if(!results.length)return;
  cmState.customUrl=null;
  cmState.resultIdx=(cmState.resultIdx+dir+results.length)%results.length;
  const r=results[cmState.resultIdx];
  const url=r.poster_path?`${tmdbImageBase}${r.poster_path}`:(r.images?.webp?.large_image_url||r.images?.jpg?.large_image_url||posterPlaceholder);
  cmSetPosterImg(url,`TMDB ${cmState.resultIdx+1}/${results.length}`);
  document.getElementById('cmArrPrev').disabled=false;
  document.getElementById('cmArrNext').disabled=false;
}

async function cmFetchAllResults(item){
  const data=getItemData(item);
  cmState.results=[];
  cmState.resultIdx=0;
  try{
    if(data.kind==='anime'){
      const params=new URLSearchParams({q:data.title,limit:'10',sfw:'true'});
      const d=await fetchJsonWithTimeout(`https://api.jikan.moe/v4/anime?${params}`);
      cmState.results=(d?.data||[]).filter(r=>r.images?.jpg?.large_image_url||r.images?.webp?.large_image_url);
    } else if(state.tmdbToken){
      const endpoint=data.kind==='tv'?'search/tv':'search/movie';
      const params=new URLSearchParams({query:data.title,language:'pt-BR',include_adult:'false'});
      if(data.year)params.set(data.kind==='tv'?'first_air_date_year':'year',String(data.year));
      const d=await fetchJsonWithTimeout(`https://api.themoviedb.org/3/${endpoint}?${params}`,{headers:{accept:'application/json',Authorization:`Bearer ${state.tmdbToken}`}});
      cmState.results=(d?.results||[]).filter(r=>r.poster_path);
    }
  }catch(e){console.warn('cmFetchAllResults',e);}
  const prevBtn=document.getElementById('cmArrPrev');
  const nextBtn=document.getElementById('cmArrNext');
  if(prevBtn){prevBtn.disabled=cmState.results.length<2;nextBtn.disabled=cmState.results.length<2;}
}

async function openCardModal(item){
  buildCardModal();
  cmState.item=item;
  cmState.listChoice=null;
  cmState.customUrl=null;
  cmState.results=[];
  cmState.resultIdx=0;

  // reset UI
  document.getElementById('cmBtnWant').classList.remove('active-want');
  document.getElementById('cmBtnWatched').classList.remove('active-watched');
  document.getElementById('cmWantForm').style.display='none';
  document.getElementById('cmWatchedForm').style.display='none';
  document.getElementById('cmWantNotes').value='';
  document.getElementById('cmWatchedNotes').value='';
  document.getElementById('cmDateStart').value='';
  document.getElementById('cmDateEnd').value='';
  document.getElementById('cmScoreBadge').textContent='— / 10';
  document.getElementById('cmCriteria').innerHTML='';
  document.getElementById('cmArrPrev').disabled=true;
  document.getElementById('cmArrNext').disabled=true;

  const title=item['Titulo']||'';
  const year=item['Ano']||'';
  const media=item['Midia']||'';
  document.getElementById('cmTitle').textContent=title;
  document.getElementById('cmMeta').innerHTML=`<span>${year}</span>${year?'<span>•</span>':''}  <span>${media}</span>`;

  // poster atual do card
  const cardImg=document.querySelector(`img[data-title="${CSS.escape(title)}"]`);
  const currentSrc=cardImg?.src&&!cardImg.src.includes('data:image/svg')?cardImg.src:posterPlaceholder;
  cmSetPosterImg(currentSrc,'atual');

  document.getElementById('cmOverlay').classList.add('open');

  // busca todos os resultados em paralelo (sem bloquear a abertura)
  cmFetchAllResults(item).then(()=>{
    if(cmState.results.length&&!cmState.customUrl){
      cmState.resultIdx=0;
      const r=cmState.results[0];
      const url=r.poster_path?`${tmdbImageBase}${r.poster_path}`:(r.images?.webp?.large_image_url||r.images?.jpg?.large_image_url||posterPlaceholder);
      cmSetPosterImg(url,`TMDB 1/${cmState.results.length}`);
      document.getElementById('cmArrPrev').disabled=cmState.results.length<2;
      document.getElementById('cmArrNext').disabled=cmState.results.length<2;
    }
  });
}

function cmCurrentPosterUrl(){
  if(cmState.customUrl)return cmState.customUrl;
  return document.getElementById('cmPosterImg').src||'';
}

function cmSaveWant(){
  const item=cmState.item; if(!item)return;
  const title=item['Titulo']||'';
  const year=item['Ano']||'';
  const type=cmGuessType(item);
  const priority=document.getElementById('cmPriority').value;
  const notes=document.getElementById('cmWantNotes').value.trim();
  let list=cmLoadStorage('hl_wantlist_v1',[]);
  const exists=list.findIndex(i=>i.title.toLowerCase()===title.toLowerCase());
  const entry={id:exists>=0?list[exists].id:cmGenId(),title,type,year,priority,notes};
  if(exists>=0)list[exists]=entry; else list.push(entry);
  cmSaveStorage('hl_wantlist_v1',list);
  cmConfirm('Adicionado em "Quero ver" ✓');
}

function cmSaveWatched(){
  const item=cmState.item; if(!item)return;
  const title=item['Titulo']||'';
  const year=item['Ano']||'';
  const type=cmGuessType(item);
  const dateStart=document.getElementById('cmDateStart').value;
  const dateEnd=document.getElementById('cmDateEnd').value;
  const notes=document.getElementById('cmWatchedNotes').value.trim();
  const sliders=[...document.querySelectorAll('#cmCriteria input[type=range]')];
  const ratings=Object.fromEntries(sliders.map(s=>[s.dataset.key,+s.value]));
  let list=cmLoadStorage('hl_watched_v1',[]);
  const exists=list.findIndex(i=>i.title.toLowerCase()===title.toLowerCase());
  const entry={id:exists>=0?list[exists].id:cmGenId(),title,type,year,ratings,notes,
    dateWatched:type==='filme'?dateEnd:'',dateStart,dateEnd};
  if(exists>=0)list[exists]=entry; else list.push(entry);
  cmSaveStorage('hl_watched_v1',list);
  // salva poster customizado no cache
  if(cmState.customUrl){
    const cacheKey=normalizeKey({title,year:Number.parseInt(year)||null,kind:guessKind(item)});
    state.posterCache[cacheKey]={url:cmState.customUrl,source:'Custom',title};
    savePosterCache();
    // atualiza o card na página
    const cardImg=document.querySelector(`img[data-title="${CSS.escape(title)}"]`);
    if(cardImg){cardImg.src=cmState.customUrl;cardImg.classList.add('is-loaded');cardImg.closest('.poster-shell')?.classList.add('has-image');}
  }
  cmConfirm('Salvo em "Já vi" ✓');
}

function cmConfirm(msg){
  const btn=document.getElementById(cmState.listChoice==='want'?'cmSaveWant':'cmSaveWatched');
  const orig=btn.textContent;
  btn.textContent=msg;
  btn.style.background='linear-gradient(135deg,#059669,#34d399)';
  setTimeout(()=>{btn.textContent=orig;btn.style.background='';},2000);
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

  return `<article class="card" style="cursor:pointer"><div class="poster-shell"><div class="poster-shell"><img class="poster" alt="Poster de ${escapeHtml(title)}" data-poster="1" data-title="${escapeHtml(title)}" data-year="${escapeHtml(year)}" data-media="${escapeHtml(media)}" data-type="${escapeHtml(item['Tipo'] || '')}" /><div class="poster-fallback"><div class="poster-initials">${escapeHtml(initials)}</div><div class="poster-hint">Carregando capa sob demanda.</div></div></div><div class="card-body"><h3>${escapeHtml(title)}</h3><div class="meta"><span>${escapeHtml(year)}</span><span>•</span><span>${escapeHtml(media)}</span></div><div class="chips">${typeTags.map(tag => `<span class="chip">${escapeHtml(tag)}</span>`).join('')}</div><div class="badges">${badges.map(([k, v]) => `<div class="badge"><span class="k">${escapeHtml(k)}</span><span class="v">${escapeHtml(v)}</span></div>`).join('')}</div><div class="chips">${recTags.map(tag => `<span class="chip">${escapeHtml(tag)}</span>`).join('')}</div><div class="footer-row"><div class="poster-source" data-poster-source>aguardando</div></div><div class="notes">${escapeHtml(notes)}</div></div></article>`;
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
  document.querySelectorAll('.card').forEach(card=>{
  card.addEventListener('click',()=>{
    const img=card.querySelector('img[data-poster]');
    const item={
      Titulo:img?.dataset.title||'',
      Ano:img?.dataset.year||'',
      Midia:img?.dataset.media||'',
      Tipo:img?.dataset.type||''
    };
    openCardModal(item);
  });
});
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
