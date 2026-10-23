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
  const HELP_SHOW = 25000;    // cât rămâne ajutorul pe ecran (ms)
  const FPS = 10;
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
  let pdfDoc = null, slides = [], idf = new Map(), cur = 0, renderToken = 0, renderTask = null;
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
    const points = lines.filter((_, i) => i !== ti)
      .map((l) => l.text.replace(/^[•·▪‣◦\-–—*\d.)\s]+/, '').trim())
      .filter((t) => t.split(' ').length >= 2)
      .slice(0, 8)
      .map((t) => ({ text: t, kw: new Set(keywords(t)) }));
    const vocab = new Set(keywords(title));
    points.forEach((p) => p.kw.forEach((k) => vocab.add(k)));
    return { title, points, vocab, empty: false };
  }

  async function onPdf(file) {
    msg('');
    if (!file) return;
    if (!/\.pdf$/i.test(file.name)) { msg('Alege un fișier PDF. (Din PowerPoint: Fișier → Export → PDF.)', true); return; }
    if (file.size > MAX_PDF) { msg('PDF-ul e prea mare (maxim 50 MB).', true); return; }
    $('live-pdf-info').textContent = 'Citesc slide-urile…';
    try {
      await ensurePdfjs();
      const buf = await file.arrayBuffer();
      const doc = await window.pdfjsLib.getDocument({ data: buf }).promise;
      const n = Math.min(doc.numPages, MAX_PAGES);
      const list = [];
      for (let i = 1; i <= n; i++) list.push(await pageToSlide(await doc.getPage(i)));
      pdfDoc = doc; slides = list; cur = 0;
      idf = new Map();
      const df = new Map();
      slides.forEach((s) => s.vocab.forEach((k) => df.set(k, (df.get(k) || 0) + 1)));
      df.forEach((d, k) => idf.set(k, Math.log(1 + slides.length / d)));
      spoken = slides.map(() => new Set());
      slideTimes = slides.map(() => 0);
      const withText = slides.filter((s) => s.vocab.size > 0).length;
      $('live-pdf-info').textContent = file.name + ' · ' + n + (n === 1 ? ' slide' : ' slide-uri');
      $('live-pdf-clear').hidden = false;
      $('live-slidebox').hidden = false;
      $('live-grid').classList.add('has-slides');
      updateSlideLabel();
      await renderSlide();
      if (withText < Math.ceil(n / 2)) {
        msg('PDF-ul pare să conțină imagini în loc de text, așa că nu pot ghici singură slide-ul. Schimbă-l cu săgețile ← →.', false);
      }
    } catch (e) {
      clearPdf();
      msg('Nu am putut citi PDF-ul: ' + (e && e.message ? e.message : e), true);
    }
  }
  function clearPdf() {
    pdfDoc = null; slides = []; spoken = []; slideTimes = []; cur = 0;
    $('live-pdf').value = '';
    $('live-pdf-info').textContent = 'Opțional: fără PDF merge doar urmărirea gesturilor.';
    $('live-pdf-clear').hidden = true;
    $('live-slidebox').hidden = true;
    $('live-grid').classList.remove('has-slides');
  }

  async function renderSlide() {
    if (!pdfDoc) return;
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
  function buildHelp() {
    const box = el('div', 'coach');
    const lang = $('live-lang').value === 'en' ? 'en' : 'ro';
    const sec = (title, lines, cls) => {
      const s = el('div', 'coach-sec' + (cls ? ' ' + cls : ''));
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
        sec('Ce poți spune mai departe', ['Nu te aud încă (microfon sau recunoaștere vocală oprite). Pe slide ai: ' + (s.points.slice(0, 3).map((p) => p.text).join(' · ') || 'fără text')]);
      } else if (left.length) {
        sec('Ce poți spune mai departe', left.slice(0, 3).map((p) => p.text));
      } else if (cur < slides.length - 1) {
        const nx = slides[cur + 1];
        const first = nx.points[0] ? ' Poți începe cu: ' + nx.points[0].text + '.' : '';
        sec('Ce poți spune mai departe', ['Ai acoperit ce scrie pe acest slide. Treci la slide-ul ' + (cur + 2) + (nx.title ? ' („' + nx.title + '”)' : '') + '.' + first]);
      } else {
        sec('Ce poți spune mai departe', ['Ești la ultimul slide. Încheie cu ideea principală și mulțumește publicului.']);
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
    sec('Ritm și relaxare', relax, 'relax');
    return box;
  }
  function showHelp(why) {
    const panel = $('live-coach');
    const x = el('button', 'coach-x', '×');
    x.type = 'button'; x.setAttribute('aria-label', 'Închide ajutorul');
    x.addEventListener('click', () => { panel.hidden = true; });
    panel.replaceChildren(x, buildHelp());
    panel.hidden = false;
    clearTimeout(helpTimer);
    helpTimer = setTimeout(() => { panel.hidden = true; }, HELP_SHOW);
    helpCount++;
    lastHelp = now();
    const tip = $('live-tip');
    tip.replaceChildren(el('strong', '', 'Te ajut'), el('span', '', why === 'button' ? 'Sugestiile sunt sub imagine.' : 'Ai strâns pumnul. Sugestiile sunt sub imagine.'));
    tip.hidden = false;
    clearTimeout(tipTimer);
    tipTimer = setTimeout(() => { tip.hidden = true; }, 4000);
    log(now(), (why === 'button' ? 'Ai cerut ajutor' : 'Pumn strâns') + (slides.length ? ' la slide-ul ' + (cur + 1) : '') + ' – ți-am dat sugestii');
  }

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
        if (t - lastHelp >= HELP_COOLDOWN) { evaluate(true); showHelp('fist'); }
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
    cur = 0; slideLog = [{ t: 0, i: 0 }];
    if (slides.length) { updateSlideLabel(); renderSlide(); }
    $('live-log').replaceChildren();
    $('live-log-empty').hidden = false;
    $('live-summary').hidden = true;
    $('live-tip').hidden = true;
    $('live-coach').hidden = true;
    $('live-heard').textContent = '';
    t0 = lastTick = performance.now();
    lastRun = t0;
    running = true;
    $('live-start').hidden = true;
    $('live-stop').hidden = false;
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
    clearTimeout(helpTimer);
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
    $('live').hidden = true;
    $('app-main').hidden = false;
    window.scrollTo(0, 0);
  }

  $('live-open').addEventListener('click', openLive);
  $('live-back').addEventListener('click', closeLive);
  $('live-start').addEventListener('click', start);
  $('live-stop').addEventListener('click', stop);
  $('live-help').addEventListener('click', () => { evaluate(true); showHelp('button'); });
  $('live-pdf').addEventListener('change', (e) => onPdf(e.target.files[0]));
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
  window.addEventListener('pagehide', cleanup);

  // la deconectare oprim camera și uităm PDF-ul
  const prev = window.onUser;
  window.onUser = function (user) {
    if (!user) { stop(); clearPdf(); $('live').hidden = true; }
    if (prev) prev(user);
  };
})();