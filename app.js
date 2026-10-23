// Pagina de încărcare și analiză a prezentărilor (se vede doar după autentificare)
(function () {
  const $ = (id) => document.getElementById(id);
  const MAX_SLIDES = 50 * 1024 * 1024;
  const MAX_REC = 500 * 1024 * 1024;
  const SLIDE_EXT = ['.pptx', '.ppt', '.pdf', '.docx', '.doc', '.txt', '.odp'];
  const REC_EXT = ['.mp4', '.mov', '.webm', '.mkv', '.avi', '.mp3', '.wav', '.m4a', '.ogg'];
  const LANGS = { ro: 'Română', en: 'English', auto: 'Detectată automat' };
  let slidesFile = null, recFile = null, previewUrl = null, busy = false;
  let cards = new Map(), pollTimer = null;

  const fmt = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');
  const ext = (n) => { const i = n.lastIndexOf('.'); return i < 0 ? '' : n.slice(i).toLowerCase(); };
  const mmss = (s) => { s = Math.round(s); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function msg(text, isErr) {
    const m = $('up-msg');
    m.textContent = text;
    m.classList.toggle('err', !!isErr);
    m.hidden = !text;
  }
  async function call(path, method) {
    const res = await fetch(path, { method: method || 'GET', credentials: 'same-origin' });
    let data = {};
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'A apărut o eroare. Încearcă din nou.');
    return data;
  }

  // ---------- alegerea fișierelor ----------
  function problem(file, exts, max, label) {
    if (!exts.includes(ext(file.name))) return label + ': format neacceptat (' + (ext(file.name) || 'fără extensie') + ').';
    if (file.size > max) return label + ': fișierul e prea mare (maxim ' + Math.round(max / 1048576) + ' MB).';
    if (file.size === 0) return label + ': fișierul este gol.';
    return '';
  }
  function refreshButton() { $('up-submit').disabled = busy || !(slidesFile && recFile); }

  function showFile(kind) {
    const file = kind === 'slides' ? slidesFile : recFile;
    $('drop-' + kind).classList.toggle('has', !!file);
    $(kind + '-info').textContent = file ? file.name + ' · ' + fmt(file.size) : '';
    $(kind + '-clear').hidden = !file;
    if (kind === 'rec') {
      const box = $('rec-preview');
      box.textContent = '';
      if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
      if (file) {
        const isAudio = file.type.startsWith('audio') || ['.mp3', '.wav', '.m4a', '.ogg'].includes(ext(file.name));
        const media = document.createElement(isAudio ? 'audio' : 'video');
        media.controls = true;
        media.preload = 'metadata';
        previewUrl = URL.createObjectURL(file);
        media.src = previewUrl;
        box.appendChild(media);
      }
    }
    if (kind === 'slides' && file && !$('up-title').value) $('up-title').placeholder = file.name.replace(/\.[^.]+$/, '');
    refreshButton();
  }
  function setFile(kind, file) {
    if (!file) return;
    const err = kind === 'slides' ? problem(file, SLIDE_EXT, MAX_SLIDES, 'Prezentarea') : problem(file, REC_EXT, MAX_REC, 'Înregistrarea');
    if (err) { msg(err, true); return; }
    msg('', false);
    if (kind === 'slides') slidesFile = file; else recFile = file;
    showFile(kind);
  }
  function clearFile(kind) {
    if (kind === 'slides') { slidesFile = null; $('in-slides').value = ''; }
    else { recFile = null; $('in-rec').value = ''; }
    showFile(kind);
  }
  ['slides', 'rec'].forEach((kind) => {
    const drop = $('drop-' + kind);
    $('in-' + kind).addEventListener('change', (e) => setFile(kind, e.target.files[0]));
    $(kind + '-clear').addEventListener('click', () => clearFile(kind));
    ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
    drop.addEventListener('drop', (e) => setFile(kind, e.dataTransfer.files[0]));
  });

  // ---------- trimiterea ----------
  function upload(fd) {
    return new Promise((ok, fail) => {
      const x = new XMLHttpRequest();
      x.open('POST', '/api/presentations');
      x.upload.onprogress = (e) => {
        if (!e.lengthComputable) return;
        const pct = Math.round((e.loaded / e.total) * 100);
        $('up-bar').style.width = pct + '%';
        $('up-pct').textContent = pct + '%';
      };
      x.onload = () => {
        let d = {};
        try { d = JSON.parse(x.responseText); } catch (e) {}
        if (x.status >= 200 && x.status < 300) return ok(d);
        if (x.status === 401) return fail(new Error('Sesiunea a expirat. Reîncarcă pagina și autentifică-te din nou.'));
        fail(new Error(typeof d.detail === 'string' ? d.detail : 'Încărcarea nu a reușit. Verifică fișierele.'));
      };
      x.onerror = () => fail(new Error('Nu mă pot conecta la server. Verifică dacă rulează „python server.py”.'));
      x.send(fd);
    });
  }
  $('up-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy || !(slidesFile && recFile)) return;
    busy = true;
    refreshButton();
    msg('', false);
    $('up-progress').hidden = false;
    $('up-bar').style.width = '0%';
    $('up-pct').textContent = '0%';
    $('up-submit').textContent = 'Se încarcă…';
    const fd = new FormData();
    fd.append('title', $('up-title').value.trim());
    fd.append('language', $('up-lang').value);
    fd.append('slides', slidesFile);
    fd.append('recording', recFile);
    try {
      await upload(fd);
      clearFile('slides');
      clearFile('rec');
      $('up-title').value = '';
      $('up-title').placeholder = 'Ex: Prezentare licență';
      msg('Prezentarea a fost salvată. Apasă „Analizează” în lista de mai jos.', false);
      await loadList();
    } catch (err) {
      msg(err.message, true);
    } finally {
      busy = false;
      $('up-progress').hidden = true;
      $('up-submit').textContent = 'Salvează prezentarea';
      refreshButton();
    }
  });

  // ---------- lista prezentărilor ----------
  const BADGES = { uploaded: 'Încărcată', queued: 'În așteptare…', processing: 'Se analizează…', done: 'Analizată', error: 'Eroare' };

  function buildCard(p) {
    const card = el('article', 'pres');
    const top = el('div', 'pres-top');
    const info = el('div', 'pres-info');
    info.appendChild(el('h4', '', p.title));
    info.appendChild(el('p', 'pres-meta', new Date(p.created_at).toLocaleString('ro-RO', { dateStyle: 'medium', timeStyle: 'short' }) + ' · ' + (LANGS[p.language] || '')));
    const badge = el('span', 'badge');
    top.appendChild(info);
    top.appendChild(badge);
    card.appendChild(top);

    const files = el('ul', 'pres-files');
    files.appendChild(el('li', '', 'Slide-uri: ' + p.slides_name + ' · ' + fmt(p.slides_size)));
    files.appendChild(el('li', '', (p.rec_kind === 'audio' ? 'Audio: ' : 'Video: ') + p.rec_name + ' · ' + fmt(p.rec_size)));
    card.appendChild(files);

    const prog = el('div', 'pres-progress');
    const track = el('div', 'track');
    const bar = el('i');
    track.appendChild(bar);
    const progTxt = el('span');
    prog.appendChild(track);
    prog.appendChild(progTxt);
    card.appendChild(prog);
    const err = el('p', 'pres-error');
    card.appendChild(err);

    const actions = el('div', 'pres-actions');
    const report = el('button', 'btn btn-main sm', 'Vezi raportul');
    report.type = 'button';
    report.addEventListener('click', () => openReport(p.id));
    const analyze = el('button', 'btn btn-main sm', 'Analizează');
    analyze.type = 'button';
    analyze.addEventListener('click', async () => {
      analyze.disabled = true;
      try {
        const d = await call('/api/presentations/' + p.id + '/analyze', 'POST');
        update(d.presentation);
        ensurePolling();
      } catch (e) {
        err.textContent = e.message;
        err.hidden = false;
      } finally { analyze.disabled = false; }
    });
    const play = el('button', 'btn btn-ghost sm', p.rec_kind === 'audio' ? 'Ascultă' : 'Vezi înregistrarea');
    play.type = 'button';
    const player = el('div', 'pres-player');
    player.hidden = true;
    play.addEventListener('click', () => {
      if (!player.hidden) { player.hidden = true; player.textContent = ''; return; }
      const m = document.createElement(p.rec_kind === 'audio' ? 'audio' : 'video');
      m.controls = true;
      m.preload = 'metadata';
      m.src = '/api/presentations/' + p.id + '/recording';
      player.textContent = '';
      player.appendChild(m);
      player.hidden = false;
    });
    const dl = el('a', 'btn btn-ghost sm', 'Descarcă slide-urile');
    dl.href = '/api/presentations/' + p.id + '/slides';
    const del = el('button', 'btn btn-danger sm', 'Șterge');
    del.type = 'button';
    let armed = null;
    del.addEventListener('click', async () => {
      if (!armed) {
        del.textContent = 'Sigur? Apasă din nou';
        armed = setTimeout(() => { del.textContent = 'Șterge'; armed = null; }, 3000);
        return;
      }
      clearTimeout(armed);
      del.disabled = true;
      try {
        await call('/api/presentations/' + p.id, 'DELETE');
        await loadList();
      } catch (e) {
        del.disabled = false;
        del.textContent = 'Șterge';
        armed = null;
        msg('Nu am putut șterge prezentarea. Încearcă din nou.', true);
      }
    });
    [report, analyze, play, dl, del].forEach((b) => actions.appendChild(b));
    card.appendChild(actions);
    card.appendChild(player);

    function update(q) {
      const active = q.status === 'queued' || q.status === 'processing';
      const pct = Math.round((q.progress || 0) * 100);
      badge.textContent = q.status === 'processing' ? 'Se analizează… ' + pct + '%' : BADGES[q.status] || '';
      badge.className = 'badge ' + q.status;
      prog.hidden = !active;
      bar.style.width = (q.status === 'queued' ? 0 : pct) + '%';
      progTxt.textContent = q.status === 'queued' ? 'În așteptare' : pct + '%';
      err.hidden = q.status !== 'error' || !q.error;
      if (q.status === 'error') err.textContent = q.error || '';
      report.hidden = q.status !== 'done';
      analyze.hidden = !(q.status === 'uploaded' || q.status === 'error' || q.status === 'done');
      analyze.textContent = q.status === 'error' ? 'Încearcă din nou' : q.status === 'done' ? 'Analizează din nou' : 'Analizează';
      analyze.className = q.status === 'done' ? 'btn btn-ghost sm' : 'btn btn-main sm';
    }
    update(p);
    return { el: card, update };
  }

  function renderList(items) {
    const box = $('pres-list');
    box.textContent = '';
    cards = new Map();
    $('pres-empty').hidden = items.length > 0;
    items.forEach((p) => {
      const c = buildCard(p);
      cards.set(p.id, c);
      box.appendChild(c.el);
    });
  }

  function syncList(items) {
    const same = items.length === cards.size && items.every((p) => cards.has(p.id));
    if (same) items.forEach((p) => cards.get(p.id).update(p));
    else renderList(items);
    $('pres-empty').hidden = items.length > 0;
  }

  async function loadList() {
    try {
      const d = await call('/api/presentations');
      syncList(d.presentations);
      if (d.presentations.some((p) => p.status === 'queued' || p.status === 'processing')) ensurePolling();
    } catch (e) { /* serverul nu răspunde: lista rămâne cum era */ }
  }

  function ensurePolling() {
    if (pollTimer) return;
    pollTimer = setInterval(async () => {
      try {
        const d = await call('/api/presentations');
        syncList(d.presentations);
        if (!d.presentations.some((p) => p.status === 'queued' || p.status === 'processing')) stopPolling();
      } catch (e) { stopPolling(); }
    }, 2000);
  }
  function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

  // ---------- raportul ----------
  const LEVEL = { good: ['✓', 'Bun'], warn: ['!', 'Atenție'], bad: ['✕', 'De îmbunătățit'] };

  function tile(label, value, unit, note, level) {
    const t = el('div', 'tile');
    t.appendChild(el('div', 'tile-l', label));
    const v = el('div', 'tile-v', value);
    if (unit) v.appendChild(el('small', '', ' ' + unit));
    t.appendChild(v);
    t.appendChild(el('div', 'tile-n', note));
    if (level) t.appendChild(el('div', 'lvl ' + level, LEVEL[level][0] + ' ' + LEVEL[level][1]));
    return t;
  }

  function barChart(items, o) {
    const wrap = el('div', 'chart');
    const y = el('div', 'chart-y');
    [o.max, Math.round(o.max / 2), 0].forEach((v) => y.appendChild(el('span', '', String(v))));
    const plot = el('div', 'chart-plot');
    plot.setAttribute('role', 'img');
    plot.setAttribute('aria-label', o.aria);
    if (o.band) {
      const band = el('div', 'chart-band');
      band.style.bottom = (o.band[0] / o.max) * 100 + '%';
      band.style.height = ((o.band[1] - o.band[0]) / o.max) * 100 + '%';
      band.appendChild(el('span', '', o.band[0] + '–' + o.band[1]));
      plot.appendChild(band);
    }
    const bars = el('div', 'chart-bars');
    const step = Math.ceil(items.length / 10);
    items.forEach((it, i) => {
      const col = el('div', 'chart-col');
      const bar = el('div', 'pbar');
      bar.style.height = (it.v / o.max) * 100 + '%';
      bar.tabIndex = 0;
      bar.dataset.v = it.v + ' ' + o.unit;
      bar.setAttribute('aria-label', 'De la ' + mmss(it.t) + ': ' + it.v + ' ' + o.unit);
      col.appendChild(bar);
      col.appendChild(el('span', 'chart-x', i % step === 0 ? mmss(it.t) : ''));
      bars.appendChild(col);
    });
    plot.appendChild(bars);
    wrap.appendChild(y);
    wrap.appendChild(plot);
    return wrap;
  }

  function valuesTable(items, col2) {
    const det = el('details', 'rep-table');
    det.appendChild(el('summary', '', 'Vezi valorile într-un tabel'));
    const tb = el('table');
    const hr = el('tr');
    hr.appendChild(el('th', '', 'De la'));
    hr.appendChild(el('th', '', col2));
    tb.appendChild(hr);
    items.forEach((it) => {
      const r = el('tr');
      r.appendChild(el('td', '', mmss(it.t)));
      r.appendChild(el('td', '', String(it.v)));
      tb.appendChild(r);
    });
    det.appendChild(tb);
    return det;
  }

  function section(title, sub) {
    const s = el('section', 'rep-sec');
    s.appendChild(el('h3', '', title));
    if (sub) s.appendChild(el('p', 'rep-sub', sub));
    return s;
  }

  function renderReport(id, title, R) {
    const box = $('report');
    box.textContent = '';
    const back = el('button', 'btn btn-ghost sm', '← Înapoi la prezentări');
    back.type = 'button';
    back.addEventListener('click', closeReport);
    box.appendChild(back);

    const head = el('div', 'head rep-head');
    head.appendChild(el('div', 'eyebrow', 'Raport'));
    head.appendChild(el('h2', '', title));
    const meta = [LANGS[R.language] || R.language, 'Înregistrare de ' + mmss(R.duration)];
    if (!R.empty) meta.push(R.words + ' de cuvinte');
    head.appendChild(el('p', '', meta.join(' · ')));
    box.appendChild(head);

    if (R.empty) {
      const s = section('Rezultat');
      R.feedback.forEach((f) => s.appendChild(feedbackItem(f)));
      box.appendChild(s);
      return;
    }

    const lv = {};
    R.feedback.forEach((f) => { lv[f.key] = f.level; });
    const tiles = el('div', 'tiles');
    tiles.appendChild(tile('Ritm', String(R.wpm), 'cuv/min', 'Ținta: 120–160', lv.wpm));
    tiles.appendChild(tile('Ezitări (ăă, um)', String(R.hesitations.count), '', R.hesitations.per_min + ' pe minut', lv.hes));
    tiles.appendChild(tile('Cuvinte de umplutură', String(R.fillers.count), '', R.fillers.per_min + ' pe minut', lv.fil));
    tiles.appendChild(tile('Pauze lungi (peste 2 s)', String(R.long_pause_count), '', 'în total ' + Math.round(R.long_pause_total) + ' s', lv.pause));
    tiles.appendChild(tile('Timp de vorbire', mmss(R.span), '', R.words + ' cuvinte'));
    tiles.appendChild(tile('Pauze scurte (1–2 s)', String(R.medium_pause_count), '', 'normale între idei'));
    box.appendChild(tiles);

    // ritm
    const pace = section('Ritmul vorbirii', 'Cuvinte pe minut, la fiecare 30 de secunde. Banda colorată arată ritmul recomandat (120–160).');
    if (R.windows.length) {
      const items = R.windows.map((w) => ({ t: w.t, v: w.wpm }));
      const max = Math.max(200, Math.ceil(Math.max(...items.map((i) => i.v)) / 20) * 20);
      pace.appendChild(barChart(items, { max, band: [120, 160], unit: 'cuv/min', aria: 'Ritmul de vorbire, în cuvinte pe minut, pentru fiecare interval de 30 de secunde' }));
      pace.appendChild(valuesTable(items, 'Cuvinte pe minut'));
    } else {
      pace.appendChild(el('p', 'rep-sub', 'Înregistrarea e prea scurtă pentru un grafic (sub 10 secunde de vorbire).'));
    }
    box.appendChild(pace);

    box.appendChild(videoSection(R.video));

    // sfaturi
    const tips = section('Sfaturi pentru vorbire');
    R.feedback.forEach((f) => tips.appendChild(feedbackItem(f)));
    box.appendChild(tips);

    // umpluturi și pauze
    const det2 = section('Unde apar ezitările și pauzele');
    const chips = el('div', 'chips');
    R.hesitations.top.forEach(([w, c]) => chips.appendChild(el('span', 'chip hes', w + ' ×' + c)));
    R.fillers.top.forEach(([w, c]) => chips.appendChild(el('span', 'chip fil', w + ' ×' + c)));
    if (!chips.children.length) chips.appendChild(el('span', 'rep-sub', 'Nu am găsit ezitări sau cuvinte de umplutură.'));
    det2.appendChild(chips);
    if (R.long_pauses.length) {
      const ul = el('ul', 'pauses');
      R.long_pauses.forEach((p) => ul.appendChild(el('li', '', 'La ' + mmss(p.at) + ' · pauză de ' + p.dur.toFixed(1) + ' secunde')));
      det2.appendChild(ul);
    }
    box.appendChild(det2);

    // transcriere
    const tr = section('Transcriere', 'Ezitările sunt marcate cu mov, cuvintele de umplutură cu portocaliu, iar pauzele lungi apar separat.');
    tr.appendChild(el('p', 'rep-note', 'Transcrierea e făcută automat și poate conține greșeli. Whisper omite uneori „ăă”, deci numărul de ezitări poate fi mai mic decât cel real.'));
    const body = el('div', 'transcript');
    R.transcript.forEach((seg) => {
      const row = el('p', 'tr-row');
      row.appendChild(el('span', 'tr-t', mmss(seg.s)));
      seg.tokens.forEach(([text, kind]) => {
        const s = el('span', 'tk ' + kind, text);
        row.appendChild(s);
        row.appendChild(document.createTextNode(' '));
      });
      body.appendChild(row);
    });
    tr.appendChild(body);
    box.appendChild(tr);
  }

  function videoSection(V) {
    const s = section('Limbajul corpului (din video)', 'Analizat din cadre luate de câteva ori pe secundă. Sunt aproximări, nu măsurători exacte.');
    if (!V) {
      s.appendChild(el('p', 'rep-note', 'Prezentarea a fost analizată înainte de adăugarea analizei video. Apasă „Analizează din nou” în lista de prezentări.'));
      return s;
    }
    if (!V.available) {
      const why = V.reason === 'audio'
        ? 'Ai încărcat o înregistrare audio, deci nu pot analiza fața și gesturile. Încarcă un video ca să le primești.'
        : V.error || 'Analiza video nu este disponibilă pentru această prezentare.';
      s.appendChild(el('p', 'rep-note', why));
      return s;
    }
    const lv = {};
    V.feedback.forEach((f) => { lv[f.key] = f.level; });
    const tiles = el('div', 'tiles');
    tiles.appendChild(tile('Față în cadru', V.face_pct + '%', '', 'din timpul înregistrării', lv.face));
    tiles.appendChild(tile('Contact vizual', V.eye_pct + '%', '', 'privești spre cameră', lv.eye));
    tiles.appendChild(tile('Zâmbet', V.smile_pct + '%', '', 'din timpul cu fața vizibilă', lv.smile));
    tiles.appendChild(tile('Mâini vizibile', V.hands_pct + '%', '', 'din timpul înregistrării'));
    tiles.appendChild(tile('Gesturi active', V.gesture_pct + '%', '', 'mâinile se mișcă', lv.gesture));
    tiles.appendChild(tile('Priviri lungi în jos', String(V.down_count), '', 'în total ' + Math.round(V.down_total) + ' s', lv.down));
    s.appendChild(tiles);
    if (V.eye_timeline.length) {
      const items = V.eye_timeline.map((w) => ({ t: w.t, v: w.pct }));
      s.appendChild(el('p', 'rep-sub chart-title', 'Contact vizual la fiecare 30 de secunde (% din timp)'));
      s.appendChild(barChart(items, { max: 100, unit: '%', aria: 'Procentul de timp în care privești spre cameră, pentru fiecare interval de 30 de secunde' }));
      s.appendChild(valuesTable(items, 'Contact vizual (%)'));
    }
    V.feedback.forEach((f) => s.appendChild(feedbackItem(f)));
    return s;
  }

  function feedbackItem(f) {
    const d = el('div', 'fb ' + f.level);
    d.appendChild(el('span', 'fb-i', LEVEL[f.level][0]));
    const t = el('div');
    t.appendChild(el('strong', '', f.title));
    t.appendChild(el('p', '', f.text));
    d.appendChild(t);
    return d;
  }

  async function openReport(id) {
    try {
      const d = await call('/api/presentations/' + id + '/analysis');
      renderReport(id, d.title, d.result);
      $('app-main').hidden = true;
      $('report').hidden = false;
      window.scrollTo(0, 0);
    } catch (e) {
      msg(e.message, true);
    }
  }
  function closeReport() {
    $('report').hidden = true;
    $('app-main').hidden = false;
    window.scrollTo(0, 0);
  }

  // apelat din index.html când se știe cine e conectat
  window.onUser = function (user) {
    if (user) {
      $('app-name').textContent = user.name.trim().split(/\s+/)[0];
      loadList();
    } else {
      stopPolling();
      closeReport();
      renderList([]);
      slidesFile = recFile = null;
      showFile('slides');
      showFile('rec');
      msg('', false);
    }
  };
})();