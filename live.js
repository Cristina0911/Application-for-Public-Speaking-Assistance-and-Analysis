// Exersare live: camera + gesturi (MediaPipe) + slide-uri din PDF (pdf.js) + voce (Web Speech).
// Când strângi pumnul, asistentul îți spune la ce slide ești, ce să spui mai departe și cum să te relaxezi.
// Imaginea de la cameră rămâne pe calculatorul tău. Pentru transcrierea vocii, Chrome/Edge trimit sunetul
// la serviciul lor de recunoaștere vocală.
(function () {
  const $ = (id) => document.getElementById(id);
  const VERSION = '0.10.14';
  const BUNDLE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@' + VERSION + '/vision_bundle.mjs';
  const WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@' + VERSION + '/wasm';
  const MODEL = 'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task';
  const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
  const PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

  const FIST_SCORE = 0.6;     // cât de sigur trebuie să fie modelul că e pumn
  const FIST_HOLD = 1.0;      // secunde de pumn continuu până vine ajutorul
  const FIST_GAP = 0.6;       // secunde fără pumn după care considerăm că ai deschis mâna
  const HELP_COOLDOWN = 10;   // secunde minime între două ajutoare
    const FPS = 10;
  const MANUAL_HOLD = 8;      // secunde în care urmărirea vocală stă pe loc după o schimbare manuală de slide
  let manualUntil = 0;
  const MAX_PDF = 50 * 1024 * 1024;
  const MAX_PAGES = 200;
  const MATCH_WINDOW = 10;    // secunde de vorbire folosite ca să ghicim slide-ul
  const HALF_LIFE = 2.5;      // după câte secunde un cuvânt contează la jumătate
  const EVAL_EVERY = 0.4;     // cât de des verificăm slide-ul (secunde)
  const CONFIRM_AFTER = 0.8;  // cât timp trebuie să rămână același slide candidat înainte să schimbăm
  const PACE_WINDOW = 30;     // secunde pentru calculul ritmului
  const FAST_WPM = 170, SLOW_WPM = 100;

  const NAMES = { Closed_Fist: 'Pumn strâns', Open_Palm: 'Palmă deschisă', Pointing_Up: 'Deget ridicat',
    Thumb_Up: 'Degetul mare sus', Thumb_Down: 'Degetul mare jos', Victory: 'V', ILoveYou: 'Semn', None: 'Mână detectată' };
  const FILLERS = {
    ro: ['deci', 'practic', 'adica', 'ei', 'nush', 'cumva', 'gen'],
    en: ['um', 'uh', 'like', 'basically', 'actually', 'so'],
  };
  const STOP = new Set(('si sau dar care este sunt pentru cand cum mai din prin intr unei unui acest aceasta aceste aceea fost fiind '
    + 'poate foarte despre catre dupa fara intre asupra doar cele celor acesta acestea sale lui lor ale the and for with that this '
    + 'from are was were have has will can not but you your our their into about which what when they them then than there').split(' '));

  // ---------- stare ----------
  let stream = null, recognizer = null, running = false, raf = 0, tipTimer = 0, helpTimer = 0;
  let t0 = 0, lastTick = 0, lastRun = 0;
  let fistSince = null, lastFist = 0, counted = false, fistCount = 0, fistTotal = 0, lastHelp = -99, helpCount = 0;
  // PDF și slide-uri
  let pdfDoc = null, textMode = false, officeOk = false, slides = [], idf = new Map(), cur = 0, renderToken = 0, renderTask = null;
  let slideTimes = [], slideLog = [];
  // vorbire
  let sr = null, srWanted = false, srOk = false;
  let finals = [];        // {w: cuvânt normalizat, raw, t}
  let interim = '';
  let spoken = [];        // per slide: Set de cuvinte-cheie spuse
  let windowFrom = 0;     // doar cuvintele de după acest moment contează pentru ghicirea slide-ului
  let candidate = null, candSince = 0, lastEval = 0;
  let fillerHits = [];    // timpi la care s-au spus cuvinte de umplutură
  let allWords = 0;

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  const mmss = (s) => { s = Math.round(s); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  const now = () => (performance.now() - t0) / 1000;
  function status(text, cls) {
    const s = $('live-status');
    s.textContent = text;
    s.className = 'live-status' + (cls ? ' ' + cls : '');
  }
  function msg(text, isErr) {
    const m = $('live-msg');
    m.textContent = text;
    m.classList.toggle('err', !!isErr);
    m.hidden = !text;
  }

  // ---------- text: cuvinte-cheie ----------
  function norm(s) {
    return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9\s]/g, ' ');
  }
  // prefix de 6 litere ca să potrivim formele diferite ale aceluiași cuvânt (prezentare/prezentarea)
  const stem = (w) => (w.length > 6 ? w.slice(0, 6) : w);
  function keywords(s) {
    return norm(s).split(/\s+/).filter((w) => w.length >= 4 && !STOP.has(w)).map(stem);
  }

  // ---------- PDF ----------
  function loadScript(src) {
    return new Promise((ok, fail) => {
      const s = document.createElement('script');
      s.src = src; s.onload = ok;
      s.onerror = () => fail(new Error('Nu am putut încărca biblioteca pentru PDF. Verifică conexiunea la internet.'));
      document.head.appendChild(s);
    });
  }
  async function ensurePdfjs() {
    if (window.pdfjsLib) return;
    await loadScript(PDFJS);
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
  }

  async function pageToSlide(page) {
    const content = await page.getTextContent();
    const rows = [];
    content.items.forEach((it) => {
      if (!it.str || !it.str.trim()) return;
      const y = it.transform[5], h = it.height || Math.abs(it.transform[3]) || 0;
      let row = rows.find((r) => Math.abs(r.y - y) < Math.max(2, h * 0.4));
      if (!row) { row = { y, h: 0, parts: [] }; rows.push(row); }
      row.h = Math.max(row.h, h);
      row.parts.push({ x: it.transform[4], s: it.str });
    });
    rows.sort((a, b) => b.y - a.y);
    const lines = rows.map((r) => ({
      h: r.h,
      text: r.parts.sort((a, b) => a.x - b.x).map((p) => p.s).join(' ').replace(/\s+/g, ' ').trim(),
    })).filter((l) => l.text);
    if (!lines.length) return { title: '', points: [], vocab: new Set(), empty: true };
    let ti = 0;
    lines.forEach((l, i) => { if (l.h > lines[ti].h + 0.5) ti = i; });
    const title = lines[ti].text;
    const texts = lines.filter((_, i) => i !== ti)
      .map((l) => l.text.replace(/^[•·▪‣◦\-–—*\d.)\s]+/, '').trim())
      .filter((t) => t.split(' ').length >= 2);
    return makeSlide(title, texts);
  }

  function makeSlide(title, texts) {
    const points = texts.slice(0, 8).map((t) => ({ text: t, kw: new Set(keywords(t)) }));
    const vocab = new Set(keywords(title));
    points.forEach((p) => p.kw.forEach((k) => vocab.add(k)));
    return { title, points, vocab, empty: !title && !points.length };
  }

  const OFFICE_EXT = ['.pptx', '.ppt', '.odp', '.docx', '.doc'];
  const TEXT_EXT = ['.pptx', '.odp', '.docx', '.txt', '.md'];
  const extOf = (n) => { const i = n.lastIndexOf('.'); return i < 0 ? '' : n.slice(i).toLowerCase(); };

  async function postFile(path, file) {
    const fd = new FormData();
    fd.append('file', file, file.name);
    const res = await fetch(path, { method: 'POST', body: fd, credentials: 'same-origin' });
    if (!res.ok) {
      let d = {};
      try { d = await res.json(); } catch (e) {}
      throw new Error(typeof d.detail === 'string' ? d.detail : 'Eroare ' + res.status);
    }
    return res;
  }

  function finishLoad(list, label) {
    slides = list; cur = 0;
    idf = new Map();
    const df = new Map();
    slides.forEach((s) => s.vocab.forEach((k) => df.set(k, (df.get(k) || 0) + 1)));
    df.forEach((d, k) => idf.set(k, Math.log(1 + slides.length / d)));
    spoken = slides.map(() => new Set());
    slideTimes = slides.map(() => 0);
    $('live-pdf-info').textContent = label + ' · ' + slides.length + (slides.length === 1 ? ' slide' : ' slide-uri');
    $('live-pdf-clear').hidden = false;
    $('live-slidebox').hidden = false;
    $('live-grid').classList.add('has-slides');
    updateSlideLabel();
    return renderSlide();
  }

  async function loadPdf(file, label) {
    await ensurePdfjs();
    const buf = await file.arrayBuffer();
    const doc = await window.pdfjsLib.getDocument({ data: buf }).promise;
    const n = Math.min(doc.numPages, MAX_PAGES);
    const list = [];
    for (let i = 1; i <= n; i++) list.push(await pageToSlide(await doc.getPage(i)));
    pdfDoc = doc; textMode = false;
    await finishLoad(list, label || file.name);
    const withText = list.filter((s) => s.vocab.size > 0).length;
    if (withText < Math.ceil(n / 2)) {
      msg('Slide-urile par să conțină imagini în loc de text, așa că nu pot ghici singură slide-ul. Schimbă-l cu săgețile ← →.', false);
    }
  }

  async function loadText(file) {
    const res = await postFile('/api/slides/parse', file);
    const data = await res.json();
    const list = (data.slides || []).map((s) => makeSlide(s.title || '', s.points || []));
    if (!list.length) throw new Error('Nu am găsit slide-uri în fișier.');
    pdfDoc = null; textMode = true;
    await finishLoad(list, file.name);
    if (list.filter((s) => s.vocab.size > 0).length < Math.ceil(list.length / 2)) {
      msg('Am găsit puțin text în fișier, așa că ghicirea automată a slide-ului poate fi nesigură. Poți schimba slide-ul cu săgețile ← →.', false);
    } else if (OFFICE_EXT.includes(extOf(file.name))) {
      if (extOf(file.name) !== '.docx') msg('Slide-urile sunt afișate ca text. Pentru aspectul real, exportă fișierul în PDF (sau instalează LibreOffice pe calculator).', false);
    }
  }

  async function onSlidesFile(file) {
    msg('');
    if (!file) return;
    const ext = extOf(file.name);
    if (file.size > MAX_PDF) { msg('Fișierul e prea mare (maxim 50 MB).', true); return; }
    if (ext !== '.pdf' && !OFFICE_EXT.includes(ext) && !TEXT_EXT.includes(ext)) {
      msg('Format neacceptat. Poți încărca PDF, PowerPoint (.pptx), Word (.docx), .odp sau .txt.', true);
      return;
    }
    $('live-pdf-info').textContent = 'Citesc slide-urile…';
    try {
      if (ext === '.pdf') {
        await loadPdf(file);
      } else {
        let done = false, lastErr = null;
        if (officeOk && OFFICE_EXT.includes(ext) && ext !== '.docx') {   // cu LibreOffice păstrăm aspectul real al slide-urilor
          try {
            $('live-pdf-info').textContent = 'Convertesc în PDF (poate dura puțin)…';
            const blob = await (await postFile('/api/slides/to-pdf', file)).blob();
            await loadPdf(new File([blob], file.name.replace(/\.[^.]+$/, '') + '.pdf', { type: 'application/pdf' }), file.name);
            done = true;
          } catch (e) { lastErr = e; }
        }
        if (!done) {
          if (!TEXT_EXT.includes(ext)) {
            throw new Error(lastErr ? lastErr.message : 'Formatul vechi (.ppt/.doc) nu poate fi citit direct. Salvează-l ca .pptx/.docx sau exportă-l în PDF.');
          }
          await loadText(file);
        }
      }
    } catch (e) {
      clearPdf();
      msg('Nu am putut citi fișierul: ' + (e && e.message ? e.message : e), true);
    }
  }
  function clearPdf() {
    pdfDoc = null; textMode = false; slides = []; spoken = []; slideTimes = []; cur = 0;
    $('live-pdf').value = '';
    $('live-pdf-info').textContent = 'Opțional: fără slide-uri merge doar urmărirea gesturilor.';
    $('live-pdf-clear').hidden = true;
    $('live-slidebox').hidden = true;
    $('live-grid').classList.remove('has-slides');
  }

  function showTextSlide() {
    const card = $('live-textslide');
    const s = slides[cur];
    const ul = el('ul');
    s.points.forEach((p) => ul.append(el('li', '', p.text)));
    card.replaceChildren(el('h3', '', s.title || '(fără titlu)'), ul);
    card.hidden = false;
    $('live-slide').hidden = true;
  }
  async function renderSlide() {
    if (textMode) { if (slides.length) showTextSlide(); return; }
    if (!pdfDoc) return;
    $('live-textslide').hidden = true;
    $('live-slide').hidden = false;
    const my = ++renderToken;
    const page = await pdfDoc.getPage(cur + 1);
    if (my !== renderToken) return;
    const canvas = $('live-slide');
    const w = canvas.parentElement.clientWidth || 560;
    const base = page.getViewport({ scale: 1 });
    const scale = w / base.width;
    const vp = page.getViewport({ scale: scale * Math.min(window.devicePixelRatio || 1, 2) });
    canvas.width = Math.round(vp.width);
    canvas.height = Math.round(vp.height);
    canvas.style.width = w + 'px';
    canvas.style.height = Math.round(base.height * scale) + 'px';
    if (renderTask) { try { renderTask.cancel(); } catch (e) {} }
    renderTask = page.render({ canvasContext: canvas.getContext('2d'), viewport: vp });
    try { await renderTask.promise; } catch (e) { /* randare anulată de un slide mai nou */ }
  }
  function updateSlideLabel() {
    $('live-slide-n').textContent = 'Slide ' + (cur + 1) + ' / ' + slides.length;
    $('live-slide-title').textContent = slides[cur] && slides[cur].title ? slides[cur].title : '';
    privHead();
    $('live-prev').disabled = cur <= 0;
    $('live-next').disabled = cur >= slides.length - 1;
  }
  function setSlide(i, how) {
    if (!slides.length) return;
    i = Math.max(0, Math.min(slides.length - 1, i));
    if (i === cur) return;
    if (how === 'auto') {
      // cuvintele spuse chiar înainte de schimbare țin de slide-ul nou
      const recent = finals.filter((f) => f.t >= now() - 8 && f.w).map((f) => f.w);
      recent.forEach((w) => spoken[i].add(w));
    } else {
      windowFrom = running ? now() : 0;   // după o schimbare manuală uităm ce s-a spus înainte
      manualUntil = running ? now() + MANUAL_HOLD : 0;
      candidate = null;
    }
    cur = i;
    updateSlideLabel();
    renderSlide();
    if (running) slideLog.push({ t: now(), i });
    if (running && how === 'auto') log(now(), 'Am detectat slide-ul ' + (cur + 1));
  }

  // ---------- ghicirea slide-ului din ce vorbești ----------
  function evaluate(force) {
    if (running && now() < manualUntil) return;   // tocmai ai schimbat tu slide-ul: nu te contrazic câteva secunde
    if (!slides.length) return;
    const t = now();
    if (!force && t - lastEval < EVAL_EVERY) return;
    lastEval = t;
    // fiecare cuvânt are o pondere care scade repede în timp: ce spui acum contează mai mult decât ce ai spus acum 8 secunde
    const wmap = new Map();
    const from = Math.max(windowFrom, t - MATCH_WINDOW);
    finals.forEach((f) => {
      if (!f.w || f.t < from) return;
      const wt = Math.pow(0.5, (t - f.t) / HALF_LIFE);
      if (wt > (wmap.get(f.w) || 0)) wmap.set(f.w, wt);
    });
    keywords(interim).forEach((w) => wmap.set(w, 1));
    wmap.forEach((_, w) => spoken[cur].add(w));
    if (wmap.size < 2) return;
    let best = -1, bestAdj = 0, bestM = 0, curAdj = 0;
    slides.forEach((s, i) => {
      let sc = 0, m = 0;
      wmap.forEach((wt, w) => { if (s.vocab.has(w)) { sc += (idf.get(w) || 0) * wt; if (wt >= 0.4) m++; } });
      const adj = sc * (i === cur ? 1.1 : i === cur + 1 ? 1.1 : 1);
      if (i === cur) curAdj = adj;
      if (adj > bestAdj) { bestAdj = adj; best = i; bestM = m; }
    });
    if (best >= 0 && best !== cur && bestM >= 2 && bestAdj > curAdj * 1.15) {
      const strong = bestM >= 3 && bestAdj > curAdj * 1.8;   // potrivire clară: schimbăm imediat
      if (strong || (candidate === best && t - candSince >= CONFIRM_AFTER) || (force && candidate === best)) {
        candidate = null; setSlide(best, 'auto');
      } else if (candidate !== best) { candidate = best; candSince = t; }
    } else {
      candidate = null;
    }
  }

  // ---------- recunoaștere vocală (Web Speech API) ----------
  function startSpeech() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      msg('Browserul tău nu are recunoaștere vocală (folosește Chrome sau Edge). Gesturile merg, iar slide-urile le schimbi cu săgețile ← →.', false);
      return;
    }
    sr = new SR();
    sr.lang = $('live-lang').value === 'en' ? 'en-US' : 'ro-RO';
    sr.continuous = true;
    sr.interimResults = true;
    srWanted = true;
    sr.onresult = (e) => {
      let tmp = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const text = r[0].transcript;
        if (r.isFinal) addFinal(text); else tmp += text;
      }
      interim = tmp;
      showHeard();
      evaluate(false);
    };
    sr.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        srWanted = false;
        msg('Nu pot folosi microfonul. Permite accesul din iconița din bara de adrese; până atunci merg doar gesturile.', true);
      } else if (e.error === 'audio-capture') {
        srWanted = false;
        msg('Nu am găsit microfonul.', true);
      } else if (e.error === 'network') {
        srWanted = false;
        msg('Recunoașterea vocală are nevoie de internet. Gesturile merg în continuare.', true);
      }
    };
    sr.onstart = () => { srOk = true; };
    sr.onend = () => {
      if (srWanted && running) setTimeout(() => { try { sr.start(); } catch (e) {} }, 300);
    };
    try { sr.start(); } catch (e) { /* deja pornită */ }
  }
  function stopSpeech() {
    srWanted = false;
    if (sr) { try { sr.onend = null; sr.stop(); } catch (e) {} }
    sr = null; srOk = false;
  }
  function addFinal(text) {
    const t = now();
    const lang = $('live-lang').value === 'en' ? 'en' : 'ro';
    norm(text).split(/\s+/).filter(Boolean).forEach((w) => {
      allWords++;
      if (FILLERS[lang].includes(w)) fillerHits.push(t);
      if (w.length >= 4 && !STOP.has(w)) finals.push({ w: stem(w), raw: w, t });
      else finals.push({ w: '', raw: w, t });   // cuvintele scurte contează doar pentru ritm
    });
    finals = finals.filter((f) => f.t >= t - 120);
  }
  function showHeard() {
    const recent = finals.filter((f) => f.t >= now() - 12).map((f) => f.raw).join(' ');
    const txt = (recent + ' ' + interim).trim();
    $('live-heard').textContent = txt ? '“' + txt.slice(-160) + '”' : '';
  }
  function currentWpm() {
    const t = now();
    const recent = finals.filter((f) => f.t >= t - PACE_WINDOW);
    if (recent.length < 12) return null;
    const span = Math.max(10, Math.min(PACE_WINDOW, t - recent[0].t));
    return Math.round((recent.length / span) * 60);
  }

  // ---------- ajutorul (când strângi pumnul) ----------
  function isCovered(point, set) {
    const n = point.kw.size;
    if (n === 0) return true;
    let c = 0;
    point.kw.forEach((k) => { if (set.has(k)) c++; });
    return c >= Math.ceil(n * 0.5);
  }
  // ---------- consola privată: fereastră separată, pe ecranul tău (nu pe cel proiectat) ----------
  let priv = null;
  function privOpen() { return !!(priv && !priv.closed && priv.document && priv.document.getElementById('p-coach')); }
  function privHead() {
    if (!privOpen()) return;
    const d = priv.document;
    d.getElementById('p-slide').textContent = slides.length ? 'Slide ' + (cur + 1) + ' / ' + slides.length : 'Fără slide-uri';
    d.getElementById('p-title').textContent = slides[cur] && slides[cur].title ? slides[cur].title : '';
    d.getElementById('p-time').textContent = running ? mmss(now()) : '';
    d.getElementById('p-state').textContent = !running ? 'Prezentarea nu a început' : assistOn ? 'Asistent PORNIT' + (aiState.lastAt > 0 ? ' · sugestie AI acum ' + Math.max(0, Math.round(now() - aiState.lastAt)) + ' s' : '') : 'Asistent oprit';
  }
  function wirePrivate() {
    const d = priv.document;
    d.getElementById('p-help').addEventListener('click', () => { if (running) toggleAssist(); });
    d.getElementById('p-prev').addEventListener('click', () => setSlide(cur - 1, 'manual'));
    d.getElementById('p-next').addEventListener('click', () => setSlide(cur + 1, 'manual'));
    d.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); setSlide(cur + 1, 'manual'); }
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); setSlide(cur - 1, 'manual'); }
    });
    privHead();
    setAssistUi();
    // cronometrul din fereastra privată nu e încetinit de browser când fereastra principală e acoperită
    try { priv.setInterval(assistTick, 1500); } catch (e) {}
    if (assistOn) { lastSig = ''; renderAssist(true); }
  }
  function openPrivate() {
    if (privOpen()) { priv.focus(); return; }
    priv = window.open('/private', 'speakcoach-private', 'popup=yes,width=560,height=' + Math.max(420, Math.min(720, (screen.availHeight || 800) - 90)));
    if (!priv) { msg('Browserul a blocat fereastra nouă. Permite ferestrele pop-up pentru localhost:8000 (iconița din bara de adrese) și apasă din nou.', true); return; }
    $('live-private').textContent = 'Consolă privată deschisă';
    const mine = priv;
    let tries = 0;
    const t = setInterval(() => {   // așteptăm să se încarce pagina din fereastra nouă
      if (mine !== priv || mine.closed || ++tries > 100) { clearInterval(t); return; }
      if (privOpen() && mine.document.readyState === 'complete') { clearInterval(t); wirePrivate(); }
    }, 100);
  }
  function closePrivate() {
    if (priv && !priv.closed) { try { priv.close(); } catch (e) {} }
    priv = null;
    $('live-private').textContent = 'Deschide consola privată';
  }

  function buildHelp() {
    const box = el('div', 'coach');
    const lang = $('live-lang').value === 'en' ? 'en' : 'ro';
    const sec = (title, lines, cls, key) => {
      const s = el('div', 'coach-sec' + (cls ? ' ' + cls : ''));
      if (key) s.dataset.k = key;
      s.append(el('h4', '', title));
      if (lines.length === 1) s.append(el('p', '', lines[0]));
      else { const ul = el('ul'); lines.forEach((l) => ul.append(el('li', '', l))); s.append(ul); }
      box.append(s);
    };
    const summary = [];
    if (slides.length) {
      const s = slides[cur];
      const set = new Set(spoken[cur]);
      keywords(interim).forEach((w) => set.add(w));
      finals.filter((f) => f.t >= now() - 15 && f.w).forEach((f) => set.add(f.w));
      sec('Ești la slide-ul ' + (cur + 1) + ' din ' + slides.length, [s.title ? '„' + s.title + '”' : '(slide fără titlu)']);
      const left = s.points.filter((p) => !isCovered(p, set));
      if (!srOk && !finals.length) {
        sec('Ce poți spune mai departe', ['Nu te aud încă (microfon sau recunoaștere vocală oprite). Pe slide ai: ' + (s.points.slice(0, 3).map((p) => p.text).join(' · ') || 'fără text')], '', 'next');
      } else if (left.length) {
        sec('Ce poți spune mai departe', left.slice(0, 3).map((p) => p.text), '', 'next');
      } else if (cur < slides.length - 1) {
        const nx = slides[cur + 1];
        const first = nx.points[0] ? ' Poți începe cu: ' + nx.points[0].text + '.' : '';
        sec('Ce poți spune mai departe', ['Ai acoperit ce scrie pe acest slide. Treci la slide-ul ' + (cur + 2) + (nx.title ? ' („' + nx.title + '”)' : '') + '.' + first], '', 'next');
      } else {
        sec('Ce poți spune mai departe', ['Ești la ultimul slide. Încheie cu ideea principală și mulțumește publicului.'], '', 'next');
      }
    } else {
      sec('Slide-uri', ['Nu ai încărcat un PDF, așa că nu știu la ce slide ești. Încarcă-l ca să te pot ghida.']);
    }
    // ritm și relaxare
    const relax = [];
    const wpm = currentWpm();
    if (wpm !== null) {
      if (wpm > FAST_WPM) relax.push('Vorbești repede (~' + wpm + ' cuvinte/minut). Fă o pauză și încetinește.');
      else if (wpm < SLOW_WPM) relax.push('Vorbești rar (~' + wpm + ' cuvinte/minut). Poți ridica puțin ritmul.');
      else relax.push('Ritmul tău e bun (~' + wpm + ' cuvinte/minut).');
    }
    const fl = fillerHits.filter((t) => t >= now() - 60).length;
    if (fl >= 3) relax.push('Ai spus de ' + fl + ' ori „' + FILLERS[lang].slice(0, 3).join('/') + '” în ultimul minut. O pauză scurtă e mai bună decât un cuvânt de umplutură.');
    relax.push('Respiră adânc, lasă umerii jos și deschide palma. Ai pregătit asta, ești pregătit(ă).');
    sec('Ritm și relaxare', relax, 'relax', 'relax');
    return box;
  }
  // ---------- sugestii AI (prin server, cu Groq) ----------
  let aiEnabled = false;
  fetch('/api/config', { credentials: 'same-origin' }).then((r) => r.json()).then((c) => {
    aiEnabled = !!c.coach_ai;
    officeOk = !!c.office;
    $('live-ai-note').hidden = !aiEnabled;
  }).catch(() => {});

  function aiPayload() {
    const lang = $('live-lang').value === 'en' ? 'en' : 'ro';
    const s = slides[cur], nx = slides[cur + 1];
    const set = new Set(spoken[cur]);
    keywords(interim).forEach((w) => set.add(w));
    finals.filter((f) => f.t >= now() - 15 && f.w).forEach((f) => set.add(f.w));
    const heard = (finals.filter((f) => f.t >= now() - 40).map((f) => f.raw).join(' ') + ' ' + interim).trim().slice(-1200);
    return {
      lang, slide: cur + 1, total: slides.length,
      title: s.title || '',
      points: s.points.map((p) => p.text),
      missing: s.points.filter((p) => !isCovered(p, set)).map((p) => p.text),
      next_title: nx ? nx.title || '' : '',
      next_points: nx ? nx.points.slice(0, 4).map((p) => p.text) : [],
      heard,
      wpm: currentWpm(),
      fillers: fillerHits.filter((t) => t >= now() - 60).length,
    };
  }
  // ---------- asistent continuu: se pornește o dată (pumn sau buton) și rămâne activ ----------
  const AI_MIN_GAP = 15;      // secunde minime între două cereri AI când doar vorbești
  let assistOn = false, assistTimer = 0, lastSig = '';
  const aiState = { slide: -1, say: '', extra: [], relax: '', pending: false, lastAt: -99, words: 0, backoff: 0, err: '' };

  function assistPanel() { return privOpen() ? priv.document.getElementById('p-coach') : $('live-coach'); }
  function setAssistUi() {
    $('live-help').textContent = assistOn ? 'Oprește asistentul' : 'Pornește asistentul';
    if (privOpen()) priv.document.getElementById('p-help').textContent = assistOn ? 'Oprește asistentul' : 'Pornește asistentul';
  }
  function applyAi(box) {
    if (!aiEnabled || !slides.length) return;
    const nextSec = box.querySelector('[data-k="next"]');
    const relaxSec = box.querySelector('[data-k="relax"]');
    if (!nextSec) return;
    if (aiState.slide === cur && (aiState.say || aiState.relax || aiState.extra.length)) {
      box.classList.add('has-ai');
      if (aiState.say) {
        const t = el('div', 'ai-say');
        t.append(el('span', 'ai-tag', 'AI'), el('span', '', aiState.say));
        nextSec.querySelector('h4').after(t);
      }
      if (aiState.extra.length) {
        const sec = el('div', 'coach-sec extra');
        sec.append(el('h4', '', 'În plus, poți spune'));
        const ul = el('ul');
        aiState.extra.forEach((x) => { const li = el('li'); li.append(el('span', 'ai-tag', 'AI'), document.createTextNode(' ' + x)); ul.append(li); });
        sec.append(ul);
        nextSec.after(sec);
        box.classList.add('has-extra');
      }
      if (aiState.relax && relaxSec) {
        const t = el('div', 'ai-say');
        t.append(el('span', 'ai-tag', 'AI'), el('span', '', aiState.relax));
        relaxSec.querySelector('h4').after(t);
        const gen = relaxSec.querySelector('li:last-child') || relaxSec.querySelector('p');
        if (gen) gen.remove();   // sfatul generic e înlocuit de cel AI
      }
    } else if (aiState.err) {
      nextSec.append(el('p', 'coach-ai', 'Sugestiile AI nu sunt disponibile acum (' + aiState.err + '). Ți le arăt pe cele de bază.'));
    } else {
      nextSec.append(el('p', 'coach-ai', 'Asistentul AI se gândește…'));
    }
  }
  function renderAssist(force) {
    if (!assistOn) return;
    const inPriv = privOpen();
    const panel = assistPanel();
    const box = buildHelp();
    applyAi(box);
    const sig = (inPriv ? 'p|' : 'm|') + box.textContent;
    if (!force && sig === lastSig) return;
    lastSig = sig;
    if (inPriv) {
      $('live-coach').hidden = true;
      panel.replaceChildren(box);
    } else {
      const x = el('button', 'coach-x', '×');
      x.type = 'button'; x.setAttribute('aria-label', 'Oprește asistentul');
      x.addEventListener('click', stopAssist);
      panel.replaceChildren(x, box);
    }
    panel.hidden = false;
  }
  async function maybeAsk(force) {
    if (!assistOn || !aiEnabled || !slides.length || aiState.pending) return;
    const t = now();
    if (t < aiState.backoff) return;
    const since = t - aiState.lastAt;
    const newWords = allWords - aiState.words;
    const changed = aiState.slide !== cur;
    if (!(force || (changed && since >= 4) || (newWords >= 12 && since >= AI_MIN_GAP) || (newWords >= 3 && since >= 45))) return;
    aiState.pending = true;
    const askedSlide = cur;
    const payload = aiPayload();
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 12000);
    try {
      const res = await fetch('/api/coach', {
        method: 'POST', credentials: 'same-origin', signal: ctl.signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      let data = {};
      try { data = await res.json(); } catch (e) {}
      if (!res.ok) { const er = new Error(typeof data.detail === 'string' ? data.detail : 'eroare ' + res.status); er.status = res.status; throw er; }
      aiState.slide = askedSlide; aiState.say = data.say_next || ''; aiState.extra = Array.isArray(data.extra) ? data.extra : []; aiState.relax = data.relax || ''; aiState.err = '';
      aiState.lastAt = now(); aiState.words = allWords;
    } catch (e) {
      aiState.err = e.name === 'AbortError' ? 'răspuns prea lent' : e.message;
      aiState.lastAt = now();
      aiState.backoff = now() + (e.status === 429 ? 45 : 15);
    } finally {
      clearTimeout(to);
      aiState.pending = false;
      renderAssist(true);
    }
  }
  function assistTick() {
    privHead();
    if (!running || !assistOn) return;
    renderAssist(false);
    maybeAsk(false);
  }
  function startAssist(why) {
    if (assistOn) return;
    assistOn = true;
    lastSig = '';
    helpCount++;
    lastHelp = now();
    aiState.err = ''; aiState.backoff = 0;
    clearInterval(assistTimer);
    assistTimer = setInterval(assistTick, 1500);
    setAssistUi();
    evaluate(true);
    renderAssist(true);
    maybeAsk(true);
    const inPriv = privOpen();
    const tip = $('live-tip');
    tip.replaceChildren(el('strong', '', 'Asistentul e pornit'), el('span', '', (why === 'button' ? '' : 'Ai strâns pumnul. ') + 'Te urmăresc până îl oprești. ' + (inPriv ? 'Sugestiile sunt în consola privată.' : 'Sugestiile sunt sub imagine.')));
    tip.hidden = false;
    clearTimeout(tipTimer);
    tipTimer = setTimeout(() => { tip.hidden = true; }, 5000);
    log(now(), (why === 'button' ? 'Ai pornit asistentul' : 'Pumn strâns – asistent pornit') + (slides.length ? ' la slide-ul ' + (cur + 1) : ''));
  }
  function refreshNow() {
    lastHelp = now();
    evaluate(true);
    renderAssist(true);
    maybeAsk(true);
    log(now(), 'Pumn strâns – am reîmprospătat sugestiile');
  }
  function stopAssist() {
    if (!assistOn) return;
    assistOn = false;
    clearInterval(assistTimer);
    $('live-coach').hidden = true;
    if (privOpen()) {
      const p = priv.document.getElementById('p-coach');
      const msgEl = priv.document.createElement('p');
      msgEl.className = 'priv-empty';
      msgEl.textContent = 'Asistentul e oprit. Strânge pumnul sau apasă „Pornește asistentul” ca să continue.';
      p.replaceChildren(msgEl);
    }
    setAssistUi();
    if (running) log(now(), 'Asistent oprit');
  }
  function toggleAssist() { if (assistOn) stopAssist(); else startAssist('button'); }

  function log(t, text) {
    const li = el('li');
    li.append(el('b', '', mmss(t)), document.createTextNode(' ' + text));
    $('live-log').prepend(li);
    $('live-log-empty').hidden = true;
  }

  // ---------- gesturi ----------
  async function loadRecognizer() {
    if (window.__liveTestRecognizer) return window.__liveTestRecognizer;
    const mod = await import(BUNDLE);
    const fileset = await mod.FilesetResolver.forVisionTasks(WASM);
    return mod.GestureRecognizer.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL },
      runningMode: 'VIDEO', numHands: 2,
    });
  }

  function onFrame(t, gestureName, score) {
    const dt = Math.min(t - lastTick, 0.5);
    lastTick = t;
    if (slides.length) slideTimes[cur] += dt;
    const isFist = gestureName === 'Closed_Fist' && score >= FIST_SCORE;
    if (isFist) {
      lastFist = t;
      fistTotal += dt;
      if (fistSince === null) fistSince = t;
      if (!counted && t - fistSince >= FIST_HOLD) {
        counted = true;
        fistCount++;
        if (!assistOn) startAssist('fist');
        else if (t - lastHelp >= HELP_COOLDOWN) refreshNow();
        else log(t, 'Pumn strâns');
      }
    } else if (fistSince !== null && t - lastFist > FIST_GAP) {
      fistSince = null;
      counted = false;
    }
    if (gestureName) status(NAMES[gestureName] || 'Mână detectată', isFist ? 'warn' : 'ok');
    else status('Nu văd mâinile', '');
  }

  function loop() {
    if (!running) return;
    raf = requestAnimationFrame(loop);
    const ts = performance.now();
    if (ts - lastRun < 1000 / FPS) return;
    lastRun = ts;
    const v = $('live-video');
    if (v.readyState < 2) return;
    let name = null, score = 0;
    try {
      const r = recognizer.recognizeForVideo(v, ts);
      (r.gestures || []).forEach((g) => {
        const c = g && g[0];
        if (!c) return;
        if (name === null || (c.categoryName === 'Closed_Fist' && c.score > score)) { name = c.categoryName; score = c.score; }
      });
    } catch (e) {
      stop(); msg('A apărut o eroare la recunoaștere: ' + e.message, true); return;
    }
    onFrame(now(), name, score);
    evaluate(false);   // confirmă slide-ul chiar dacă tocmai ai tăcut
    $('live-time').textContent = mmss(now());
    privHead();
  }

  async function start() {
    msg('');
    $('live-start').disabled = true;
    status('Pornesc camera…', '');
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('Browserul nu permite accesul la cameră (folosește http://localhost:8000).');
      }
      stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 960 }, height: { ideal: 540 } }, audio: false });
      const v = $('live-video');
      v.srcObject = stream;
      await v.play();
      status('Încarc modelul (prima dată durează puțin)…', '');
      recognizer = await loadRecognizer();
    } catch (e) {
      cleanup();
      $('live-start').disabled = false;
      status('Oprit', '');
      const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
      const nocam = e && e.name === 'NotFoundError';
      msg(denied ? 'Nu am voie să folosesc camera. Apasă pe iconița de cameră din bara de adrese și permite accesul.'
        : nocam ? 'Nu am găsit nicio cameră.'
        : 'Nu am putut porni: ' + (e && e.message ? e.message : e) + '. Verifică conexiunea la internet (modelul se descarcă prima dată).', true);
      return;
    }
    fistSince = null; counted = false; fistCount = 0; fistTotal = 0; lastHelp = -99; helpCount = 0;
    finals = []; interim = ''; fillerHits = []; allWords = 0; candidate = null; lastEval = 0; windowFrom = 0;
    spoken = slides.map(() => new Set());
    slideTimes = slides.map(() => 0);
    cur = 0; slideLog = [{ t: 0, i: 0 }]; manualUntil = 0;
    if (slides.length) { updateSlideLabel(); renderSlide(); }
    $('live-log').replaceChildren();
    $('live-log-empty').hidden = false;
    $('live-summary').hidden = true;
    $('live-tip').hidden = true;
    stopAssist(); $('live-coach').hidden = true;
    Object.assign(aiState, { slide: -1, say: '', extra: [], relax: '', pending: false, lastAt: -99, words: 0, backoff: 0, err: '' });
    $('live-heard').textContent = '';
    t0 = lastTick = performance.now();
    lastRun = t0;
    running = true;
    $('live-start').hidden = true;
    $('live-stop').hidden = false;
    privHead();
    $('live-help').hidden = false;
    $('live-rec').hidden = false;
    status('Nu văd mâinile', '');
    $('live-grid').scrollIntoView({ block: 'start' });
    startSpeech();
    loop();
  }

  function cleanup() {
    running = false;
    cancelAnimationFrame(raf);
    stopSpeech();
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
    $('live-video').srcObject = null;
    if (recognizer && recognizer.close && !window.__liveTestRecognizer) { try { recognizer.close(); } catch (e) {} }
    recognizer = null;
  }

  function stop() {
    const was = running;
    const dur = now();
    const wpmAll = dur > 20 && allWords >= 20 ? Math.round(allWords / (dur / 60)) : null;
    cleanup();
    $('live-start').hidden = false;
    $('live-start').disabled = false;
    $('live-start').textContent = 'Începe din nou';
    $('live-stop').hidden = true;
    $('live-help').hidden = true;
    $('live-rec').hidden = true;
    $('live-tip').hidden = true;
    $('live-coach').hidden = true;
    stopAssist();
    privHead();
    status('Oprit', '');
    if (!was) return;
    const rows = [];
    const row = (k, v) => { const r = el('div', 'sum-row'); r.append(el('span', '', k), el('b', '', v)); rows.push(r); };
    row('Durată', mmss(dur));
    row('Pumn strâns', fistCount === 0 ? 'nu a fost' : fistCount + (fistCount === 1 ? ' moment' : ' momente') + ' (' + Math.round(fistTotal) + ' s în total)');
    row('Ajutor primit', helpCount + (helpCount === 1 ? ' dată' : ' ori'));
    if (wpmAll) row('Ritm mediu', '~' + wpmAll + ' cuvinte/minut');
    if (slides.length) {
      slideTimes.forEach((s, i) => { if (s >= 1) row('Slide ' + (i + 1) + (slides[i].title ? ' · ' + slides[i].title.slice(0, 40) : ''), mmss(s)); });
    }
    const verdict = fistCount === 0
      ? 'Bravo, nu ai strâns pumnul. Mâinile relaxate dau încredere.'
      : 'Ai strâns pumnul de ' + fistCount + (fistCount === 1 ? ' dată' : ' ori') + '. Exersează să ții palma deschisă când vorbești.';
    $('live-summary').replaceChildren(el('h3', '', 'Rezumatul exersării'), ...rows, el('p', 'sum-note', verdict));
    $('live-summary').hidden = false;
  }

  function openLive() {
    $('app-main').hidden = true;
    $('live').hidden = false;
    msg('');
    window.scrollTo(0, 0);
    renderSlide();
  }
  function closeLive() {
    stop();
    closePrivate();
    $('live').hidden = true;
    $('app-main').hidden = false;
    window.scrollTo(0, 0);
  }

  $('live-private').addEventListener('click', openPrivate);
  $('live-open').addEventListener('click', openLive);
  $('live-back').addEventListener('click', closeLive);
  $('live-start').addEventListener('click', start);
  $('live-stop').addEventListener('click', stop);
  $('live-help').addEventListener('click', toggleAssist);
  $('live-pdf').addEventListener('change', (e) => onSlidesFile(e.target.files[0]));
  $('live-pdf-clear').addEventListener('click', clearPdf);
  $('live-prev').addEventListener('click', () => setSlide(cur - 1, 'manual'));
  $('live-next').addEventListener('click', () => setSlide(cur + 1, 'manual'));
  document.addEventListener('keydown', (e) => {
    if ($('live').hidden || !slides.length) return;
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); setSlide(cur + 1, 'manual'); }
    if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); setSlide(cur - 1, 'manual'); }
  });
  let rs = 0;
  window.addEventListener('resize', () => { clearTimeout(rs); rs = setTimeout(renderSlide, 200); });
  window.addEventListener('pagehide', () => { cleanup(); closePrivate(); });

  // la deconectare oprim camera și uităm PDF-ul
  const prev = window.onUser;
  window.onUser = function (user) {
    if (!user) { stop(); closePrivate(); clearPdf(); $('live').hidden = true; }
    if (prev) prev(user);
  };
})();