'use strict';
/* =============================================================================
   PSOE STRIKES BACK
   -----------------------------------------------------------------------------
   Un juego de supervivencia contra hordas (estilo "Vampire Survivors") hecho
   solo con HTML, CSS y JavaScript, sin librerías. Todo se dibuja con Canvas 2D
   y todos los sonidos y la música se generan en tiempo real con Web Audio.

   Índice:
     1. Utilidades
     2. Sonido y música
     3. Lienzo, sprites y fondo
     4. Datos del juego (enemigos, armas, mejoras, jefes, eventos)
     5. Estado de la partida
     6. Entrada (teclado y táctil)
     7. Lógica (jugador, enemigos, armas, objetos, jefes...)
     8. Dibujado
     9. Interfaz (menús, subida de nivel, cofres, fin de partida)
    10. Bucle principal
   ============================================================================= */
(() => {

// =============================================================================
// 1. UTILIDADES
// =============================================================================
const TAU = Math.PI * 2;
const rand = (a = 1, b) => (b === undefined ? Math.random() * a : a + Math.random() * (b - a));
const randInt = (a, b) => Math.floor(rand(a, b + 1));
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const dist2 = (ax, ay, bx, by) => { const dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; };
const fmtTime = s => {
  s = Math.max(0, Math.floor(s));
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
};
const fmtNum = n => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e4 ? (n / 1e3).toFixed(1) + 'k' : Math.round(n).toLocaleString('es-ES'));

const rgbCache = new Map();
function rgb(hex) {
  let c = rgbCache.get(hex);
  if (!c) {
    const n = parseInt(hex.slice(1), 16);
    c = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    rgbCache.set(hex, c);
  }
  return c;
}
const rgba = (hex, a) => { const [r, g, b] = rgb(hex); return `rgba(${r},${g},${b},${a})`; };

// Elige un elemento al azar según su peso: [[elemento, peso], ...]
function weightedPick(list) {
  let total = 0;
  for (const [, w] of list) total += w;
  let r = Math.random() * total;
  for (const [item, w] of list) if ((r -= w) <= 0) return item;
  return list[list.length - 1][0];
}

const $ = id => document.getElementById(id);
const show = el => el.classList.remove('hidden');
const hide = el => el.classList.add('hidden');

// Guardado local (récord, música on/off). Si el navegador lo bloquea, no pasa nada.
const store = {
  get(k, def) {
    try { const v = localStorage.getItem('hordaneon.' + k); return v === null ? def : JSON.parse(v); } catch (e) { return def; }
  },
  set(k, v) { try { localStorage.setItem('hordaneon.' + k, JSON.stringify(v)); } catch (e) { /* sin guardado */ } },
};

// ¿Es un móvil o tablet? (?touch=1 en la dirección fuerza el modo táctil para pruebas)
const params = new URLSearchParams(location.search);
const IS_TOUCH = params.has('touch') || !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
if (IS_TOUCH) document.documentElement.classList.add('touch');
const TEXT_SCALE = IS_TOUCH ? 1.25 : 1; // números de daño algo más grandes en pantallas pequeñas

// Vibración (funciona en Android; los iPhone no la permiten desde el navegador)
let vibrateOn = store.get('vibrate', true);
function buzz(pattern) {
  if (!IS_TOUCH || !vibrateOn || typeof navigator === 'undefined' || !navigator.vibrate) return;
  try { navigator.vibrate(pattern); } catch (e) { /* sin vibración */ }
}

// =============================================================================
// 2. SONIDO Y MÚSICA (todo sintetizado, no hay archivos de audio)
// =============================================================================
const Sound = (() => {
  let ac = null, master, sfxBus, musicBus, musicFilter, noiseBuf;
  let guitar, leadA, leadB, echoIn, verbIn, choirIn; // instrumentos de la música
  let musicOn = store.get('music', true);
  let beatCb = null, fadeTimer = 0;
  const MUSIC_VOL = 0.22;
  // En móviles la banda usa una versión más ligera (eco simple en vez de reverberación
  // y menos voces en cuerdas y coro) para que no dé tirones
  const LITE = IS_TOUCH;
  const last = {};

  function init() {
    // En móvil el audio se "duerme" al cambiar de app: se despierta al volver a tocar
    if (ac) { if (ac.state !== 'running') ac.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try { ac = new AC(); } catch (e) { ac = null; return; }

    // Compresor final para que nada sature cuando hay muchas explosiones
    const comp = ac.createDynamicsCompressor();
    comp.threshold.value = -12; comp.knee.value = 10; comp.ratio.value = 6;
    comp.attack.value = 0.003; comp.release.value = 0.2;
    comp.connect(ac.destination);

    master = ac.createGain(); master.gain.value = 0.6; master.connect(comp);
    sfxBus = ac.createGain(); sfxBus.gain.value = 0.8; sfxBus.connect(master);

    // La música pasa por un filtro: al pausar se "amortigua" como bajo el agua
    musicFilter = ac.createBiquadFilter();
    musicFilter.type = 'lowpass'; musicFilter.frequency.value = 16000;
    musicFilter.connect(master);
    musicBus = ac.createGain(); musicBus.gain.value = musicOn ? MUSIC_VOL : 0;
    musicBus.connect(musicFilter);

    // Ruido blanco reutilizable (explosiones, platillos...)
    noiseBuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;

    buildBand();
  }

  // Panorámica izquierda/derecha (si el navegador no la tiene, suena en el centro)
  function pan(v) {
    if (!ac.createStereoPanner) return ac.createGain();
    const p = ac.createStereoPanner();
    p.pan.value = v;
    return p;
  }

  // Amplificador de guitarra simulado: saturación + filtros de "altavoz"
  function amp(drive, cut, vol) {
    const pre = ac.createGain(); pre.gain.value = drive;
    const sh = ac.createWaveShaper(), n = 2048, curve = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; curve[i] = Math.tanh(x * 4) / Math.tanh(4); }
    sh.curve = curve; sh.oversample = LITE ? 'none' : '2x';
    const hp = ac.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 90;
    const scoop = ac.createBiquadFilter(); scoop.type = 'peaking'; scoop.frequency.value = 500; scoop.Q.value = 0.8; scoop.gain.value = -4;
    const bite = ac.createBiquadFilter(); bite.type = 'peaking'; bite.frequency.value = 1800; bite.Q.value = 1; bite.gain.value = 4;
    const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = cut;
    const out = ac.createGain(); out.gain.value = vol;
    pre.connect(sh); sh.connect(hp); hp.connect(scoop); scoop.connect(bite); bite.connect(lp); lp.connect(out);
    return { input: pre, out };
  }

  function buildBand() {
    // Reverberación (sala grande) para batería, cuerdas, coro y solos
    verbIn = ac.createGain();
    const verbOut = ac.createGain();
    if (LITE) { // eco corto: suena a sala y apenas gasta
      const d = ac.createDelay(0.2); d.delayTime.value = 0.09;
      verbOut.gain.value = 0.22;
      verbIn.connect(d); d.connect(verbOut);
    } else {
      const conv = ac.createConvolver(), len = Math.floor(ac.sampleRate * 1.3);
      const ir = ac.createBuffer(2, len, ac.sampleRate);
      for (let c = 0; c < 2; c++) {
        const ch = ir.getChannelData(c);
        for (let i = 0; i < len; i++) ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
      }
      conv.buffer = ir;
      verbOut.gain.value = 0.3;
      verbIn.connect(conv); conv.connect(verbOut);
    }
    verbOut.connect(musicBus);

    // Guitarra rítmica "doblada": una a la izquierda y la otra, un pelín retrasada, a la derecha
    guitar = amp(5, 4200, 0.19);
    const gl = pan(-0.75), gr = pan(0.75), dl = ac.createDelay(0.05);
    dl.delayTime.value = 0.017;
    guitar.out.connect(gl); gl.connect(musicBus);
    guitar.out.connect(dl); dl.connect(gr); gr.connect(musicBus);

    // Dos guitarras solistas (melodía y armonía) con eco
    echoIn = ac.createGain();
    const delay = ac.createDelay(1); delay.delayTime.value = STEP * 3;
    const feedback = ac.createGain(); feedback.gain.value = 0.3;
    const wet = ac.createGain(); wet.gain.value = 0.22;
    echoIn.connect(delay); delay.connect(feedback); feedback.connect(delay);
    delay.connect(wet); wet.connect(musicBus);
    leadA = amp(4, 5000, 0.13);
    leadB = amp(4, 5000, 0.075);
    const la = pan(-0.2), lb = pan(0.4);
    leadA.out.connect(la); la.connect(musicBus);
    leadB.out.connect(lb); lb.connect(musicBus);
    for (const l of [leadA, leadB]) { l.out.connect(echoIn); l.out.connect(verbIn); }

    // Coro "Aaah": ondas filtradas por las resonancias de la voz humana
    choirIn = ac.createGain();
    const choirOut = ac.createGain(); choirOut.gain.value = 1;
    for (const [f, q, v] of [[700, 6, 1], [1150, 8, 0.55], [2600, 10, 0.25]]) {
      const bp = ac.createBiquadFilter(), g = ac.createGain();
      bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = q; g.gain.value = v;
      choirIn.connect(bp); bp.connect(g); g.connect(choirOut);
    }
    choirOut.connect(musicBus); choirOut.connect(verbIn);
  }

  const ready = () => ac && ac.state === 'running';
  // Evita que el mismo sonido se repita cientos de veces por segundo
  function gate(name, ms) {
    const t = performance.now();
    if (last[name] && t - last[name] < ms) return false;
    last[name] = t;
    return true;
  }

  function env(g, t, vol, atk, dur) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + atk);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  }

  function tone({ type = 'sine', f = 440, f2 = 0, dur = 0.1, vol = 0.2, atk = 0.004, when = 0, cutoff = 0, bus = sfxBus }) {
    const t = ac.currentTime + when;
    const osc = ac.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(f, t);
    if (f2) osc.frequency.exponentialRampToValueAtTime(f2, t + dur);
    const g = ac.createGain();
    env(g, t, vol, atk, dur);
    let node = osc;
    if (cutoff) {
      const fl = ac.createBiquadFilter();
      fl.type = 'lowpass'; fl.frequency.value = cutoff;
      osc.connect(fl); node = fl;
    }
    node.connect(g); g.connect(bus);
    osc.start(t); osc.stop(t + dur + 0.05);
  }

  function noise({ dur = 0.2, vol = 0.2, type = 'lowpass', f = 1200, f2 = 0, q = 0.8, when = 0, atk = 0.003, bus = sfxBus }) {
    const t = ac.currentTime + when;
    const src = ac.createBufferSource();
    src.buffer = noiseBuf; src.loop = true;
    const fl = ac.createBiquadFilter();
    fl.type = type; fl.Q.value = q;
    fl.frequency.setValueAtTime(f, t);
    if (f2) fl.frequency.exponentialRampToValueAtTime(f2, t + dur);
    const g = ac.createGain();
    env(g, t, vol, atk, dur);
    src.connect(fl); fl.connect(g); g.connect(bus);
    src.start(t, Math.random() * 0.5); src.stop(t + dur + 0.05);
  }

  const semi = n => Math.pow(2, n / 12);

  const sfx = {
    shoot()  { if (!ready() || !gate('shoot', 75)) return; tone({ type: 'square', f: rand(820, 940), f2: 380, dur: 0.07, vol: 0.03, cutoff: 3000 }); },
    hit()    { if (!ready() || !gate('hit', 40)) return; noise({ dur: 0.05, vol: 0.06, type: 'highpass', f: 2200 }); },
    kill()   {
      if (!ready() || !gate('kill', 50)) return;
      tone({ type: 'triangle', f: rand(320, 460), f2: 70, dur: 0.14, vol: 0.1 });
      noise({ dur: 0.09, vol: 0.05, type: 'bandpass', f: 1500, q: 1.5 });
    },
    gem(n)   {
      if (!ready() || !gate('gem', 30)) return;
      const f = 520 * semi(Math.min(n, 24));
      tone({ type: 'sine', f, f2: f * 1.5, dur: 0.08, vol: 0.055 });
    },
    levelUp() {
      if (!ready()) return;
      [0, 4, 7, 12, 16, 19].forEach((s, i) => tone({ type: 'triangle', f: 392 * semi(s), dur: 0.3, vol: 0.12, when: i * 0.055 }));
      noise({ dur: 0.6, vol: 0.05, type: 'highpass', f: 6000, when: 0.1 });
    },
    hurt()   {
      if (!ready() || !gate('hurt', 120)) return;
      tone({ type: 'sawtooth', f: 260, f2: 55, dur: 0.28, vol: 0.16, cutoff: 1500 });
      noise({ dur: 0.18, vol: 0.12, f: 800 });
    },
    boom()   {
      if (!ready() || !gate('boom', 70)) return;
      noise({ dur: 0.5, vol: 0.22, f: 2000, f2: 80 });
      tone({ type: 'sine', f: 140, f2: 35, dur: 0.4, vol: 0.22 });
    },
    zap()    {
      if (!ready() || !gate('zap', 80)) return;
      noise({ dur: 0.2, vol: 0.1, type: 'bandpass', f: 4000, f2: 900, q: 4 });
      tone({ type: 'sawtooth', f: 1600, f2: 180, dur: 0.12, vol: 0.04 });
    },
    nova()   {
      if (!ready() || !gate('nova', 100)) return;
      tone({ type: 'sine', f: 620, f2: 90, dur: 0.4, vol: 0.13 });
      noise({ dur: 0.35, vol: 0.06, type: 'bandpass', f: 900, f2: 200 });
    },
    whoosh() { if (!ready() || !gate('whoosh', 90)) return; noise({ dur: 0.22, vol: 0.06, type: 'bandpass', f: 600, f2: 2400, q: 2 }); },
    pickup() {
      if (!ready()) return;
      tone({ type: 'sine', f: 660, dur: 0.1, vol: 0.12 });
      tone({ type: 'sine', f: 990, dur: 0.18, vol: 0.12, when: 0.08 });
    },
    chest()  {
      if (!ready()) return;
      [0, 7, 12, 16, 19, 24].forEach((s, i) => tone({ type: 'square', f: 523 * semi(s), dur: 0.25, vol: 0.05, when: i * 0.07, cutoff: 4000 }));
      noise({ dur: 1, vol: 0.05, type: 'highpass', f: 7000, when: 0.2 });
    },
    alarm()  {
      if (!ready()) return;
      for (let i = 0; i < 3; i++) tone({ type: 'sawtooth', f: 440, f2: 220, dur: 0.35, vol: 0.11, when: i * 0.45, cutoff: 2000 });
    },
    bossDie() {
      if (!ready()) return;
      noise({ dur: 1.8, vol: 0.35, f: 3000, f2: 40 });
      tone({ type: 'sine', f: 90, f2: 25, dur: 1.5, vol: 0.35 });
    },
    dash()   { if (!ready() || !gate('dash', 150)) return; noise({ dur: 0.3, vol: 0.12, type: 'bandpass', f: 300, f2: 1800, q: 1.5 }); },
    eshoot() { if (!ready() || !gate('eshoot', 90)) return; tone({ type: 'square', f: 300, f2: 180, dur: 0.08, vol: 0.025, cutoff: 1200 }); },
    click()  { if (!ready()) return; tone({ type: 'triangle', f: 880, dur: 0.05, vol: 0.06 }); },
    lose()   {
      if (!ready()) return;
      [0, -3, -7, -12].forEach((s, i) => tone({ type: 'triangle', f: 330 * semi(s), dur: 0.55, vol: 0.12, when: i * 0.2 }));
    },
    win()    {
      if (!ready()) return;
      [0, 4, 7, 12, 7, 12, 16, 19, 24].forEach((s, i) => tone({ type: 'square', f: 392 * semi(s), dur: 0.3, vol: 0.06, when: i * 0.12, cutoff: 3500 }));
    },
  };

  // ---------------------------------------------------------------- Música
  // Canción de power metal épico (estilo Angra / Helloween) compuesta para el
  // juego y tocada por una "banda" de sintetizadores: dos guitarras rítmicas
  // distorsionadas, bajo, batería con doble bombo, dos guitarras solistas
  // armonizadas, cuerdas y coro.
  // Partes: intro sinfónica (solo al empezar) → estrofa ↔ estribillo. Si hay un
  // jefe, al acabar el compás salta a la parte del jefe (solo neoclásico).
  // La "intensidad" añade capas: 0 = riff + batería sencilla, 1 = + melodía,
  // 2 = + doble bombo, segunda guitarra y coro, 3 = jefe.
  const BPM = 160, STEP = 60 / BPM / 4; // STEP = una semicorchea
  const E2 = 82.41, E4 = 329.63;

  // Acordes: r = semitonos desde Mi, t = notas del acorde. hm = usa la escala
  // menor armónica (el Si mayor con Re# que da ese sabor "clásico")
  const CH = {
    Em: { r: 0, t: [0, 3, 7] },
    F:  { r: 1, t: [0, 4, 7] },
    G:  { r: 3, t: [0, 4, 7] },
    Am: { r: 5, t: [0, 3, 7] },
    B:  { r: 7, t: [0, 4, 7], hm: true },
    C:  { r: 8, t: [0, 4, 7] },
    D:  { r: 10, t: [0, 4, 7] },
  };

  // Partitura. riff: 16 semicorcheas por compás → O = acorde abierto,
  // M = acorde apagado fuerte, m = apagado suave, . = deja sonar / silencio.
  // mel: un compás por fila, [nota, duración en semicorcheas]; la nota son
  // semitonos desde Mi4 (12 = Mi5) y null es silencio. 'arp' = arpegio rápido.
  const SONG = {
    intro: {
      next: 'verse', riff: null,
      chords: ['Em', 'C', 'Am', 'B'],
      mel: [
        [[7, 8], [12, 8]],
        [[15, 12], [12, 4]],
        [[17, 8], [15, 4], [12, 4]],
        [[11, 12], [null, 4]],
      ],
    },
    verse: {
      next: 'chorus', riff: 'O.mmM.mmM.mmM.mm',
      chords: ['Em', 'Em', 'C', 'D', 'Em', 'Em', 'Am', 'B'],
      mel: [
        [[12, 4], [7, 2], [12, 2], [14, 4], [15, 4]],
        [[14, 4], [12, 4], [10, 4], [7, 4]],
        [[8, 6], [12, 2], [15, 4], [12, 4]],
        [[14, 8], [12, 4], [10, 4]],
        [[12, 4], [7, 2], [12, 2], [14, 4], [15, 4]],
        [[17, 4], [15, 4], [14, 4], [15, 4]],
        [[17, 6], [15, 2], [12, 4], [8, 4]],
        [[11, 6], [12, 2], [14, 4], [11, 4]],
      ],
    },
    chorus: {
      next: 'verse', riff: 'O.m.m.m.O.m.m.mm',
      chords: ['C', 'D', 'G', 'Em', 'C', 'D', 'B', 'B'],
      mel: [
        [[15, 8], [12, 4], [15, 4]],
        [[17, 8], [14, 4], [17, 4]],
        [[19, 12], [17, 2], [15, 2]],
        [[15, 8], [14, 4], [12, 4]],
        [[12, 4], [15, 4], [20, 8]],
        [[19, 4], [17, 4], [14, 4], [10, 4]],
        [[11, 8], [14, 8]],
        [[19, 12], [null, 4]],
      ],
    },
    boss: {
      next: 'boss', riff: 'MmmmMmmmMmmmMmMm',
      chords: ['Em', 'F', 'Em', 'B', 'Am', 'F', 'B', 'B'],
      mel: [
        'arp', 'arp', 'arp',
        [[19, 6], [17, 2], [15, 4], [14, 4]],
        'arp', 'arp', 'arp',
        [[7, 1], [8, 1], [11, 1], [12, 1], [14, 1], [15, 1], [17, 1], [19, 9]],
      ],
    },
  };
  // Convierte la melodía de cada parte en una lista de notas por semicorchea
  const ARP = [0, 1, 2, 3, 4, 5, 6, 5, 4, 3, 2, 1, 2, 3, 4, 5];
  for (const k in SONG) {
    const sec = SONG[k];
    sec.notes = [];
    sec.mel.forEach((bar, b) => {
      let s = b * 16;
      if (bar === 'arp') {
        const ch = CH[sec.chords[b]], r = ch.r <= 1 ? ch.r : ch.r - 12, tones = [];
        for (let o = 0; o < 3; o++) for (const x of ch.t) tones.push(r + x + o * 12);
        ARP.forEach((i, j) => { sec.notes[s + j] = { n: tones[i], d: 1, arp: true }; });
        return;
      }
      for (const [n, d] of bar) {
        if (n !== null) sec.notes[s] = { n, d };
        s += d;
      }
    });
  }

  // Nota una tercera por encima dentro de la escala (para la segunda guitarra)
  const NAT = [0, 2, 3, 5, 7, 8, 10], HARM = [0, 2, 3, 5, 7, 8, 11];
  function third(n, hm) {
    const sc = hm ? HARM : NAT, pc = ((n % 12) + 12) % 12, i = sc.indexOf(pc);
    if (i < 0) return n + 3;
    return n + ((sc[(i + 2) % 7] - pc + 12) % 12);
  }

  const music = { on: false, s: 0, next: 0, timer: 0, intensity: 0, sec: null, bar: 0 };

  // --- Batería
  function hit(t, v, type, f, dur, q = 0.7, verb = 0) {
    const src = ac.createBufferSource(), fl = ac.createBiquadFilter(), g = ac.createGain();
    src.buffer = noiseBuf;
    fl.type = type; fl.frequency.value = f; fl.Q.value = q;
    g.gain.setValueAtTime(v, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(fl); fl.connect(g); g.connect(musicBus);
    if (verb) { const s = ac.createGain(); s.gain.value = verb; g.connect(s); s.connect(verbIn); }
    src.start(t, Math.random() * 0.5); src.stop(t + dur + 0.02);
  }
  function drum(t, f1, f2, v, dur, verb = 0) {
    const o = ac.createOscillator(), g = ac.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(f1, t);
    o.frequency.exponentialRampToValueAtTime(f2, t + dur * 0.5);
    env(g, t, v, 0.002, dur);
    o.connect(g); g.connect(musicBus);
    if (verb) g.connect(verbIn);
    o.start(t); o.stop(t + dur + 0.02);
  }
  function kick(t, v) {
    drum(t, 170, 46, v, v < 0.6 ? 0.1 : 0.15); // los golpes rápidos del doble bombo, más secos
    if (v >= 0.6) hit(t, v * 0.22, 'highpass', 3000, 0.012); // "clic" del pedal en los golpes fuertes
  }
  function snare(t, v = 1) {
    hit(t, 0.7 * v, 'bandpass', 2200, 0.17, 0.6, 0.7);
    drum(t, 240, 170, 0.45 * v, 0.09);
  }
  const hat = (t, v) => hit(t, v, 'highpass', 8000, 0.04);
  const ride = t => hit(t, 0.07, 'bandpass', 6000, 0.3, 1.5);
  const crash = t => hit(t, 0.17, 'highpass', 4500, 1.5, 0.7, 0.8);
  const tom = (t, f) => drum(t, f, f * 0.6, 0.45, 0.28, true);
  function timpani(t, root, v) {
    drum(t, E2 * semi(root) * 1.04, E2 * semi(root), v, 1.3, true);
    hit(t, v * 0.25, 'lowpass', 500, 0.15);
  }

  // --- Guitarra rítmica y bajo (acordes de quinta, como en el metal)
  function riff(root, t, dur, open, accent) {
    const f = E2 * semi(root), fl = ac.createBiquadFilter(), g = ac.createGain();
    fl.type = 'lowpass';
    const v = open ? 0.6 : accent ? 0.7 : 0.5;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(v, t + 0.004);
    if (open) {
      fl.frequency.value = 3200;
      g.gain.exponentialRampToValueAtTime(v * 0.5, t + dur - 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.02);
    } else { // apagado con la palma: corto y oscuro, el "chug" del metal
      fl.frequency.setValueAtTime(accent ? 1300 : 900, t);
      fl.frequency.exponentialRampToValueAtTime(240, t + 0.09);
      g.gain.exponentialRampToValueAtTime(0.0001, t + Math.min(dur, 0.12));
    }
    fl.connect(g); g.connect(guitar.input);
    for (const [m, det] of open && !LITE ? [[1, -6], [1.5, 5], [2, 3]] : [[1, -4], [1.5, 4]]) {
      const o = ac.createOscillator();
      o.type = 'sawtooth'; o.frequency.value = f * m; o.detune.value = det;
      o.connect(fl); o.start(t); o.stop(t + dur + 0.04);
    }
  }
  function bass(root, t, dur) {
    const o = ac.createOscillator(), fl = ac.createBiquadFilter(), g = ac.createGain();
    o.type = 'sawtooth'; o.frequency.value = (E2 / 2) * semi(root);
    fl.type = 'lowpass'; fl.Q.value = 2;
    fl.frequency.setValueAtTime(900, t);
    fl.frequency.exponentialRampToValueAtTime(250, t + 0.12);
    env(g, t, 0.5, 0.004, Math.max(0.1, dur));
    o.connect(fl); fl.connect(g); g.connect(musicBus);
    o.start(t); o.stop(t + dur + 0.05);
  }

  // --- Guitarra solista: sube un pelín de tono al atacar y hace vibrato en las notas largas
  function lead(n, t, dur, gtr, v) {
    const f = E4 * semi(n), g = ac.createGain();
    const oscs = [];
    for (const type of LITE ? ['sawtooth'] : ['sawtooth', 'square']) {
      const o = ac.createOscillator();
      o.type = type; o.detune.value = oscs.length * 6;
      oscs.push(o);
    }
    for (const o of oscs) {
      if (dur > 0.3) {
        o.frequency.setValueAtTime(f * semi(-1), t);
        o.frequency.exponentialRampToValueAtTime(f, t + 0.06);
      } else o.frequency.value = f;
    }
    if (dur > 0.3) {
      const lfo = ac.createOscillator(), lg = ac.createGain();
      lfo.frequency.value = 5.8;
      lg.gain.setValueAtTime(0, t);
      lg.gain.linearRampToValueAtTime(f * 0.02, t + 0.35);
      lfo.connect(lg);
      for (const o of oscs) lg.connect(o.frequency);
      lfo.start(t); lfo.stop(t + dur + 0.1);
    }
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(v, t + 0.006);
    g.gain.setValueAtTime(v, t + Math.max(0.01, dur - 0.03));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.04);
    g.connect(gtr.input);
    for (const o of oscs) { o.connect(g); o.start(t); o.stop(t + dur + 0.08); }
  }
  // Violines de la intro (sin distorsión, entrada suave)
  function violin(n, t, dur) {
    const f = E4 * semi(n), fl = ac.createBiquadFilter(), g = ac.createGain();
    fl.type = 'lowpass'; fl.frequency.value = 2600;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.13, t + 0.18);
    g.gain.setValueAtTime(0.13, t + dur - 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.2);
    fl.connect(g); g.connect(musicBus); g.connect(verbIn);
    const lfo = ac.createOscillator(), lg = ac.createGain();
    lfo.frequency.value = 5.5; lg.gain.value = f * 0.012;
    lfo.connect(lg);
    for (const det of [-8, 8]) {
      const o = ac.createOscillator();
      o.type = 'sawtooth'; o.frequency.value = f; o.detune.value = det;
      lg.connect(o.frequency);
      o.connect(fl); o.start(t); o.stop(t + dur + 0.25);
    }
    lfo.start(t); lfo.stop(t + dur + 0.25);
  }

  // --- Cuerdas y coro (acordes largos de fondo)
  function swell(g, t, dur, v, atk) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(v, t + atk);
    g.gain.setValueAtTime(v, t + dur - 0.15);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.3);
  }
  const low = ch => (ch.r > 4 ? ch.r - 12 : ch.r); // acorde cerca de Mi3
  function strings(ch, t, dur, v) {
    const fl = ac.createBiquadFilter(), g = ac.createGain();
    fl.type = 'lowpass'; fl.frequency.value = 2200;
    swell(g, t, dur, LITE ? v * 1.5 : v, 0.4);
    fl.connect(g); g.connect(musicBus); g.connect(verbIn);
    for (const x of ch.t) {
      for (const det of LITE ? [0] : [-9, 9]) {
        const o = ac.createOscillator();
        o.type = 'sawtooth'; o.frequency.value = (E4 / 2) * semi(low(ch) + x); o.detune.value = det;
        o.connect(fl); o.start(t); o.stop(t + dur + 0.35);
      }
    }
  }
  function choir(ch, t, dur, v) {
    const g = ac.createGain(), lfo = ac.createOscillator(), lg = ac.createGain();
    swell(g, t, dur, LITE ? v * 1.5 : v, 0.5);
    g.connect(choirIn);
    lfo.frequency.value = 5; lg.gain.value = 10; // vibrato de las voces
    lfo.connect(lg);
    for (const x of [...ch.t, ch.t[0] + 12]) {
      for (const det of LITE ? [0] : [-12, 12]) {
        const o = ac.createOscillator();
        o.type = 'sawtooth'; o.frequency.value = (E4 / 2) * semi(low(ch) + x); o.detune.value = det;
        lg.connect(o.detune);
        o.connect(g); o.start(t); o.stop(t + dur + 0.35);
      }
    }
    lfo.start(t); lfo.stop(t + dur + 0.35);
  }

  // --- Secuenciador
  function enter(sec) { music.sec = sec; music.bar = 0; }
  function nextBar() {
    if (!music.sec) { enter('intro'); return; }
    const I = music.intensity;
    music.bar++;
    if (I >= 3 && music.sec !== 'boss' && music.sec !== 'intro') enter('boss');
    else if (I < 3 && music.sec === 'boss') enter('chorus');
    else if (music.bar >= SONG[music.sec].chords.length) enter(SONG[music.sec].next);
  }

  function playStep(t) {
    if (music.s === 0) nextBar();
    const I = music.intensity, s = music.s, b = music.bar;
    const name = music.sec, sec = SONG[name], ch = CH[sec.chords[b]];
    const last = b === sec.chords.length - 1;
    if (s % 4 === 0 && beatCb) setTimeout(beatCb, Math.max(0, (t - ac.currentTime) * 1000));

    if (name === 'intro') {
      if (s === 0) {
        strings(ch, t, STEP * 16, 0.06);
        choir(ch, t, STEP * 16, 0.13);
        timpani(t, ch.r, 0.55);
      }
      if (last && s >= 8) snare(t, 0.25 + (s - 8) * 0.1); // redoble que da paso a la banda
    } else {
      const boss = name === 'boss';
      const c = sec.riff[s];
      // Batería
      if (I >= 2 || boss) kick(t, s % 4 === 0 ? 0.65 : 0.4); // doble bombo
      else if (I === 1) { if (c !== '.') kick(t, 0.62); }     // el bombo sigue al riff
      else if (s === 0 || s === 8 || s === 10) kick(t, 0.8);
      if (last && s >= 12) { // redoble al final de cada parte
        if (s < 14) snare(t, 0.7); else tom(t, s === 14 ? 190 : 120);
      } else {
        if (s === 4 || s === 12) snare(t);
        if (boss && b % 2 === 1 && s === 14) snare(t, 0.6);
        if (I >= 2 || boss) { if (s % 4 === 2) ride(t); }
        else if (s % 2 === 0) hat(t, s % 4 === 0 ? 0.09 : 0.06);
      }
      if (s === 0 && (b === 0 || boss || (I >= 1 && b === 4) || (I >= 2 && b % 2 === 0))) crash(t);

      // Guitarras y bajo
      if (c !== '.') {
        let len = 1;
        while (s + len < 16 && sec.riff[s + len] === '.') len++;
        riff(ch.r, t, len * STEP, c === 'O', c !== 'm');
        bass(ch.r, t, len * STEP);
      }

      // Cuerdas y coro
      if (s === 0) {
        if (name === 'chorus' || I >= 2) strings(ch, t, STEP * 16, boss ? 0.045 : 0.035);
        if (boss || (name === 'chorus' && I >= 2)) choir(ch, t, STEP * 16, boss ? 0.1 : 0.14);
      }
    }

    // Melodía
    const note = sec.notes[b * 16 + s];
    if (note) {
      const dur = note.d * STEP;
      if (name === 'intro') violin(note.n, t, dur);
      else if (I >= 1) {
        lead(note.n, t, dur, leadA, 0.5);
        if (I >= 2 && !note.arp) lead(third(note.n, ch.hm), t, dur, leadB, 0.45); // armonía a dos guitarras
      }
    }
  }

  function schedule() {
    if (!music.on || !ready()) return;
    if (music.next < ac.currentTime - 0.2) music.next = ac.currentTime + 0.05;
    while (music.next < ac.currentTime + 0.12) {
      playStep(music.next);
      music.next += STEP;
      music.s = (music.s + 1) % 16;
    }
  }

  function startMusic() {
    if (!ac) return;
    clearTimeout(fadeTimer);
    musicBus.gain.cancelScheduledValues(ac.currentTime);
    musicBus.gain.setValueAtTime(musicOn ? MUSIC_VOL : 0, ac.currentTime);
    // Cada partida nueva empieza la canción desde la intro
    music.sec = null;
    music.s = 0;
    if (music.on) return;
    music.on = true;
    music.next = ac.currentTime + 0.08;
    music.timer = setInterval(schedule, 25);
  }
  function stopMusic() {
    music.on = false;
    clearInterval(music.timer);
  }
  function fadeOut() {
    if (!ac || !music.on) return;
    musicBus.gain.setTargetAtTime(0, ac.currentTime, 0.4);
    clearTimeout(fadeTimer);
    fadeTimer = setTimeout(stopMusic, 1800);
  }
  function muffle(on) {
    if (!ac) return;
    musicFilter.frequency.setTargetAtTime(on ? 450 : 16000, ac.currentTime, 0.08);
  }
  function toggleMusic() {
    musicOn = !musicOn;
    store.set('music', musicOn);
    if (ac && music.on) musicBus.gain.setTargetAtTime(musicOn ? MUSIC_VOL : 0, ac.currentTime, 0.1);
    return musicOn;
  }

  return {
    init, sfx, startMusic, fadeOut, muffle, toggleMusic,
    isMusicOn: () => musicOn,
    setIntensity: i => { music.intensity = i; },
    onBeat: cb => { beatCb = cb; },
  };
})();

// =============================================================================
// 3. LIENZO, SPRITES Y FONDO
// =============================================================================
const canvas = $('game');
const ctx = canvas.getContext('2d');
let W = 0, H = 0, DPR = 1;
let VIEW = 1;           // píxeles de pantalla por unidad del mundo
let OX = 0, OY = 0;     // desplazamiento de la cámara en pantalla
let viewL = 0, viewR = 0, viewT = 0, viewB = 0;
let vignette = null, vignetteRed = null;
let beat = 0;           // pulso al ritmo de la música (0..1)

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  return c;
}

// Calidad gráfica. En móviles se empieza con resolución alta (para que las
// imágenes se vean nítidas) pero menos partículas; si el juego va lento, baja
// sola (menos resolución y menos partículas) para que siempre vaya fluido.
const QUALITY = [
  { dpr: 2, particles: 2000 },
  { dpr: 2, particles: 1100 },
  { dpr: 1.5, particles: 900 },
  { dpr: 1, particles: 600 },
];
let quality = IS_TOUCH ? 1 : 0;
let maxParticles = QUALITY[quality].particles;

// Aumento de las imágenes personalizadas según la pantalla: en pantallas
// pequeñas (móviles) se dibujan más grandes para que se reconozcan. Solo cambia
// el dibujo, no la zona de choque.
let skinK = 1;

function resize() {
  const cssW = window.innerWidth, cssH = window.innerHeight;
  DPR = Math.min(window.devicePixelRatio || 1, QUALITY[quality].dpr);
  W = Math.floor(cssW * DPR);
  H = Math.floor(cssH * DPR);
  canvas.width = W;
  canvas.height = H;
  // Se ve más o menos la misma cantidad de mundo en cualquier pantalla, pero en
  // pantallas pequeñas (móviles) la cámara se acerca para que todo se vea grande.
  let scale = Math.sqrt((cssW * cssH) / (1280 * 720));
  const short = Math.min(cssW, cssH);
  if (short < 640) scale = Math.max(scale, short / 500);
  VIEW = scale * DPR;
  // Que un enemigo normal con imagen mida al menos unos 87 píxeles en pantalla
  const k = Math.round(clamp(1.25 / scale, 1, 1.8) * 20) / 20;
  if (k !== skinK) { skinK = k; refreshSkinSprites(); }
  buildVignettes();
}

// Vigila los FPS durante la partida y baja la calidad si hace falta
const perf = { t: 0, n: 0 };
function watchPerf(raw) {
  if (state !== 'playing' || quality >= QUALITY.length - 1 || raw > 0.25) return;
  perf.t += raw;
  perf.n++;
  if (perf.t >= 3) {
    if (perf.n / perf.t < 45) {
      quality++;
      maxParticles = QUALITY[quality].particles;
      resize();
    }
    perf.t = 0;
    perf.n = 0;
  }
}

function buildVignettes() {
  const w = Math.max(64, W >> 2), h = Math.max(64, H >> 2);
  vignette = makeCanvas(w, h);
  vignetteRed = makeCanvas(w, h);
  for (const [c, col, a] of [[vignette, '0,0,0', 0.72], [vignetteRed, '255,20,60', 0.65]]) {
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.hypot(w, h) * 0.55);
    grd.addColorStop(0, `rgba(${col},0)`);
    grd.addColorStop(1, `rgba(${col},${a})`);
    g.fillStyle = grd;
    g.fillRect(0, 0, w, h);
  }
}

// --- Brillos pre-renderizados (mucho más rápidos que shadowBlur) -------------
const glowCache = new Map(), haloCache = new Map(), streakCache = new Map();

// Punto brillante con núcleo blanco
function glow(color) {
  let c = glowCache.get(color);
  if (c) return c;
  const s = 64;
  c = makeCanvas(s, s);
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.12, rgba(color, 1));
  grd.addColorStop(0.35, rgba(color, 0.4));
  grd.addColorStop(1, rgba(color, 0));
  g.fillStyle = grd;
  g.fillRect(0, 0, s, s);
  glowCache.set(color, c);
  return c;
}

// Resplandor suave, sin núcleo
function halo(color) {
  let c = haloCache.get(color);
  if (c) return c;
  const s = 128;
  c = makeCanvas(s, s);
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grd.addColorStop(0, rgba(color, 0.5));
  grd.addColorStop(0.4, rgba(color, 0.16));
  grd.addColorStop(1, rgba(color, 0));
  g.fillStyle = grd;
  g.fillRect(0, 0, s, s);
  haloCache.set(color, c);
  return c;
}

// Estela alargada (balas, chispas, meteoritos)
function streak(color) {
  let c = streakCache.get(color);
  if (c) return c;
  c = makeCanvas(64, 16);
  const g = c.getContext('2d');
  g.translate(32, 8);
  g.scale(4, 1);
  const grd = g.createRadialGradient(0, 0, 0, 0, 0, 8);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.3, rgba(color, 0.9));
  grd.addColorStop(1, rgba(color, 0));
  g.fillStyle = grd;
  g.fillRect(-8, -8, 16, 16);
  streakCache.set(color, c);
  return c;
}

// --- Sprites de formas con brillo neón ----------------------------------------
const SPR = 3; // resolución de los sprites: píxeles por unidad del mundo
const spriteCache = new Map();

function sprite(key, half, draw) {
  let s = spriteCache.get(key);
  if (s) return s;
  const c = makeCanvas(half * 2 * SPR, half * 2 * SPR);
  const g = c.getContext('2d');
  g.translate(half * SPR, half * SPR);
  g.scale(SPR, SPR);
  g.lineJoin = 'round';
  g.lineCap = 'round';
  draw(g);
  s = { c, half };
  spriteCache.set(key, s);
  return s;
}

function shapePath(g, shape, r) {
  g.beginPath();
  switch (shape) {
    case 'tri': // punta de flecha
      g.moveTo(r, 0); g.lineTo(-r * 0.75, r * 0.8); g.lineTo(-r * 0.35, 0); g.lineTo(-r * 0.75, -r * 0.8);
      break;
    case 'diamond':
      g.moveTo(r, 0); g.lineTo(0, r * 0.6); g.lineTo(-r, 0); g.lineTo(0, -r * 0.6);
      break;
    case 'square':
      g.rect(-r * 0.8, -r * 0.8, r * 1.6, r * 1.6);
      break;
    case 'circle':
      g.arc(0, 0, r, 0, TAU);
      break;
    case 'hex':
      for (let i = 0; i < 6; i++) { const a = (i / 6) * TAU; g.lineTo(Math.cos(a) * r, Math.sin(a) * r); }
      break;
  }
  g.closePath();
}

// Sprite a partir de una imagen personalizada (ver SKINS en la sección 4)
function skinSprite(name, color, r, flash, elite) {
  const img = skinImg[name], cfg = SKINS[name];
  const circle = cfg.modo === 'circulo';
  // Tamaño visible (diámetro / lado). Solo cambia el dibujo: la zona de choque
  // sigue siendo "r", así que la dificultad no varía. El sumando fijo hace que
  // los enemigos pequeños crezcan más y todas las imágenes se reconozcan bien.
  // En pantallas pequeñas se aumenta (skinK); jefes y jugador algo menos para no tapar media pantalla
  const k = /^(jefe|jugador)/.test(name) ? Math.sqrt(skinK) : skinK;
  const size = (circle ? r * 2.4 + 24 : r * 2.8 + 36) * (cfg.tam || 1) * k;
  return sprite(`skin-${name}-${r}-${flash ? 1 : 0}-${elite ? 1 : 0}-${color}-${k}`, size / 2 + 16, g => {
    g.imageSmoothingQuality = 'high';
    if (circle) {
      const R = size / 2;
      g.shadowColor = color;
      g.shadowBlur = 14 * SPR;
      g.fillStyle = '#05030d';
      g.beginPath(); g.arc(0, 0, R, 0, TAU); g.fill();
      g.shadowBlur = 0;
      // La foto rellena el círculo; se centra un poco hacia arriba porque ahí suelen estar las caras
      g.save();
      g.beginPath(); g.arc(0, 0, R - 1, 0, TAU); g.clip();
      const s = Math.max((2 * R) / img.width, (2 * R) / img.height);
      const w = img.width * s, h = img.height * s;
      g.drawImage(img, -w / 2, -R - (h - 2 * R) * 0.3, w, h);
      if (flash) { g.fillStyle = 'rgba(255,255,255,0.8)'; g.fillRect(-R, -R, 2 * R, 2 * R); }
      g.restore();
      g.shadowColor = color;
      g.shadowBlur = 8 * SPR;
      g.strokeStyle = flash ? '#ffffff' : color;
      g.lineWidth = 3;
      g.beginPath(); g.arc(0, 0, R, 0, TAU); g.stroke();
      g.shadowBlur = 0;
      g.strokeStyle = 'rgba(255,255,255,0.55)';
      g.lineWidth = 1;
      g.beginPath(); g.arc(0, 0, R - 3, 0, TAU); g.stroke();
    } else {
      const s = Math.min(size / img.width, size / img.height);
      const w = img.width * s, h = img.height * s;
      let src = img;
      if (flash) { // silueta blanca para el destello al recibir un golpe
        const c = makeCanvas(img.width, img.height), cg = c.getContext('2d');
        cg.drawImage(img, 0, 0);
        cg.globalCompositeOperation = 'source-in';
        cg.fillStyle = '#ffffff';
        cg.fillRect(0, 0, c.width, c.height);
        src = c;
      }
      // La sombra de color sigue la silueta: queda un contorno de neón
      g.shadowColor = color;
      g.shadowBlur = 9 * SPR;
      g.drawImage(src, -w / 2, -h / 2, w, h);
      g.shadowBlur = 3 * SPR;
      g.drawImage(src, -w / 2, -h / 2, w, h);
      g.shadowBlur = 0;
    }
    if (elite) {
      g.shadowColor = '#ffd84d';
      g.shadowBlur = 10 * SPR;
      g.strokeStyle = '#ffd84d';
      g.lineWidth = 2;
      g.setLineDash([6, 5]);
      g.beginPath(); g.arc(0, 0, size / 2 + 7, 0, TAU); g.stroke();
      g.setLineDash([]);
    }
  });
}

function enemySprite(type, flash, elite) {
  const T = ENEMY_TYPES[type];
  const r = T.r * (elite ? 1.35 : 1);
  if (skinImg[type]) return skinSprite(type, T.color, r, flash, elite);
  return sprite(`en-${type}-${flash ? 1 : 0}-${elite ? 1 : 0}`, r + 16, g => {
    const col = flash ? '#ffffff' : T.color;
    g.shadowColor = col;
    g.shadowBlur = 14 * SPR;
    shapePath(g, T.shape, r);
    g.fillStyle = flash ? 'rgba(255,255,255,0.9)' : rgba(T.color, 0.16);
    g.fill();
    g.strokeStyle = col;
    g.lineWidth = 2.6;
    g.stroke();
    g.shadowBlur = 5 * SPR;
    g.stroke();
    g.shadowBlur = 0;
    shapePath(g, T.shape, r * 0.45);
    g.strokeStyle = flash ? '#ffffff' : 'rgba(255,255,255,0.75)';
    g.lineWidth = 1.6;
    g.stroke();
    if (elite) {
      g.shadowColor = '#ffd84d';
      g.shadowBlur = 10 * SPR;
      g.strokeStyle = '#ffd84d';
      g.lineWidth = 2;
      g.setLineDash([6, 5]);
      g.beginPath();
      g.arc(0, 0, r + 7, 0, TAU);
      g.stroke();
      g.setLineDash([]);
    }
  });
}

function gemSprite(tier) {
  const T = GEM_TIERS[tier];
  return sprite('gem' + tier, T.r + 10, g => {
    g.shadowColor = T.color;
    g.shadowBlur = 10 * SPR;
    g.beginPath();
    g.moveTo(0, -T.r * 1.3); g.lineTo(T.r, 0); g.lineTo(0, T.r * 1.3); g.lineTo(-T.r, 0);
    g.closePath();
    g.fillStyle = T.color;
    g.fill();
    g.shadowBlur = 0;
    g.beginPath();
    g.moveTo(0, -T.r * 1.3); g.lineTo(T.r * 0.4, 0); g.lineTo(0, 0); g.lineTo(-T.r, 0);
    g.closePath();
    g.fillStyle = 'rgba(255,255,255,0.55)';
    g.fill();
  });
}

function discSprite(color) {
  return sprite('disc' + color, 24, g => {
    g.shadowColor = color;
    g.shadowBlur = 12 * SPR;
    g.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU, r = i % 2 ? 4.5 : 13;
      g.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    g.closePath();
    g.fillStyle = rgba(color, 0.35);
    g.fill();
    g.strokeStyle = color;
    g.lineWidth = 2;
    g.stroke();
    g.shadowBlur = 0;
    g.beginPath();
    g.arc(0, 0, 3, 0, TAU);
    g.fillStyle = '#ffffff';
    g.fill();
  });
}

function droneSprite() {
  return sprite('drone', 18, g => {
    g.shadowColor = '#a6ff4d';
    g.shadowBlur = 10 * SPR;
    g.beginPath();
    g.moveTo(11, 0); g.lineTo(-7, 8); g.lineTo(-3, 0); g.lineTo(-7, -8);
    g.closePath();
    g.fillStyle = 'rgba(166,255,77,0.25)';
    g.fill();
    g.strokeStyle = '#a6ff4d';
    g.lineWidth = 2;
    g.stroke();
    g.shadowBlur = 0;
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.arc(1, 0, 2, 0, TAU);
    g.fill();
  });
}

function heartPath(g, r) {
  g.beginPath();
  g.moveTo(0, r * 0.9);
  g.bezierCurveTo(-r * 1.3, 0, -r * 0.7, -r * 1.1, 0, -r * 0.35);
  g.bezierCurveTo(r * 0.7, -r * 1.1, r * 1.3, 0, 0, r * 0.9);
  g.closePath();
}

function pickupSprite(kind) {
  return sprite('pk-' + kind, 26, g => {
    if (kind === 'heart') {
      g.shadowColor = '#ff5ea8'; g.shadowBlur = 12 * SPR;
      heartPath(g, 11);
      g.fillStyle = '#ff5ea8'; g.fill();
      g.shadowBlur = 0;
      g.fillStyle = 'rgba(255,255,255,0.6)';
      g.beginPath(); g.arc(-4, -3, 2.5, 0, TAU); g.fill();
    } else if (kind === 'magnet') {
      g.shadowColor = '#4db8ff'; g.shadowBlur = 10 * SPR;
      g.lineCap = 'butt'; g.lineWidth = 6; g.strokeStyle = '#4db8ff';
      g.beginPath(); g.moveTo(-8, -9); g.lineTo(-8, 0); g.arc(0, 0, 8, Math.PI, 0, true); g.lineTo(8, -9); g.stroke();
      g.strokeStyle = '#ff4d6d';
      g.beginPath(); g.moveTo(-8, -10); g.lineTo(-8, -5); g.moveTo(8, -10); g.lineTo(8, -5); g.stroke();
    } else if (kind === 'bomb') {
      g.shadowColor = '#ff4d4d'; g.shadowBlur = 12 * SPR;
      g.beginPath(); g.arc(0, 2, 9, 0, TAU);
      g.fillStyle = '#2a0a14'; g.fill();
      g.strokeStyle = '#ff4d4d'; g.lineWidth = 2.5; g.stroke();
      g.strokeStyle = '#ffd84d'; g.lineWidth = 2;
      g.beginPath(); g.moveTo(5, -5); g.quadraticCurveTo(8, -10, 11, -11); g.stroke();
    } else if (kind === 'chest') {
      g.shadowColor = '#ffd84d'; g.shadowBlur = 14 * SPR;
      g.fillStyle = '#3a2a05'; g.strokeStyle = '#ffd84d'; g.lineWidth = 2.5;
      g.beginPath(); g.rect(-13, -6, 26, 16); g.fill(); g.stroke();
      g.beginPath(); g.moveTo(-13, -6); g.lineTo(-13, -10); g.quadraticCurveTo(0, -18, 13, -10); g.lineTo(13, -6); g.closePath();
      g.fill(); g.stroke();
      g.shadowBlur = 0;
      g.fillStyle = '#fff6c2';
      g.fillRect(-3, -3, 6, 7);
    }
  });
}

// --- Fondo: nebulosa + estrellas en paralaje ----------------------------------
let nebula = null, stars1 = null, stars2 = null;

function buildBackdrop() {
  nebula = makeCanvas(1024, 1024);
  const g = nebula.getContext('2d');
  const colors = [['#3a0d7a', 0.55], ['#0d2a7a', 0.5], ['#6a0d5a', 0.45], ['#0d4a6a', 0.35], ['#2a0d5a', 0.5]];
  for (let i = 0; i < 10; i++) {
    const [c, a] = colors[i % colors.length];
    const x = rand(1024), y = rand(1024), r = rand(180, 420);
    // Se dibuja también en los bordes opuestos para que al repetir no se note el corte
    for (const ox of [-1024, 0, 1024]) {
      for (const oy of [-1024, 0, 1024]) {
        const grd = g.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
        grd.addColorStop(0, rgba(c, a));
        grd.addColorStop(1, rgba(c, 0));
        g.fillStyle = grd;
        g.fillRect(x + ox - r, y + oy - r, r * 2, r * 2);
      }
    }
  }
  stars1 = starTile(512, 150, 0.5, 1.2);
  stars2 = starTile(512, 40, 1, 2.2);
}

function starTile(size, n, minR, maxR) {
  const c = makeCanvas(size, size), g = c.getContext('2d');
  for (let i = 0; i < n; i++) {
    const x = rand(size), y = rand(size), r = rand(minR, maxR);
    g.fillStyle = pick(['#ffffff', '#bfe9ff', '#ffd6f5', '#d6c8ff']);
    g.globalAlpha = rand(0.35, 1);
    g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
    if (r > 1.6) {
      g.globalAlpha *= 0.25;
      g.beginPath(); g.arc(x, y, r * 3, 0, TAU); g.fill();
    }
  }
  return c;
}

// =============================================================================
// 4. DATOS DEL JUEGO
// =============================================================================
const MAX_ENEMIES = 420;
const MAX_GEMS = 320;
const MAX_WEAPONS = 6;
const MAX_PASSIVES = 6;
const GRID = 64;        // tamaño de las casillas de la cuadrícula del suelo

const ENEMY_TYPES = {
  zangano:   { shape: 'tri',     r: 12, hp: 9,  speed: 80,  dmg: 8,  xp: 1, color: '#ff2e97', face: true },
  veloz:     { shape: 'diamond', r: 10, hp: 6,  speed: 145, dmg: 6,  xp: 1, color: '#ff9f1c', face: true },
  divisor:   { shape: 'circle',  r: 17, hp: 30, speed: 62,  dmg: 10, xp: 2, color: '#3d8bff', split: 3 },
  mini:      { shape: 'circle',  r: 8,  hp: 5,  speed: 120, dmg: 5,  xp: 1, color: '#7fd0ff' },
  centinela: { shape: 'square',  r: 14, hp: 22, speed: 72,  dmg: 10, xp: 3, color: '#ff4545', spin: 1.6, ranged: true },
  tanque:    { shape: 'hex',     r: 25, hp: 90, speed: 46,  dmg: 16, xp: 6, color: '#b04dff', spin: 0.5, heavy: true },
};

const GEM_TIERS = [
  { max: 4.99, color: '#5dff8a', r: 5 },
  { max: 19.99, color: '#4db8ff', r: 6.5 },
  { max: Infinity, color: '#ffd84d', r: 8.5 },
];
const gemTier = v => (v <= GEM_TIERS[0].max ? 0 : v <= GEM_TIERS[1].max ? 1 : 2);

// -----------------------------------------------------------------------------
// IMÁGENES PERSONALIZADAS (carpeta "imagenes")
// Si existe imagenes/<nombre>.png (o .jpg / .webp), ese enemigo, jefe o el
// jugador se dibuja con tu imagen en lugar del dibujo de neón.
//   modo 'recorte' → para imágenes con fondo transparente: se dibuja la
//                    silueta con un brillo de neón alrededor.
//   modo 'circulo' → para fotos con fondo: se recortan en un círculo con
//                    borde de neón, como una ficha.
//   tam            → tamaño (1 = normal, 1.3 = un 30% más grande, 0.8 = más pequeño).
// Si una imagen no existe, se usa el dibujo de neón de siempre.
// -----------------------------------------------------------------------------
// Los pequeños apenas se reducen; cuanto más grande es la figura, más se encoge.
const SKINS = {
  zangano:   { modo: 'recorte', tam: 0.93 },
  veloz:     { modo: 'recorte', tam: 0.93 },
  divisor:   { modo: 'recorte', tam: 0.86 },
  mini:      { modo: 'recorte', tam: 0.94 },
  centinela: { modo: 'recorte', tam: 0.88 },
  tanque:    { modo: 'circulo', tam: 0.8 },
  jefe1:     { modo: 'circulo', tam: 0.76 },
  jefe2:     { modo: 'circulo', tam: 0.76 },
  jefe3:     { modo: 'circulo', tam: 0.76 },
  jefe4:     { modo: 'circulo', tam: 0.76 },
  jugador:   { modo: 'circulo', tam: 1 },
};
const skinImg = {}; // imágenes que se han cargado bien

function loadSkins() {
  if (typeof Image === 'undefined') return;
  const exts = ['png', 'jpg', 'jpeg', 'webp'];
  for (const name in SKINS) {
    let i = 0;
    const img = new Image();
    img.onload = () => {
      skinImg[name] = img;
      refreshSkinSprites(); // los enemigos que ya existían pasan a usar la imagen
    };
    img.onerror = () => { if (++i < exts.length) img.src = `imagenes/${name}.${exts[i]}`; };
    img.src = `imagenes/${name}.${exts[0]}`;
  }
}

// Vuelve a preparar los dibujos de los enemigos (al cargar una imagen o al
// cambiar el tamaño de la pantalla)
function refreshSkinSprites() {
  for (const e of enemies) {
    if (e.boss || !skinImg[e.type]) continue;
    e.spr = enemySprite(e.type, false, e.elite);
    e.sprF = enemySprite(e.type, true, e.elite);
    e.sep = 1.3;
  }
  if (state === 'menu') initMenuScene();
}

// Iconos SVG (24x24) para la interfaz
const ICONS = {
  pulso: '<circle cx="6" cy="12" r="2.5" fill="currentColor"/><path d="M10 12h9M15 7l5 5-5 5"/>',
  orbes: '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="8.5" stroke-dasharray="2 3.2" opacity=".6"/><circle cx="20.5" cy="12" r="2.2" fill="currentColor"/><circle cx="3.5" cy="12" r="2.2" fill="currentColor"/>',
  rayo: '<path d="M13 2 5 13.5h6L10 22l9-12.5h-6.5z" fill="currentColor" fill-opacity=".25"/>',
  nova: '<circle cx="12" cy="12" r="2.5" fill="currentColor"/><circle cx="12" cy="12" r="6.5"/><circle cx="12" cy="12" r="10.5" opacity=".5"/>',
  disco: '<path d="M12 2.5 14.6 9.4 21.5 12l-6.9 2.6L12 21.5l-2.6-6.9L2.5 12l6.9-2.6z" fill="currentColor" fill-opacity=".25"/><circle cx="12" cy="12" r="2"/>',
  meteoro: '<circle cx="15" cy="15" r="5" fill="currentColor" fill-opacity=".25"/><path d="M11 11 3 3M10.5 15.5 5 10M15.5 10.5 10 5"/>',
  dron: '<rect x="8.5" y="8.5" width="7" height="7" rx="1.5"/><path d="M8.5 8.5 5.5 5.5M15.5 8.5l3-3M8.5 15.5l-3 3M15.5 15.5l3 3"/><circle cx="4.5" cy="4.5" r="2"/><circle cx="19.5" cy="4.5" r="2"/><circle cx="4.5" cy="19.5" r="2"/><circle cx="19.5" cy="19.5" r="2"/>',
  poder: '<path d="M12 22c4.4 0 7-3 7-7 0-4.5-4-6.5-4.5-11-2.7 1.8-4 4.5-4 7-1-.6-1.8-1.7-2-3.2C6.4 9.6 5 12.2 5 15c0 4 2.6 7 7 7z" fill="currentColor" fill-opacity=".25"/>',
  cadencia: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2M9 2h6"/>',
  area: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/><circle cx="12" cy="12" r="3" fill="currentColor" fill-opacity=".3"/>',
  velocidad: '<path d="M4 6l6 6-6 6M12 6l6 6-6 6"/>',
  iman: '<path d="M5 3h4v8a3 3 0 0 0 6 0V3h4v8a7 7 0 0 1-14 0z" fill="currentColor" fill-opacity=".2"/><path d="M5 7h4M15 7h4"/>',
  vitalidad: '<path d="M12 20.5s-8-4.8-8-10.5A4.5 4.5 0 0 1 12 7a4.5 4.5 0 0 1 8 3c0 5.7-8 10.5-8 10.5z" fill="currentColor" fill-opacity=".25"/>',
  regen: '<circle cx="12" cy="12" r="9"/><path d="M12 7v10M7 12h10"/>',
  multi: '<rect x="3" y="8" width="11" height="11" rx="2"/><path d="M9 4h9a2 2 0 0 1 2 2v9"/>',
  blindaje: '<path d="M12 2.5 20 5.5v6c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10v-6z" fill="currentColor" fill-opacity=".2"/>',
  curar: '<path d="M12 20.5s-8-4.8-8-10.5A4.5 4.5 0 0 1 12 7a4.5 4.5 0 0 1 8 3c0 5.7-8 10.5-8 10.5z"/><path d="M12 10v6M9 13h6"/>',
  nucleo: '<path d="M12 2l2.9 6.6 7.1.6-5.4 4.7 1.6 7L12 17.3 5.8 21l1.6-7L2 9.2l7.1-.6z" fill="currentColor" fill-opacity=".25"/>',
  bomba: '<circle cx="11" cy="14" r="7" fill="currentColor" fill-opacity=".25"/><path d="M15 9l3-3M19 3v2M21 5h-2"/>',
};
const svg = id => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[id] || ''}</svg>`;

// -----------------------------------------------------------------------------
// ARMAS. Cada nivel aplica un "mod" (dmg = daño, cd = % menos de recarga,
// amount = cantidad, area = % de área...). Al nivel máximo, si tienes la mejora
// pasiva indicada en "evo.with", el próximo cofre de jefe la hace EVOLUCIONAR.
// -----------------------------------------------------------------------------
const WEAPONS = {
  pulso: {
    name: 'Pulso Neón', color: '#4df3ff', unit: ['proyectil', 'proyectiles'],
    desc: 'Dispara ráfagas de energía al enemigo más cercano.',
    base: { dmg: 12, cd: 0.8, amount: 1, speed: 620, pierce: 0, area: 1 },
    levels: [{ amount: 1 }, { dmg: 5 }, { cd: 15 }, { amount: 1 }, { pierce: 1 }, { dmg: 8 }, { amount: 1, pierce: 1 }],
    evo: { with: 'cadencia', name: 'Tormenta de Pulsos', desc: 'Ráfagas incesantes que salen en todas direcciones.', mods: { amount: 4, dmg: 12, cd: 35, pierce: 2 } },
    fire(w, s) {
      const targets = nearestEnemies(P.x, P.y, s.amount, 720);
      if (!targets.length) return false;
      // Si hay un jefe cerca, una parte de los disparos va hacia él
      const boss = bossNear(520);
      w.alt = !w.alt;
      if (boss && !targets.includes(boss)) {
        if (targets.length >= 2) targets[targets.length - 1] = boss;
        else if (w.alt) targets[0] = boss;
      }
      for (let i = 0; i < s.amount; i++) {
        const e = targets[i % targets.length];
        // Apunta un poco por delante del enemigo para no fallar
        const tt = Math.hypot(e.x - P.x, e.y - P.y) / s.speed;
        let a = Math.atan2(e.y + e.vy * tt - P.y, e.x + e.vx * tt - P.x);
        if (i >= targets.length) a += Math.ceil((i - targets.length + 1) / 2) * 0.16 * (i % 2 ? 1 : -1);
        shoot(P.x, P.y, a, s, 'pulso', this.color, 6);
      }
      if (w.evolved) {
        w.ring = (w.ring || 0) + 1;
        if (w.ring % 2 === 0) {
          const n = 14, o = rand(TAU);
          for (let k = 0; k < n; k++) shoot(P.x, P.y, o + (k / n) * TAU, s, 'pulso', '#a8fbff', 5);
        }
      }
      Sound.sfx.shoot();
    },
  },

  orbes: {
    name: 'Orbes Gemelos', color: '#c64dff', unit: ['orbe', 'orbes'],
    desc: 'Esferas de plasma que orbitan a tu alrededor.',
    base: { dmg: 9, amount: 2, speed: 3.0, area: 1 },
    levels: [{ dmg: 4 }, { amount: 1 }, { area: 20 }, { speed: 25 }, { amount: 1 }, { dmg: 7 }, { amount: 1, area: 15 }],
    evo: { with: 'area', name: 'Halo Solar', desc: 'Un segundo anillo de soles gira en sentido contrario.', mods: { dmg: 14, amount: 1, area: 25 } },
    update(w, s, dt) {
      w.ang = (w.ang || 0) + s.speed * dt;
      w.orbR = 10 * Math.sqrt(s.area);
      w.orbs = [];
      const rings = w.evolved ? 2 : 1;
      const hitCd = 0.42 * P.haste;
      for (let ring = 0; ring < rings; ring++) {
        const R = 78 * s.area * (ring ? 1.6 : 1);
        const dir = ring ? -1.25 : 1;
        const color = ring ? '#ffb84d' : this.color;
        for (let i = 0; i < s.amount; i++) {
          const a = w.ang * dir + (i / s.amount) * TAU + ring * 0.5;
          const x = P.x + Math.cos(a) * R, y = P.y + Math.sin(a) * R;
          w.orbs.push({ x, y, a, R, dir, color });
          forEachNear(x, y, w.orbR + 36, e => {
            const rr = w.orbR + e.r;
            if (e.orbT > G.time || dist2(x, y, e.x, e.y) > rr * rr) return;
            e.orbT = G.time + hitCd;
            damageEnemy(e, s.dmg, 'orbes', e.x - P.x, e.y - P.y, 260);
            burst(e.x, e.y, color, 4, 180, 0.3);
          });
        }
      }
    },
  },

  rayo: {
    name: 'Arco Voltaico', color: '#fff35c', unit: ['rayo', 'rayos'],
    desc: 'Rayos que caen del cielo y saltan de enemigo en enemigo.',
    base: { dmg: 16, cd: 1.5, amount: 1, chains: 2, area: 1 },
    levels: [{ chains: 1 }, { dmg: 8 }, { amount: 1 }, { cd: 15 }, { chains: 2 }, { dmg: 10 }, { amount: 1, chains: 1 }],
    evo: { with: 'poder', name: 'Tempestad', desc: 'Una tormenta eléctrica que fríe hordas enteras.', mods: { amount: 2, chains: 4, dmg: 20, cd: 25 } },
    fire(w, s) {
      const cands = enemiesNear(P.x, P.y, 520);
      if (!cands.length) return false;
      const boss = bossNear(520);
      for (let k = 0; k < s.amount; k++) lightning(k === 0 && boss && Math.random() < 0.5 ? boss : pick(cands), s, w.evolved);
      Sound.sfx.zap();
    },
  },

  nova: {
    name: 'Onda Nova', color: '#4dffb8', unit: ['onda', 'ondas'],
    desc: 'Ondas expansivas que dañan y empujan a la horda.',
    base: { dmg: 14, cd: 3.2, amount: 1, area: 1 },
    levels: [{ dmg: 6 }, { area: 20 }, { cd: 15 }, { amount: 1 }, { dmg: 10 }, { area: 20 }, { cd: 15, dmg: 8 }],
    evo: { with: 'vitalidad', name: 'Supernova', desc: 'Ondas colosales que te curan con cada impacto.', mods: { dmg: 25, area: 50, amount: 1 } },
    fire(w, s) {
      for (let i = 0; i < s.amount; i++) {
        after(i * 0.22, () => {
          waves.push({
            x: P.x, y: P.y, r: 8, max: 165 * s.area, dmg: s.dmg, hit: new Set(),
            color: w.evolved ? '#ffe14d' : this.color, heal: w.evolved ? 12 : 0, dead: false,
          });
          Sound.sfx.nova();
        });
      }
    },
  },

  disco: {
    name: 'Disco Cuántico', color: '#ff5ef0', unit: ['disco', 'discos'],
    desc: 'Discos cortantes que atraviesan enemigos y vuelven a ti.',
    base: { dmg: 15, cd: 2.0, amount: 1, area: 1, speed: 600, range: 290 },
    levels: [{ dmg: 6 }, { amount: 1 }, { area: 20 }, { cd: 15 }, { amount: 1 }, { dmg: 10 }, { amount: 1, range: 70 }],
    evo: { with: 'velocidad', name: 'Danza de Cuchillas', desc: 'Discos gigantes que siembran el caos a tu paso.', mods: { amount: 2, dmg: 15, area: 35, cd: 30 } },
    fire(w, s) {
      const t = nearestEnemy(P.x, P.y, 650);
      const base = t ? Math.atan2(t.y - P.y, t.x - P.x) : P.facing;
      const n = s.amount, spread = n <= 3 ? 0.45 : TAU / n;
      for (let i = 0; i < n; i++) {
        const a = base + (i - (n - 1) / 2) * spread;
        projectiles.push({
          kind: 1, x: P.x, y: P.y, vx: Math.cos(a) * s.speed, vy: Math.sin(a) * s.speed, v0: s.speed,
          r: 13 * s.area, dmg: s.dmg, life: 5, color: w.evolved ? '#ff9df5' : this.color, src: 'disco',
          hits: new Map(), phase: 0, trav: 0, range: s.range * Math.sqrt(s.area), spd: 0, spin: rand(TAU), dead: false,
        });
      }
      Sound.sfx.whoosh();
    },
  },

  meteoro: {
    name: 'Lluvia Estelar', color: '#ff7a3d', unit: ['meteoro', 'meteoros'],
    desc: 'Meteoritos que caen sobre la horda y estallan.',
    base: { dmg: 32, cd: 2.6, amount: 1, area: 1 },
    levels: [{ amount: 1 }, { dmg: 12 }, { area: 20 }, { cd: 15 }, { amount: 1 }, { dmg: 18 }, { amount: 2 }],
    evo: { with: 'multi', name: 'Apocalipsis', desc: 'El cielo entero se desploma sobre tus enemigos.', mods: { amount: 5, dmg: 30, area: 30, cd: 20 } },
    fire(w, s) {
      const cands = enemiesInView();
      const boss = cands.find(e => e.boss);
      for (let i = 0; i < s.amount; i++) {
        let x, y;
        if (cands.length) {
          const e = i === 0 && boss ? boss : pick(cands);
          x = e.x + rand(-15, 15); y = e.y + rand(-15, 15);
        } else {
          const a = rand(TAU), d = rand(100, 320);
          x = P.x + Math.cos(a) * d; y = P.y + Math.sin(a) * d;
        }
        strikes.push({ x, y, t: -i * 0.09, dur: 0.6, r: 68 * s.area, dmg: s.dmg, color: w.evolved ? '#ff3df0' : this.color, dead: false });
      }
    },
  },

  dron: {
    name: 'Drones Escolta', color: '#a6ff4d', unit: ['dron', 'drones'],
    desc: 'Drones autónomos que te escoltan y disparan sin parar.',
    base: { dmg: 6, cd: 0.5, amount: 1, area: 1, speed: 720, pierce: 0 },
    levels: [{ dmg: 3 }, { amount: 1 }, { cd: 15 }, { dmg: 4 }, { amount: 1 }, { cd: 15 }, { amount: 1, dmg: 4 }],
    evo: { with: 'iman', name: 'Escuadrón Fantasma', desc: 'Un enjambre de drones con munición perforante.', mods: { amount: 2, pierce: 3, dmg: 8, cd: 25 } },
    update(w, s, dt) {
      w.drones = w.drones || [];
      while (w.drones.length < s.amount) w.drones.push({ x: P.x, y: P.y, t: rand(s.cd), aim: 0, flash: 0 });
      w.ang = (w.ang || 0) + dt * 1.4;
      const n = w.drones.length, k = 1 - Math.exp(-7 * dt);
      const R = 46 + (n > 3 ? 14 : 0);
      for (let i = 0; i < n; i++) {
        const d = w.drones[i];
        const a = w.ang + (i / n) * TAU;
        d.x += (P.x + Math.cos(a) * R - d.x) * k;
        d.y += (P.y + Math.sin(a) * R * 0.8 - 8 - d.y) * k;
        d.flash -= dt;
        d.t -= dt;
        if (d.t <= 0) {
          const e = nearestEnemy(d.x, d.y, 520);
          if (e) {
            d.aim = Math.atan2(e.y - d.y, e.x - d.x);
            shoot(d.x, d.y, d.aim, s, 'dron', this.color, 4);
            d.t = s.cd;
            d.flash = 0.06;
            Sound.sfx.shoot();
          } else d.t = 0.12;
        }
      }
    },
  },
};

// -----------------------------------------------------------------------------
// MEJORAS PASIVAS
// -----------------------------------------------------------------------------
const PASSIVES = {
  poder:     { name: 'Poder',        color: '#ff4d6d', max: 5, desc: '+10% de daño a todas las armas.',      apply: p => { p.might += 0.1; } },
  cadencia:  { name: 'Cadencia',     color: '#ffd84d', max: 5, desc: '-8% de tiempo de recarga.',            apply: p => { p.haste *= 0.92; } },
  area:      { name: 'Expansión',    color: '#9d7dff', max: 5, desc: '+10% de área de efecto.',              apply: p => { p.area += 0.1; } },
  velocidad: { name: 'Propulsores',  color: '#4dffb8', max: 5, desc: '+10% de velocidad de movimiento.',     apply: p => { p.speedMul += 0.1; } },
  iman:      { name: 'Imán',         color: '#4db8ff', max: 5, desc: '+35% de radio para recoger cristales.', apply: p => { p.magnet *= 1.35; } },
  vitalidad: { name: 'Vitalidad',    color: '#ff5ea8', max: 5, desc: '+25 de vida máxima.',                  apply: p => { p.maxHp += 25; p.hp += 25; } },
  regen:     { name: 'Regeneración', color: '#5dff8a', max: 5, desc: 'Recuperas +0.5 de vida por segundo.',  apply: p => { p.regen += 0.5; } },
  multi:     { name: 'Duplicador',   color: '#ffa04d', max: 2, desc: '+1 proyectil para todas las armas.',   apply: p => { p.amount += 1; } },
  blindaje:  { name: 'Blindaje',     color: '#b0c4ff', max: 5, desc: '-7% de daño recibido.',                apply: p => { p.armor += 0.07; } },
};

// -----------------------------------------------------------------------------
// JEFES Y EVENTOS
// -----------------------------------------------------------------------------
// Ataques: ring = anillo de balas, spiral = espiral de balas, dash = embestida,
// summon = invoca enemigos, y los de zona (sin balas; un círculo avisa dónde golpeará):
// slam = pisotón con onda de choque alrededor, jump = salto que aplasta donde estabas,
// storm = tormenta de rayos que caen sobre ti y a tu alrededor.
const BOSSES = [
  { name: 'GUARDIÁN PRISMA',  hp: 1100,  r: 46, speed: 58, dmg: 20, color: '#ff2e97', sides: 6, attacks: ['slam', 'ring', 'summon'], ringN: 12, ringCount: 2, arms: 3, dashes: 2 },
  { name: 'DEVORADOR',        hp: 3200,  r: 50, speed: 70, dmg: 24, color: '#ff9f1c', sides: 3, attacks: ['dash', 'jump', 'dash', 'ring'], ringN: 14, ringCount: 1, arms: 3, dashes: 3 },
  { name: 'TEJEDOR DEL CAOS', hp: 7000,  r: 54, speed: 64, dmg: 28, color: '#b04dff', sides: 5, attacks: ['storm', 'dash', 'spiral', 'summon'], ringN: 16, ringCount: 2, arms: 3, dashes: 2 },
  { name: 'NÚCLEO DEL VACÍO', hp: 24000, r: 60, speed: 55, dmg: 34, color: '#ff2244', sides: 8, attacks: ['jump', 'ring', 'storm', 'dash', 'slam', 'spiral', 'summon'], ringN: 18, ringCount: 2, arms: 3, dashes: 2, final: true },
];

const EVENTS = [
  { t: 1,   type: 'msg', title: '¡SOBREVIVE!', sub: 'La horda se acerca', kind: 'cyan' },
  { t: 60,  type: 'swarm', enemy: 'zangano', n: 26 },
  { t: 120, type: 'swarm', enemy: 'veloz', n: 30 },
  { t: 150, type: 'boss', i: 0 },
  { t: 200, type: 'stampede', enemy: 'veloz', n: 28, speed: 1.6 },
  { t: 250, type: 'swarm', enemy: 'divisor', n: 22 },
  { t: 300, type: 'boss', i: 1 },
  { t: 340, type: 'swarm', enemy: 'zangano', n: 60 },
  { t: 380, type: 'stampede', enemy: 'tanque', n: 14, speed: 2.2 },
  { t: 420, type: 'swarm', enemy: 'centinela', n: 22 },
  { t: 450, type: 'boss', i: 2 },
  { t: 500, type: 'stampede', enemy: 'veloz', n: 40, speed: 1.7 },
  { t: 530, type: 'swarm', enemy: 'tanque', n: 26 },
  { t: 570, type: 'msg', title: 'ALGO SE ACERCA...', sub: '30 segundos', kind: 'boss' },
  { t: 600, type: 'boss', i: 3 },
];

// =============================================================================
// 5. ESTADO DE LA PARTIDA
// =============================================================================
// state: 'menu' | 'playing' | 'levelup' | 'chest' | 'paused' | 'ending' | 'over'
let state = 'menu';
let G = null;   // datos de la partida
let P = null;   // jugador
let enemies = [], bossList = [], projectiles = [], ebullets = [], hazards = [], gems = [], pickups = [];
let particles = [], rings = [], bolts = [], waves = [], strikes = [], texts = [], timers = [];
let pCursor = 0;
let menuEnts = [];
const cam = { x: 0, y: 0 };

const xpNeed = L => Math.round(5 + 5 * (L - 1) + 0.2 * (L - 1) ** 2);
const spawnR = () => Math.hypot(W, H) / (2 * VIEW) + 50;
const maxLevel = id => WEAPONS[id].levels.length + 1;
const getWeapon = id => P.weapons.find(w => w.id === id);
const getPassive = id => P.passives.find(p => p.id === id);

function newPlayer() {
  return {
    x: 0, y: 0, vx: 0, vy: 0, r: 13,
    hp: 100, maxHp: 100, speed: 210,
    invul: 0, hurtT: 0, facing: 0,
    level: 1, xp: 0, xpNext: xpNeed(1),
    trail: [], trailT: 0,
    // multiplicadores que modifican las mejoras pasivas
    might: 1, haste: 1, area: 1, amount: 0, speedMul: 1, magnet: 90, regen: 0, armor: 0,
    weapons: [], passives: [],
  };
}

function newGameState() {
  return {
    time: 0, kills: 0, spawnAcc: 0, evIdx: 0,
    hpMul: 1, dmgMul: 1, spdMul: 1,
    shake: 0, slow: 0, flashA: 0, flashC: '255,255,255',
    pending: 0, combo: 0, gemT: -1,
    dmgBy: {}, won: false, endT: 0, finalBoss: false,
    god: false, bot: false,
  };
}

// =============================================================================
// 6. ENTRADA
// =============================================================================
const keys = new Set();
// Joystick táctil "flotante": aparece donde pones el dedo
const touch = { active: false, id: null, ox: 0, oy: 0, x: 0, y: 0 };
const STICK_R = 60;   // radio del joystick (píxeles de pantalla)
const STICK_DEAD = 8; // zona muerta: movimientos muy pequeños no cuentan

addEventListener('keydown', e => {
  keys.add(e.code);
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
  if (e.repeat) return;
  if (e.code === 'KeyP' || e.code === 'Escape') togglePause();
  if (e.code === 'KeyM') toggleMusic();
  if (state === 'levelup' && /^[1-4]$/.test(e.key)) chooseCard(+e.key - 1);
  if (state === 'chest' && (e.code === 'Enter' || e.code === 'Space')) closeChest();
  if ((state === 'menu' || state === 'over') && e.code === 'Enter') startGame();
});
addEventListener('keyup', e => keys.delete(e.code));
addEventListener('blur', () => { keys.clear(); resetTouch(); if (state === 'playing') togglePause(); });
document.addEventListener('visibilitychange', () => { if (document.hidden && state === 'playing') togglePause(); });

// Evita el menú de "mantener pulsado", el zoom con dos dedos y el doble toque
addEventListener('contextmenu', e => e.preventDefault());
document.addEventListener('gesturestart', e => e.preventDefault());
document.addEventListener('dblclick', e => e.preventDefault());
addEventListener('orientationchange', () => setTimeout(resize, 250));

function resetTouch() {
  touch.active = false;
  touch.id = null;
}

canvas.addEventListener('touchstart', e => {
  e.preventDefault();
  Sound.init();
  if (touch.active) return; // solo el primer dedo mueve al personaje
  const t = e.changedTouches[0];
  touch.active = true;
  touch.id = t.identifier;
  touch.ox = touch.x = t.clientX;
  touch.oy = touch.y = t.clientY;
  hide($('touch-hint'));
}, { passive: false });

canvas.addEventListener('touchmove', e => {
  e.preventDefault();
  for (const t of e.changedTouches) {
    if (t.identifier !== touch.id) continue;
    touch.x = t.clientX;
    touch.y = t.clientY;
    // Si el dedo se aleja más que el radio, el centro del joystick le sigue:
    // así cambiar de dirección es instantáneo
    const dx = touch.x - touch.ox, dy = touch.y - touch.oy, l = Math.hypot(dx, dy);
    if (l > STICK_R) {
      touch.ox = touch.x - (dx / l) * STICK_R;
      touch.oy = touch.y - (dy / l) * STICK_R;
    }
  }
}, { passive: false });

const endTouch = e => { for (const t of e.changedTouches) if (t.identifier === touch.id) resetTouch(); };
canvas.addEventListener('touchend', endTouch);
canvas.addEventListener('touchcancel', endTouch);

function readInput() {
  if (G.bot) return botInput();
  let x = 0, y = 0;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) x -= 1;
  if (keys.has('KeyD') || keys.has('ArrowRight')) x += 1;
  if (keys.has('KeyW') || keys.has('ArrowUp')) y -= 1;
  if (keys.has('KeyS') || keys.has('ArrowDown')) y += 1;
  if (touch.active) {
    const dx = touch.x - touch.ox, dy = touch.y - touch.oy, l = Math.hypot(dx, dy);
    if (l > STICK_DEAD) {
      const m = Math.min(1, (l - STICK_DEAD) / (STICK_R * 0.7));
      x = (dx / l) * m;
      y = (dy / l) * m;
    }
  }
  const l = Math.hypot(x, y);
  if (l > 1) { x /= l; y /= l; }
  return { x, y };
}

// Piloto automático (solo para el modo de pruebas ?dev)
function botInput() {
  let fx = 0, fy = 0;
  for (const e of enemies) {
    const dx = P.x - e.x, dy = P.y - e.y, d = dx * dx + dy * dy;
    if (d < 260 * 260 && d > 1) { const w = (e.boss ? 6 : 1) / d; fx += dx * w; fy += dy * w; }
  }
  for (const b of ebullets) {
    const dx = P.x - b.x, dy = P.y - b.y, d = dx * dx + dy * dy;
    if (d < 120 * 120 && d > 1) { fx += (dx / d) * 2; fy += (dy / d) * 2; }
  }
  // Va a por cofres y cristales cuando no hay peligro cerca
  let target = null, bd = 700 * 700;
  for (const p of pickups) { const d = dist2(P.x, P.y, p.x, p.y); if (d < bd) { bd = d; target = p; } }
  if (!target) for (const g of gems) { const d = dist2(P.x, P.y, g.x, g.y); if (d < bd) { bd = d; target = g; } }
  if (target) {
    const d = Math.sqrt(bd) || 1;
    fx += ((target.x - P.x) / d) * 0.012;
    fy += ((target.y - P.y) / d) * 0.012;
  }
  fx += Math.cos(G.time * 0.3) * 0.002;
  fy += Math.sin(G.time * 0.3) * 0.002;
  const l = Math.hypot(fx, fy);
  return l > 1e-6 ? { x: fx / l, y: fy / l } : { x: 0, y: 0 };
}

// =============================================================================
// 7. LÓGICA
// =============================================================================

// ---------- Cuadrícula espacial: para encontrar enemigos cercanos muy rápido ---
const CELL = 72;
const grid = new Map();
let gridFrames = 0;
const cellKey = (cx, cy) => (cx + 32768) * 65536 + (cy + 32768);

function gridBuild() {
  for (const arr of grid.values()) arr.length = 0;
  if (++gridFrames % 300 === 0) grid.clear();
  for (const e of enemies) {
    if (e.dead || e.boss) continue;
    const k = cellKey(Math.floor(e.x / CELL), Math.floor(e.y / CELL));
    let arr = grid.get(k);
    if (!arr) { arr = []; grid.set(k, arr); }
    arr.push(e);
  }
}

// Llama a fn(enemigo) para cada enemigo cerca de (x, y). Los jefes siempre se incluyen.
function forEachNear(x, y, r, fn) {
  const x0 = Math.floor((x - r) / CELL), x1 = Math.floor((x + r) / CELL);
  const y0 = Math.floor((y - r) / CELL), y1 = Math.floor((y + r) / CELL);
  for (let cx = x0; cx <= x1; cx++) {
    for (let cy = y0; cy <= y1; cy++) {
      const arr = grid.get(cellKey(cx, cy));
      if (!arr) continue;
      for (let i = 0; i < arr.length; i++) { const e = arr[i]; if (!e.dead) fn(e); }
    }
  }
  for (const b of bossList) if (!b.dead) fn(b);
}

function nearestEnemy(x, y, maxR) {
  let best = null, bd = maxR * maxR;
  for (const e of enemies) {
    if (e.dead) continue;
    const d = dist2(x, y, e.x, e.y);
    if (d < bd) { bd = d; best = e; }
  }
  return best;
}

function nearestEnemies(x, y, n, maxR) {
  const best = [];
  const m2 = maxR * maxR;
  for (const e of enemies) {
    if (e.dead) continue;
    const d = dist2(x, y, e.x, e.y);
    if (d > m2) continue;
    if (best.length < n) { best.push([d, e]); best.sort((a, b) => a[0] - b[0]); }
    else if (d < best[n - 1][0]) { best[n - 1] = [d, e]; best.sort((a, b) => a[0] - b[0]); }
  }
  return best.map(b => b[1]);
}

function bossNear(r) {
  return bossList.find(b => !b.dead && dist2(P.x, P.y, b.x, b.y) < r * r) || null;
}

function enemiesNear(x, y, r) {
  const r2 = r * r;
  return enemies.filter(e => !e.dead && dist2(x, y, e.x, e.y) < r2);
}

function enemiesInView() {
  return enemies.filter(e => !e.dead && e.x > viewL && e.x < viewR && e.y > viewT && e.y < viewB);
}

// ---------- Temporizadores de juego (se congelan al pausar) -------------------
function after(t, fn) { timers.push({ t, fn }); }
function updateTimers(dt) {
  for (let i = timers.length - 1; i >= 0; i--) {
    const tm = timers[i];
    tm.t -= dt;
    if (tm.t <= 0) { timers.splice(i, 1); tm.fn(); }
  }
}

// ---------- Efectos visuales ---------------------------------------------------
function addParticle(x, y, vx, vy, life, size, color, kind = 0, drag = 4) {
  let p;
  if (particles.length < maxParticles) { p = {}; particles.push(p); }
  else { p = particles[pCursor % particles.length]; pCursor = (pCursor + 1) % maxParticles; }
  p.x = x; p.y = y; p.vx = vx; p.vy = vy;
  p.life = life; p.max = life; p.size = size; p.color = color; p.kind = kind; p.drag = drag;
}

// Explosión de partículas (kind 1 = chispa alargada, 0 = punto)
function burst(x, y, color, n, spd = 220, life = 0.5) {
  for (let i = 0; i < n; i++) {
    const a = rand(TAU), v = rand(0.25, 1) * spd;
    addParticle(x, y, Math.cos(a) * v, Math.sin(a) * v, rand(0.5, 1) * life, rand(2, 4.5), color, Math.random() < 0.6 ? 1 : 0);
  }
}

function addRing(x, y, max, color, life = 0.4, w = 3) {
  rings.push({ x, y, max, color, life, maxLife: life, w });
}

function addText(x, y, txt, crit, color) {
  if (texts.length > 80 && !crit) return;
  texts.push({
    x, y, vy: -70, life: 0.65, max: 0.65, txt: String(txt),
    color: color || (crit ? '#ffd84d' : '#ffffff'), size: (crit ? 21 : 14) * TEXT_SCALE,
  });
}

// Rayo dentado entre dos puntos
function addBolt(x1, y1, x2, y2, color, w) {
  const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1;
  const n = Math.max(3, Math.floor(len / 22));
  const nx = -dy / len, ny = dx / len;
  const pts = [x1, y1];
  for (let i = 1; i < n; i++) {
    const t = i / n, off = rand(-1, 1) * Math.min(18, len * 0.12);
    pts.push(x1 + dx * t + nx * off, y1 + dy * t + ny * off);
  }
  pts.push(x2, y2);
  bolts.push({ pts, life: 0.22, maxLife: 0.22, color, w });
}

function banner(title, sub = '', kind = '') {
  const b = $('banner');
  $('banner-title').textContent = title;
  $('banner-sub').textContent = sub;
  b.className = '';
  void b.offsetWidth; // reinicia la animación CSS
  b.className = 'show ' + kind;
}

// ---------- Jugador -------------------------------------------------------------
function updatePlayer(dt) {
  const inp = readInput();
  const spd = P.speed * P.speedMul;
  const k = 1 - Math.exp(-14 * dt);
  P.vx += (inp.x * spd - P.vx) * k;
  P.vy += (inp.y * spd - P.vy) * k;
  P.x += P.vx * dt;
  P.y += P.vy * dt;
  if (inp.x || inp.y) P.facing = Math.atan2(inp.y, inp.x);
  P.invul -= dt;
  P.hurtT -= dt;
  if (P.regen > 0 && P.hp < P.maxHp) P.hp = Math.min(P.maxHp, P.hp + P.regen * dt);

  // Estela
  P.trailT -= dt;
  if (P.trailT <= 0) {
    P.trailT = 0.016;
    P.trail.push({ x: P.x, y: P.y, life: 0.35 });
    if (P.trail.length > 24) P.trail.shift();
  }
  for (const t of P.trail) t.life -= dt;
  const moving = Math.hypot(P.vx, P.vy);
  if (moving > 60 && Math.random() < 0.6) {
    addParticle(P.x - Math.cos(P.facing) * 10, P.y - Math.sin(P.facing) * 10,
      -P.vx * 0.3 + rand(-30, 30), -P.vy * 0.3 + rand(-30, 30), 0.35, rand(1.5, 3), '#4df3ff', 0, 3);
  }

  // Cámara suave
  const ck = 1 - Math.exp(-8 * dt);
  cam.x += (P.x - cam.x) * ck;
  cam.y += (P.y - cam.y) * ck;
}

function hurtPlayer(dmg) {
  if (P.invul > 0 || state !== 'playing' || G.god || G.won) return;
  dmg = dmg * G.dmgMul * (1 - P.armor);
  P.hp -= dmg;
  P.invul = 0.6;
  P.hurtT = 0.35;
  G.shake = Math.max(G.shake, 12);
  G.flashA = 0.25;
  G.flashC = '255,30,70';
  burst(P.x, P.y, '#ff3366', 16, 260);
  addText(P.x, P.y - 24, Math.round(dmg), false, '#ff5577');
  Sound.sfx.hurt();
  buzz(40);
  if (P.hp <= 0) { P.hp = 0; playerDeath(); }
}

function healPlayer(v, silent) {
  const before = P.hp;
  P.hp = Math.min(P.maxHp, P.hp + v);
  if (!silent && P.hp - before >= 1) addText(P.x, P.y - 30, '+' + Math.round(P.hp - before), false, '#5dff9d');
}

function addXp(v) {
  P.xp += v;
  while (P.xp >= P.xpNext) {
    P.xp -= P.xpNext;
    P.level++;
    P.xpNext = xpNeed(P.level);
    G.pending++;
  }
}

function playerDeath() {
  state = 'ending';
  G.endT = 2;
  G.shake = 30;
  G.flashA = 0.6;
  G.flashC = '255,40,90';
  burst(P.x, P.y, '#4df3ff', 90, 520, 1);
  burst(P.x, P.y, '#ffffff', 40, 300, 0.8);
  addRing(P.x, P.y, 320, '#4df3ff', 0.9, 8);
  addRing(P.x, P.y, 180, '#ff2e97', 0.6, 5);
  buzz([200, 80, 300]);
  Sound.sfx.lose();
  Sound.fadeOut();
}

// ---------- Armas ---------------------------------------------------------------
function computeStats(w) {
  const def = WEAPONS[w.id];
  const s = Object.assign({}, def.base);
  const apply = mods => {
    for (const k in mods) {
      const v = mods[k];
      if (k === 'cd') s.cd *= 1 - v / 100;
      else if (k === 'area') s.area += v / 100;
      else if (k === 'speed') s.speed *= 1 + v / 100;
      else s[k] += v;
    }
  };
  for (let i = 0; i < w.level - 1; i++) apply(def.levels[i]);
  if (w.evolved) apply(def.evo.mods);
  s.dmg *= P.might;
  if (s.cd) s.cd *= P.haste;
  s.area *= P.area;
  s.amount += P.amount;
  return s;
}

function recalcStats() { for (const w of P.weapons) w.stats = computeStats(w); }

function addWeapon(id) {
  P.weapons.push({ id, level: 1, t: 0.4, evolved: false, stats: null });
  recalcStats();
}

const canEvolve = w => w.level >= maxLevel(w.id) && !w.evolved && !!getPassive(WEAPONS[w.id].evo.with);

function updateWeapons(dt) {
  for (const w of P.weapons) {
    const def = WEAPONS[w.id], s = w.stats;
    if (def.update) def.update(w, s, dt);
    if (def.fire) {
      w.t -= dt;
      if (w.t <= 0) w.t = def.fire(w, s) === false ? 0.15 : s.cd;
    }
  }
}

function shoot(x, y, a, s, src, color, size) {
  projectiles.push({
    kind: 0, x, y, vx: Math.cos(a) * s.speed, vy: Math.sin(a) * s.speed, a,
    r: size * Math.sqrt(s.area), dmg: s.dmg, pierce: s.pierce || 0, life: 1.4,
    color, src, hits: null, dead: false,
  });
}

function lightning(first, s, evolved) {
  const hit = new Set();
  const col = evolved ? '#9df3ff' : '#fff35c';
  let cur = first, px = first.x + rand(-80, 80), py = first.y - 520;
  addRing(first.x, first.y, 60, col, 0.3, 3);
  for (let i = 0; i <= s.chains && cur; i++) {
    hit.add(cur);
    addBolt(px, py, cur.x, cur.y, col, i === 0 ? 3.2 : 2.2);
    const ex = cur.x, ey = cur.y;
    damageEnemy(cur, s.dmg, 'rayo', 0, 0, 0);
    burst(ex, ey, col, 6, 200, 0.3);
    px = ex; py = ey;
    // salta al enemigo más cercano que aún no ha recibido el rayo
    let best = null, bd = (170 * s.area) ** 2;
    forEachNear(ex, ey, 170 * s.area, e => {
      if (hit.has(e)) return;
      const d = dist2(ex, ey, e.x, e.y);
      if (d < bd) { bd = d; best = e; }
    });
    cur = best;
  }
}

function moveDisc(b, dt) {
  if (b.phase === 0) { // ida: frena poco a poco
    const sp = b.v0 * (1 - (b.trav / b.range) * 0.85);
    const l = Math.hypot(b.vx, b.vy) || 1;
    b.vx = (b.vx / l) * sp;
    b.vy = (b.vy / l) * sp;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.trav += sp * dt;
    if (b.trav >= b.range) { b.phase = 1; b.spd = 60; }
  } else { // vuelta: acelera hacia el jugador
    b.spd = Math.min(b.spd + 1500 * dt, 950);
    const dx = P.x - b.x, dy = P.y - b.y, d = Math.hypot(dx, dy) || 1;
    if (d < b.spd * dt + 12) { b.dead = true; return; }
    b.vx = (dx / d) * b.spd;
    b.vy = (dy / d) * b.spd;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
  }
  b.spin += dt * 16;
}

function updateProjectiles(dt) {
  for (const b of projectiles) {
    if (b.dead) continue;
    b.life -= dt;
    if (b.life <= 0) { b.dead = true; continue; }
    if (b.kind === 1) moveDisc(b, dt);
    else { b.x += b.vx * dt; b.y += b.vy * dt; }
    if (b.dead) continue;
    forEachNear(b.x, b.y, b.r + 40, e => {
      if (b.dead) return;
      const rr = b.r + e.r;
      if (dist2(b.x, b.y, e.x, e.y) > rr * rr) return;
      if (b.kind === 1) { // disco: golpea a cada enemigo cada 0.3 s
        const next = b.hits.get(e);
        if (next !== undefined && next > G.time) return;
        b.hits.set(e, G.time + 0.3);
        damageEnemy(e, b.dmg, b.src, b.vx, b.vy, 160);
        burst(e.x, e.y, b.color, 3, 160, 0.25);
        return;
      }
      if (!b.hits) b.hits = new Set();
      if (b.hits.has(e)) return;
      b.hits.add(e);
      damageEnemy(e, b.dmg, b.src, b.vx, b.vy, 90);
      burst(b.x, b.y, b.color, 4, 180, 0.25);
      if (b.pierce-- <= 0) b.dead = true;
    });
  }
}

function updateWaves(dt) {
  for (const w of waves) {
    if (w.dead) continue;
    w.r += (620 - 420 * (w.r / w.max)) * dt;
    if (w.r >= w.max) { w.dead = true; continue; }
    forEachNear(w.x, w.y, w.r + 40, e => {
      if (w.hit.has(e)) return;
      const rr = w.r + e.r;
      if (dist2(w.x, w.y, e.x, e.y) > rr * rr) return;
      w.hit.add(e);
      damageEnemy(e, w.dmg, 'nova', e.x - w.x, e.y - w.y, 420);
      if (w.heal > 0) { w.heal -= 0.5; healPlayer(0.5, true); }
    });
  }
}

function updateStrikes(dt) {
  for (const s of strikes) {
    if (s.dead) continue;
    s.t += dt;
    if (s.t >= s.dur) explodeStrike(s);
  }
}

function explodeStrike(st) {
  st.dead = true;
  forEachNear(st.x, st.y, st.r + 40, e => {
    const rr = st.r + e.r * 0.5;
    if (dist2(st.x, st.y, e.x, e.y) > rr * rr) return;
    damageEnemy(e, st.dmg, 'meteoro', e.x - st.x, e.y - st.y, 380);
  });
  burst(st.x, st.y, st.color, 26, 380, 0.6);
  burst(st.x, st.y, '#ffe9a8', 10, 200, 0.4);
  addRing(st.x, st.y, st.r * 1.3, st.color, 0.4, 5);
  addRing(st.x, st.y, st.r * 0.7, '#ffffff', 0.25, 3);
  G.shake = Math.max(G.shake, 5);
  Sound.sfx.boom();
}

// ---------- Daño y muerte de enemigos ------------------------------------------
function damageEnemy(e, dmg, src, kx = 0, ky = 0, kb = 0) {
  if (e.dead) return;
  const crit = Math.random() < 0.08;
  if (crit) dmg *= 2;
  dmg = Math.max(1, Math.round(dmg));
  e.hp -= dmg;
  e.flash = 0.09;
  G.dmgBy[src] = (G.dmgBy[src] || 0) + dmg;
  if (kb && !e.boss) {
    const l = Math.hypot(kx, ky) || 1;
    const k = kb * (e.heavy ? 0.35 : 1) * (e.elite ? 0.5 : 1);
    e.kbx += (kx / l) * k;
    e.kby += (ky / l) * k;
  }
  addText(e.x + rand(-8, 8), e.y - e.r * 0.6, dmg, crit);
  Sound.sfx.hit();
  if (e.hp <= 0) killEnemy(e);
}

function killEnemy(e) {
  if (e.dead) return;
  e.dead = true;
  G.kills++;
  burst(e.x, e.y, e.color, e.elite ? 40 : 10 + Math.floor(e.r * 0.5), e.elite ? 320 : 220);
  addRing(e.x, e.y, e.r * 2.4, e.color, 0.3, 2.5);
  if (e.boss) { bossDeath(e); return; }
  dropGem(e.x, e.y, e.xp);
  for (let i = 0; i < e.split; i++) {
    const a = (i / e.split) * TAU + rand(0.5);
    const m = spawnEnemy('mini', e.x + Math.cos(a) * 10, e.y + Math.sin(a) * 10);
    m.kbx = Math.cos(a) * 260;
    m.kby = Math.sin(a) * 260;
  }
  if (e.elite) {
    dropPickup(e.x + 20, e.y, Math.random() < 0.3 ? 'chest' : 'heart');
  } else {
    const r = Math.random();
    if (r < 0.006) dropPickup(e.x, e.y, 'heart');
    else if (r < 0.008) dropPickup(e.x, e.y, 'magnet');
    else if (r < 0.0095) dropPickup(e.x, e.y, 'bomb');
  }
  Sound.sfx.kill();
}

function dropGem(x, y, v) {
  if (v <= 0) return;
  if (gems.length >= MAX_GEMS) { // demasiados cristales: se suma a uno que ya existe
    const g = gems[Math.floor(Math.random() * gems.length)];
    g.v += v;
    g.tier = gemTier(g.v);
    return;
  }
  gems.push({ x, y, vx: rand(-40, 40), vy: rand(-40, 40), v, tier: gemTier(v), mag: false, spd: 0, t: rand(TAU), dead: false });
}

function dropPickup(x, y, kind) {
  pickups.push({ x, y, kind, t: rand(TAU), dead: false });
}

// ---------- Aparición de enemigos ----------------------------------------------
function spawnEnemy(type, x, y, opt = {}) {
  const T = ENEMY_TYPES[type];
  const elite = !!opt.elite;
  const m = G.time / 60;
  const e = {
    type, x, y, vx: 0, vy: 0, kbx: 0, kby: 0,
    r: T.r * (elite ? 1.35 : 1),
    hp: T.hp * G.hpMul * (elite ? 8 : 1),
    dmg: T.dmg * (elite ? 1.5 : 1),
    speed: T.speed * G.spdMul * (opt.speedMul || 1) * rand(0.92, 1.08) * (elite ? 0.85 : 1),
    xp: T.xp * (1 + m * 0.15) * (elite ? 10 : 1),
    color: T.color,
    spr: enemySprite(type, false, elite), sprF: enemySprite(type, true, elite),
    angle: rand(TAU), spin: (T.spin || 0) * (Math.random() < 0.5 ? -1 : 1),
    face: !!T.face, ranged: !!T.ranged, heavy: !!T.heavy, split: T.split || 0,
    elite, boss: false, flash: 0, dead: false, orbT: 0,
    shootT: rand(1, 2.5), strafe: Math.random() < 0.5 ? -1 : 1, phase: rand(TAU),
    mode: 0, modeT: 0, ca: 0, // embestida (centinelas): 1 = apuntando, 2 = embistiendo
    sep: skinImg[type] ? 1.3 : 1, // con imagen grande se separan un poco más para no amontonarse
    dir: opt.dir || null, life: opt.life || 0,
  };
  e.maxHp = e.hp;
  enemies.push(e);
  return e;
}

function spawnPos() {
  const a = rand(TAU), R = spawnR();
  return [P.x + Math.cos(a) * R, P.y + Math.sin(a) * R];
}

function pickEnemyType() {
  const t = G.time;
  const table = [['zangano', Math.max(3, 10 - t / 60)]];
  if (t > 40) table.push(['veloz', 3 + t / 120]);
  if (t > 100) table.push(['divisor', 2.5]);
  if (t > 160) table.push(['centinela', 2]);
  if (t > 210) table.push(['tanque', 1 + t / 200]);
  return weightedPick(table);
}

function updateDifficulty() {
  const m = G.time / 60;
  G.hpMul = 1 + m * 0.32 + m * m * 0.028;
  G.dmgMul = 1 + m * 0.07;
  G.spdMul = 1 + m * 0.025;
}

function updateSpawner(dt) {
  const m = G.time / 60;
  const rate = (0.9 + m * 1.5 + m * m * 0.13) * (G.finalBoss ? 0.5 : 1);
  G.spawnAcc += rate * dt;
  while (G.spawnAcc >= 1) {
    G.spawnAcc -= 1;
    if (enemies.length >= MAX_ENEMIES) { G.spawnAcc = 0; break; }
    const [x, y] = spawnPos();
    const elite = G.time > 180 && Math.random() < 0.003 + m * 0.0004;
    spawnEnemy(pickEnemyType(), x, y, { elite });
  }
}

function updateEvents() {
  while (G.evIdx < EVENTS.length && G.time >= EVENTS[G.evIdx].t) runEvent(EVENTS[G.evIdx++]);
}

function runEvent(ev) {
  const m = G.time / 60;
  if (ev.type === 'msg') {
    banner(ev.title, ev.sub, ev.kind);
    if (ev.kind === 'boss') Sound.sfx.alarm();
  } else if (ev.type === 'swarm') { // un círculo de enemigos que se cierra sobre ti
    banner('¡TE RODEAN!', 'Abre un hueco y escapa');
    const n = Math.min(ev.n + Math.floor(m * 3), MAX_ENEMIES + 150 - enemies.length), R = spawnR() * 0.92;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU;
      spawnEnemy(ev.enemy, P.x + Math.cos(a) * R, P.y + Math.sin(a) * R);
    }
  } else if (ev.type === 'stampede') { // un muro de enemigos que cruza la pantalla
    banner('¡ESTAMPIDA!', 'Apártate del camino');
    const a = rand(TAU), dx = Math.cos(a), dy = Math.sin(a);
    const R = spawnR();
    const cx = P.x - dx * R, cy = P.y - dy * R;
    const px = -dy, py = dx;
    const speed = ENEMY_TYPES[ev.enemy].speed * ev.speed * G.spdMul;
    const life = (R * 2 + 300) / speed;
    for (let i = 0; i < ev.n && enemies.length < MAX_ENEMIES + 150; i++) {
      const off = (i - ev.n / 2) * 34 + rand(-8, 8), back = rand(0, 90);
      spawnEnemy(ev.enemy, cx + px * off - dx * back, cy + py * off - dy * back, { dir: { x: dx, y: dy }, life, speedMul: ev.speed });
    }
  } else if (ev.type === 'boss') {
    spawnBoss(ev.i);
  }
}

// ---------- Enemigos -------------------------------------------------------------
const CHARGE_K = 6, CHARGE_T = 0.5; // embestida del centinela: x6 de velocidad durante medio segundo

function enemyShot(x, y, a, spd, dmg, color) {
  if (ebullets.length > 600) return;
  ebullets.push({ x, y, vx: Math.cos(a) * spd, vy: Math.sin(a) * spd, r: 6, dmg, color, life: 7, dead: false });
}

// Si un enemigo se queda muy atrás, reaparece delante del jugador
function relocate(e) {
  const sp = Math.hypot(P.vx, P.vy);
  const a = sp > 20 ? Math.atan2(P.vy, P.vx) + rand(-1.1, 1.1) : rand(TAU);
  const R = spawnR();
  e.x = P.x + Math.cos(a) * R;
  e.y = P.y + Math.sin(a) * R;
  e.kbx = e.kby = 0;
}

function updateEnemies(dt) {
  const despawn2 = (spawnR() * 1.7) ** 2;
  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i];
    if (e.dead) continue;
    if (e.boss) { updateBoss(e, dt); continue; }
    let dx = P.x - e.x, dy = P.y - e.y;
    const d = Math.hypot(dx, dy) || 1;
    dx /= d; dy /= d;
    let mx = dx, my = dy;
    if (e.dir) {
      mx = e.dir.x; my = e.dir.y;
      e.life -= dt;
      if (e.life <= 0) { e.dead = true; continue; }
    } else if (e.ranged) { // mantiene la distancia; a veces dispara y a veces te embiste
      e.shootT -= dt;
      if (e.mode === 1) { // se para y apunta (se ve una franja de aviso)
        mx = 0; my = 0;
        e.modeT -= dt;
        if (e.modeT > 0.2) e.ca = Math.atan2(dy, dx); // al final deja de seguirte: puedes esquivarla
        if (e.modeT <= 0) { e.mode = 2; e.modeT = CHARGE_T; Sound.sfx.dash(); }
      } else if (e.mode === 2) { // embestida en línea recta
        mx = Math.cos(e.ca) * CHARGE_K; my = Math.sin(e.ca) * CHARGE_K;
        e.modeT -= dt;
        if (Math.random() < 0.5) addParticle(e.x, e.y, -mx * 25, -my * 25, 0.35, rand(2, 4), e.color, 0, 3);
        if (e.modeT <= 0) e.mode = 0;
      } else {
        if (d < 170) { mx = -dx; my = -dy; }
        else if (d < 270) { mx = -dy * e.strafe; my = dx * e.strafe; }
        if (e.shootT <= 0 && d < 460) {
          e.shootT = rand(3.6, 4.8);
          if (d < 330 && Math.random() < 0.6) {
            e.mode = 1; e.modeT = 0.6; e.ca = Math.atan2(dy, dx);
          } else {
            enemyShot(e.x, e.y, Math.atan2(dy, dx), 220, e.dmg * 0.8, '#ff5a5a');
            Sound.sfx.eshoot();
          }
        }
      }
    }
    // Separación: los enemigos se empujan entre sí para no amontonarse
    let sx = 0, sy = 0;
    forEachNear(e.x, e.y, e.r * e.sep + 46, o => {
      if (o === e) return;
      const ox = e.x - o.x, oy = e.y - o.y, rr = (e.r + o.r) * (o.boss ? 1 : e.sep);
      const dd = ox * ox + oy * oy;
      if (dd >= rr * rr) return;
      if (dd < 0.01) { sx += rand(-1, 1); sy += rand(-1, 1); return; }
      const dl = Math.sqrt(dd), push = ((rr - dl) / rr) * (o.boss ? 3 : 1);
      sx += (ox / dl) * push;
      sy += (oy / dl) * push;
    });
    e.vx = mx * e.speed;
    e.vy = my * e.speed;
    e.x += (e.vx + sx * 140 + e.kbx) * dt;
    e.y += (e.vy + sy * 140 + e.kby) * dt;
    const kd = Math.exp(-8 * dt);
    e.kbx *= kd;
    e.kby *= kd;
    if (e.face) e.angle = Math.atan2(my, mx);
    else e.angle += e.spin * dt;
    if (e.flash > 0) e.flash -= dt;
    if (d < e.r + P.r - 4) hurtPlayer(e.dmg);
    else if (!e.dir && d * d > despawn2) relocate(e);
  }
}

function updateEnemyBullets(dt) {
  for (const b of ebullets) {
    if (b.dead) continue;
    b.life -= dt;
    if (b.life <= 0) { b.dead = true; continue; }
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    const rr = b.r + P.r - 3;
    if (dist2(b.x, b.y, P.x, P.y) < rr * rr) {
      b.dead = true;
      burst(b.x, b.y, b.color, 6, 150, 0.3);
      hurtPlayer(b.dmg);
    }
  }
}

// ---------- Ataques de zona (sin balas) -------------------------------------------
// Aparece un círculo en el suelo que se va llenando; cuando está lleno, golpea.
// Si sigues dentro en ese momento, te hace daño: ¡sal del círculo!
//   follow → el círculo sigue a su dueño; manual → lo hace estallar el jefe
//   (al aterrizar del salto, por ejemplo); bolt → cae un rayo del cielo.
function addHazard(x, y, r, delay, dmg, color, opt = {}) {
  const h = {
    x, y, r, t: 0, delay, dmg, color, owner: opt.owner || null,
    follow: !!opt.follow, manual: !!opt.manual, bolt: !!opt.bolt, dead: false,
  };
  hazards.push(h);
  return h;
}

function updateHazards(dt) {
  for (const h of hazards) {
    if (h.dead) continue;
    if (h.owner && h.owner.dead) { h.dead = true; continue; } // si el jefe muere o huye, el ataque se cancela
    if (h.follow) { h.x = h.owner.x; h.y = h.owner.y; }
    h.t += dt;
    if (!h.manual && h.t >= h.delay) explodeHazard(h);
  }
}

function explodeHazard(h) {
  if (!h || h.dead) return;
  h.dead = true;
  const rr = h.r + P.r * 0.5;
  if (dist2(h.x, h.y, P.x, P.y) < rr * rr) hurtPlayer(h.dmg);
  if (h.bolt) {
    addBolt(h.x + rand(-80, 80), h.y - 560, h.x, h.y, h.color, 6);
    addBolt(h.x + rand(-80, 80), h.y - 560, h.x, h.y, '#ffffff', 3);
  }
  addRing(h.x, h.y, h.r * 1.15, h.color, 0.45, 7);
  addRing(h.x, h.y, h.r * 0.6, '#ffffff', 0.3, 3);
  burst(h.x, h.y, h.color, Math.min(40, 14 + Math.floor(h.r * 0.12)), 200 + h.r * 1.5, 0.6);
  G.shake = Math.max(G.shake, Math.min(16, 5 + h.r * 0.05));
  Sound.sfx.boom();
}

// ---------- Jefes ------------------------------------------------------------------
function spawnBoss(i) {
  const B = BOSSES[i];
  const a = rand(TAU), R = spawnR() * 0.85;
  const b = {
    boss: true, def: B, name: B.name, final: !!B.final, sides: B.sides, skin: 'jefe' + (i + 1),
    x: P.x + Math.cos(a) * R, y: P.y + Math.sin(a) * R, vx: 0, vy: 0, kbx: 0, kby: 0,
    r: B.r, hp: B.hp, maxHp: B.hp, dmg: B.dmg, speed: B.speed, color: B.color, xp: 0,
    angle: 0, flash: 0, dead: false, orbT: 0, elite: false, heavy: true,
    state: 'move', st: 2.5, atk: 0, count: 0, dashA: 0, shootT: 0, spiralA: 0, phase2: false,
    hz: null, jx: 0, jy: 0, jx0: 0, jy0: 0, air: 0, // ataques de zona y salto (air = altura del salto, 0..1)
    life: 120, // si no lo derrotas en 2 minutos, escapa (salvo el jefe final)
  };
  enemies.push(b);
  bossList.push(b);
  if (B.final) G.finalBoss = true;
  banner(B.name, B.final ? 'Destrúyelo para ganar' : '¡Jefe a la vista!', 'boss');
  Sound.sfx.alarm();
  buzz([100, 60, 100]);
  G.flashA = 0.35;
  G.flashC = '255,40,80';
  G.shake = Math.max(G.shake, 10);
}

function bossMove(b) { b.state = 'move'; b.st = b.phase2 ? 1.4 : 2.4; b.air = 0; }
function bossDashPrep(b, t) { b.state = 'dashPrep'; b.st = t; b.dashA = Math.atan2(P.y - b.y, P.x - b.x); }

const JUMP_T = 0.8; // duración del salto en el aire

function bossNextAttack(b) {
  const atk = b.def.attacks[b.atk++ % b.def.attacks.length];
  const fast = b.phase2 ? 1.4 : 1;
  if (atk === 'ring') { b.state = 'ring'; b.st = 0.7; b.count = b.def.ringCount; }
  else if (atk === 'dash') { b.count = b.def.dashes; bossDashPrep(b, 0.8); }
  else if (atk === 'spiral') { b.state = 'spiral'; b.st = 2.4; b.shootT = 0; b.spiralA = rand(TAU); }
  else if (atk === 'summon') { b.state = 'summon'; b.st = 0.8; }
  else if (atk === 'slam') { // pisotón: onda de choque alrededor del jefe
    b.state = 'slam'; b.st = 1.1;
    b.hz = addHazard(b.x, b.y, b.r + 150, 1.1 / fast, b.dmg * 0.9, b.color, { owner: b, follow: true, manual: true });
  } else if (atk === 'jump') { // salta hacia donde estás (como mucho 520 de distancia)
    b.state = 'jumpPrep'; b.st = 0.6;
    const dx = P.x - b.x, dy = P.y - b.y, k = Math.min(1, 520 / (Math.hypot(dx, dy) || 1));
    b.jx = b.x + dx * k; b.jy = b.y + dy * k;
    b.hz = addHazard(b.jx, b.jy, b.r + 95, (0.6 + JUMP_T) / fast, b.dmg, b.color, { owner: b, manual: true });
  } else if (atk === 'storm') { // rayos: uno justo donde estás y los demás alrededor
    b.state = 'storm'; b.st = 1.4;
    const n = b.phase2 ? 7 : 5;
    for (let k = 0; k < n; k++) {
      const a = rand(TAU), d = k === 0 ? 0 : rand(80, 270);
      addHazard(P.x + Math.cos(a) * d, P.y + Math.sin(a) * d, 80, 1.1 + k * 0.15, b.dmg * 0.7, b.color, { owner: b, bolt: true });
    }
    Sound.sfx.zap();
  }
}

function updateBoss(b, dt) {
  const dx = P.x - b.x, dy = P.y - b.y, d = Math.hypot(dx, dy) || 1;
  if (b.flash > 0) b.flash -= dt;
  // El jefe final se enfurece a mitad de vida
  if (b.final && !b.phase2 && b.hp < b.maxHp * 0.5) {
    b.phase2 = true;
    banner('¡FASE FINAL!', 'El núcleo se desestabiliza', 'boss');
    addRing(b.x, b.y, 420, b.color, 0.8, 8);
    G.shake = 20;
    Sound.sfx.alarm();
    for (let k = 0; k < 18; k++) enemyShot(b.x, b.y, (k / 18) * TAU, 200, b.dmg * 0.6, b.color);
  }
  b.life -= dt;
  if (!b.final && b.life <= 0 && b.state === 'move') {
    b.dead = true;
    burst(b.x, b.y, b.color, 50, 400, 0.8);
    addRing(b.x, b.y, 220, b.color, 0.6, 6);
    banner('EL JEFE HA ESCAPADO', 'Sin cofre esta vez', 'boss');
    return;
  }
  const fast = b.phase2 ? 1.4 : 1;
  b.st -= dt * fast;
  b.angle += dt * (b.state === 'spiral' ? 2.6 : 0.7) * fast;

  switch (b.state) {
    case 'move': {
      const chase = d > 380 ? 2.4 : 1; // acelera si te alejas mucho
      b.vx = (dx / d) * b.speed * fast * chase;
      b.vy = (dy / d) * b.speed * fast * chase;
      if (b.st <= 0) bossNextAttack(b);
      break;
    }
    case 'ring':
      b.vx *= 0.9; b.vy *= 0.9;
      if (b.st <= 0) {
        const n = b.def.ringN + (b.phase2 ? 4 : 0), off = rand(TAU);
        for (let k = 0; k < n; k++) enemyShot(b.x, b.y, off + (k / n) * TAU, 190, b.dmg * 0.6, b.color);
        addRing(b.x, b.y, b.r * 2.2, b.color, 0.3, 4);
        Sound.sfx.eshoot();
        if (--b.count > 0) b.st = 0.5; else bossMove(b);
      }
      break;
    case 'dashPrep':
      b.vx = 0; b.vy = 0;
      if (b.st <= 0) {
        b.state = 'dash';
        b.st = 0.55;
        b.vx = Math.cos(b.dashA) * 760;
        b.vy = Math.sin(b.dashA) * 760;
        G.shake = Math.max(G.shake, 6);
        Sound.sfx.dash();
      }
      break;
    case 'dash':
      addParticle(b.x + rand(-b.r, b.r) * 0.6, b.y + rand(-b.r, b.r) * 0.6, -b.vx * 0.1, -b.vy * 0.1, 0.5, rand(3, 6), b.color, 0, 3);
      if (b.st <= 0) {
        b.vx *= 0.2; b.vy *= 0.2;
        if (--b.count > 0) bossDashPrep(b, 0.45); else bossMove(b);
      }
      break;
    case 'spiral':
      b.vx *= 0.92; b.vy *= 0.92;
      b.shootT -= dt * fast;
      if (b.shootT <= 0) {
        b.shootT = 0.16;
        const arms = b.def.arms + (b.phase2 ? 1 : 0);
        for (let k = 0; k < arms; k++) enemyShot(b.x, b.y, b.spiralA + (k / arms) * TAU, 170, b.dmg * 0.5, b.color);
        b.spiralA += 0.23;
        Sound.sfx.eshoot();
      }
      if (b.st <= 0) bossMove(b);
      break;
    case 'slam':
      b.vx *= 0.85; b.vy *= 0.85;
      if (b.st <= 0) {
        explodeHazard(b.hz);
        addRing(b.x, b.y, (b.r + 150) * 1.5, '#ffffff', 0.5, 4);
        bossMove(b);
      }
      break;
    case 'jumpPrep': // se agacha y tiembla antes de saltar
      b.vx = 0; b.vy = 0;
      if (b.st <= 0) { b.state = 'jump'; b.st = JUMP_T; b.jx0 = b.x; b.jy0 = b.y; Sound.sfx.dash(); }
      break;
    case 'jump': {
      const k = 1 - clamp(b.st / JUMP_T, 0, 1), e = k * k * (3 - 2 * k);
      b.x = b.jx0 + (b.jx - b.jx0) * e;
      b.y = b.jy0 + (b.jy - b.jy0) * e;
      b.vx = 0; b.vy = 0;
      b.air = Math.sin(Math.PI * k);
      if (b.st <= 0) { // aterriza aplastando
        b.x = b.jx; b.y = b.jy;
        explodeHazard(b.hz);
        burst(b.x, b.y, '#ffffff', 20, 420, 0.5);
        G.shake = Math.max(G.shake, 18);
        buzz(60);
        bossMove(b);
      }
      break;
    }
    case 'storm':
      b.vx *= 0.9; b.vy *= 0.9;
      if (b.st <= 0) bossMove(b);
      break;
    case 'summon':
      b.vx *= 0.9; b.vy *= 0.9;
      if (b.st <= 0) {
        const n = 8 + (b.phase2 ? 4 : 0);
        for (let k = 0; k < n; k++) {
          const a = (k / n) * TAU;
          const m = spawnEnemy(pick(['zangano', 'veloz']), b.x + Math.cos(a) * (b.r + 20), b.y + Math.sin(a) * (b.r + 20));
          m.kbx = Math.cos(a) * 300;
          m.kby = Math.sin(a) * 300;
        }
        burst(b.x, b.y, b.color, 30, 300);
        addRing(b.x, b.y, b.r * 3, b.color, 0.5, 5);
        bossMove(b);
      }
      break;
  }
  b.x += b.vx * dt;
  b.y += b.vy * dt;
  if (d < b.r + P.r - 6 && b.state !== 'jump') hurtPlayer(b.dmg); // en el aire no te toca
  // Si te alejas demasiado, el jefe te alcanza
  if (b.state === 'move' && d > spawnR() * 1.5) {
    const a = Math.atan2(b.y - P.y, b.x - P.x), R = spawnR() * 0.9;
    b.x = P.x + Math.cos(a) * R;
    b.y = P.y + Math.sin(a) * R;
  }
}

function bossDeath(b) {
  G.slow = 1.2;
  G.shake = 30;
  G.flashA = 0.7;
  G.flashC = '255,255,255';
  for (let i = 0; i < 4; i++) {
    after(i * 0.12, () => {
      burst(b.x + rand(-40, 40), b.y + rand(-40, 40), pick([b.color, '#ffffff', '#ffd84d']), 60, 520, 0.9);
      addRing(b.x, b.y, 140 + i * 90, i % 2 ? '#ffffff' : b.color, 0.6, 6);
    });
  }
  Sound.sfx.bossDie();
  buzz(250);
  if (b.final) { victory(b); return; }
  dropPickup(b.x, b.y, 'chest');
  for (let i = 0; i < 24; i++) {
    const a = rand(TAU), d = rand(30, 130);
    dropGem(b.x + Math.cos(a) * d, b.y + Math.sin(a) * d, 6 + G.time / 60);
  }
  banner('¡JEFE DERROTADO!', 'Recoge el cofre', 'gold');
}

function victory(b) {
  G.won = true;
  G.endT = 4.5;
  P.invul = 999;
  for (const eb of ebullets) eb.dead = true;
  for (const h of hazards) h.dead = true;
  // Todos los enemigos estallan en cadena desde el núcleo
  for (const e of enemies) {
    if (e.dead || e === b) continue;
    const d = Math.hypot(e.x - b.x, e.y - b.y);
    after(0.3 + d / 900, () => { e.split = 0; e.xp = 0; killEnemy(e); });
  }
  banner('¡VICTORIA!', 'El Núcleo del Vacío ha caído', 'gold');
  Sound.sfx.win();
}

// ---------- Cristales y objetos ---------------------------------------------------
function updateGems(dt) {
  const m2 = P.magnet * P.magnet;
  const pr = P.r + 6;
  for (const g of gems) {
    if (g.dead) continue;
    g.t += dt;
    const dx = P.x - g.x, dy = P.y - g.y, dd = dx * dx + dy * dy;
    if (!g.mag) {
      if (g.vx || g.vy) {
        g.x += g.vx * dt; g.y += g.vy * dt;
        const f = Math.exp(-6 * dt);
        g.vx *= f; g.vy *= f;
      }
      if (dd < m2) { g.mag = true; g.spd = -160; } // pequeño rebote antes de volar hacia ti
    } else {
      g.spd = Math.min(g.spd + 2000 * dt, 1100);
      const d = Math.sqrt(dd) || 1, step = g.spd * dt;
      if (d < pr + Math.max(0, step)) { collectGem(g); continue; }
      g.x += (dx / d) * step;
      g.y += (dy / d) * step;
    }
  }
}

function collectGem(g) {
  g.dead = true;
  addXp(g.v);
  G.combo = G.time - G.gemT < 0.35 ? G.combo + 1 : 0;
  G.gemT = G.time;
  Sound.sfx.gem(G.combo);
  addParticle(P.x, P.y, rand(-40, 40), rand(-40, 40), 0.25, 3, GEM_TIERS[g.tier].color, 0);
}

function updatePickups(dt) {
  for (const p of pickups) {
    if (p.dead) continue;
    p.t += dt;
    const dd = dist2(p.x, p.y, P.x, P.y);
    if (p.kind !== 'chest' && dd < 70 * 70) { // se acercan solos cuando estás muy cerca
      const d = Math.sqrt(dd) || 1;
      p.x += ((P.x - p.x) / d) * 300 * dt;
      p.y += ((P.y - p.y) / d) * 300 * dt;
    }
    if (dd < (P.r + 18) ** 2) { p.dead = true; collectPickup(p); }
  }
}

function collectPickup(p) {
  switch (p.kind) {
    case 'heart':
      healPlayer(30);
      Sound.sfx.pickup();
      burst(P.x, P.y, '#ff5ea8', 14, 200);
      break;
    case 'magnet':
      for (const g of gems) { g.mag = true; g.spd = 0; }
      Sound.sfx.pickup();
      addRing(P.x, P.y, 320, '#4db8ff', 0.5, 4);
      break;
    case 'bomb':
      G.flashA = 0.8;
      G.flashC = '255,255,255';
      G.shake = 25;
      addRing(P.x, P.y, 900, '#ffffff', 0.6, 10);
      Sound.sfx.boom();
      buzz(120);
      for (const e of enemiesInView()) {
        if (e.boss) damageEnemy(e, e.maxHp * 0.04, 'bomba');
        else killEnemy(e);
      }
      break;
    case 'chest':
      openChest();
      break;
  }
}

// ---------- Actualización general --------------------------------------------------
function compact(arr) {
  let j = 0;
  for (let i = 0; i < arr.length; i++) { const o = arr[i]; if (!o.dead) arr[j++] = o; }
  arr.length = j;
}

function tickLife(arr, dt) {
  let j = 0;
  for (let i = 0; i < arr.length; i++) { const o = arr[i]; o.life -= dt; if (o.life > 0) arr[j++] = o; }
  arr.length = j;
}

function updateFx(dt) {
  let j = 0;
  for (let i = 0; i < particles.length; i++) {
    const p = particles[i];
    p.life -= dt;
    if (p.life <= 0) continue;
    const f = Math.exp(-p.drag * dt);
    p.vx *= f; p.vy *= f;
    p.x += p.vx * dt; p.y += p.vy * dt;
    particles[j++] = p;
  }
  particles.length = j;
  if (pCursor >= j) pCursor = 0;
  tickLife(rings, dt);
  tickLife(bolts, dt);
  for (const t of texts) { t.y += t.vy * dt; t.vy *= Math.exp(-3 * dt); }
  tickLife(texts, dt);
}

function update(dt) {
  G.time += dt;
  updateDifficulty();
  if (!G.won) { updateEvents(); updateSpawner(dt); }
  updateTimers(dt);
  updatePlayer(dt);
  gridBuild();
  updateEnemies(dt);
  updateWeapons(dt);
  updateProjectiles(dt);
  updateEnemyBullets(dt);
  updateHazards(dt);
  updateWaves(dt);
  updateStrikes(dt);
  updateGems(dt);
  updatePickups(dt);
  updateFx(dt);
  compact(enemies); compact(bossList); compact(projectiles); compact(ebullets); compact(hazards);
  compact(gems); compact(pickups); compact(waves); compact(strikes);

  Sound.setIntensity(bossList.length ? 3 : G.time < 30 ? 0 : G.time < 150 ? 1 : 2);
  updateHud();

  if (G.won) {
    G.endT -= dt;
    if (G.endT <= 0 && state === 'playing') showGameOver(true);
  } else if (G.pending > 0 && state === 'playing') {
    openLevelUp();
  }
}

// =============================================================================
// 8. DIBUJADO
// =============================================================================
const worldT = () => ctx.setTransform(VIEW, 0, 0, VIEW, OX, OY);
function rotT(x, y, a, s = 1) {
  const c = Math.cos(a) * VIEW * s, n = Math.sin(a) * VIEW * s;
  ctx.setTransform(c, n, -n, c, OX + x * VIEW, OY + y * VIEW);
}
const drawImg = (img, x, y, r) => ctx.drawImage(img, x - r, y - r, r * 2, r * 2);
const inView = (x, y, m) => x > viewL - m && x < viewR + m && y > viewT - m && y < viewB + m;

function drawTiled(img, scale, offX, offY) {
  const tw = img.width * scale, th = img.height * scale;
  const ox = -(((offX % tw) + tw) % tw), oy = -(((offY % th) + th) % th);
  for (let x = ox; x < W; x += tw) for (let y = oy; y < H; y += th) ctx.drawImage(img, x, y, tw, th);
}

function drawBackdrop(cx, cy) {
  drawTiled(nebula, 1.7 * DPR, cx * VIEW * 0.05, cy * VIEW * 0.05);
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = 0.55;
  drawTiled(stars1, DPR, cx * VIEW * 0.12, cy * VIEW * 0.12);
  ctx.globalAlpha = 0.9;
  drawTiled(stars2, DPR, cx * VIEW * 0.3, cy * VIEW * 0.3);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}

// Cuadrícula de neón que brilla alrededor del jugador y late con la música
function drawGrid(fx, fy) {
  const x0 = Math.floor(viewL / GRID) * GRID, y0 = Math.floor(viewT / GRID) * GRID;
  const grd = ctx.createRadialGradient(fx, fy, 0, fx, fy, 700);
  grd.addColorStop(0, `rgba(150,100,255,${0.3 + beat * 0.14})`);
  grd.addColorStop(0.5, 'rgba(110,60,230,0.12)');
  grd.addColorStop(1, 'rgba(80,40,200,0.04)');
  ctx.strokeStyle = grd;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  for (let x = x0; x <= viewR; x += GRID) { ctx.moveTo(x, viewT); ctx.lineTo(x, viewB); }
  for (let y = y0; y <= viewB; y += GRID) { ctx.moveTo(viewL, y); ctx.lineTo(viewR, y); }
  ctx.stroke();
}

function drawWaves() {
  ctx.globalCompositeOperation = 'lighter';
  for (const w of waves) {
    const k = w.r / w.max, a = 1 - k;
    ctx.fillStyle = rgba(w.color, a * 0.06);
    ctx.beginPath(); ctx.arc(w.x, w.y, w.r, 0, TAU); ctx.fill();
    ctx.strokeStyle = rgba(w.color, a * 0.45);
    ctx.lineWidth = 14 * a + 2;
    ctx.stroke();
    ctx.strokeStyle = `rgba(255,255,255,${a * 0.8})`;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  ctx.globalCompositeOperation = 'source-over';
}

function drawStrikeMarks() {
  for (const s of strikes) {
    if (s.t < 0) continue;
    const p = s.t / s.dur;
    ctx.strokeStyle = rgba(s.color, 0.25 + p * 0.5);
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 6]);
    ctx.lineDashOffset = -G.time * 40;
    ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, TAU); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = rgba(s.color, 0.08 + p * 0.12);
    ctx.beginPath(); ctx.arc(s.x, s.y, s.r * (1 - p), 0, TAU); ctx.fill();
  }
}

function drawGems() {
  for (const g of gems) {
    if (!inView(g.x, g.y, 20)) continue;
    const s = gemSprite(g.tier);
    const bob = Math.sin(g.t * 4) * 1.5;
    ctx.drawImage(s.c, g.x - s.half, g.y - s.half + bob, s.half * 2, s.half * 2);
  }
}

function drawPickups() {
  for (const p of pickups) {
    if (!inView(p.x, p.y, 60)) continue;
    const bob = Math.sin(p.t * 3) * 3;
    if (p.kind === 'chest') { // rayos de luz giratorios detrás del cofre
      ctx.globalCompositeOperation = 'lighter';
      rotT(p.x, p.y, p.t * 0.8);
      ctx.fillStyle = 'rgba(255,216,77,0.12)';
      for (let i = 0; i < 8; i++) {
        ctx.rotate(TAU / 8);
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(70, -9); ctx.lineTo(70, 9); ctx.closePath(); ctx.fill();
      }
      worldT();
      drawImg(halo('#ffd84d'), p.x, p.y, 60);
      ctx.globalCompositeOperation = 'source-over';
    } else {
      ctx.globalCompositeOperation = 'lighter';
      drawImg(halo(p.kind === 'heart' ? '#ff5ea8' : p.kind === 'magnet' ? '#4db8ff' : '#ff4d4d'), p.x, p.y + bob, 32);
      ctx.globalCompositeOperation = 'source-over';
    }
    const s = pickupSprite(p.kind);
    ctx.drawImage(s.c, p.x - s.half, p.y - s.half + bob, s.half * 2, s.half * 2);
    if (p.kind === 'bomb' && Math.sin(p.t * 20) > 0) {
      ctx.globalCompositeOperation = 'lighter';
      drawImg(glow('#ffd84d'), p.x + 11, p.y - 11 + bob, 7);
      ctx.globalCompositeOperation = 'source-over';
    }
  }
}

// Avisos de los ataques de zona: el círculo se va llenando y parpadea justo antes del golpe
function drawHazards() {
  worldT();
  for (const h of hazards) {
    if (h.dead || !inView(h.x, h.y, h.r)) continue;
    const p = clamp(h.t / h.delay, 0, 1);
    const blink = p > 0.75 ? 0.6 + 0.4 * Math.sin(G.time * 40) : 1;
    ctx.fillStyle = rgba(h.color, (0.07 + p * 0.1) * blink);
    ctx.beginPath(); ctx.arc(h.x, h.y, h.r, 0, TAU); ctx.fill();
    ctx.fillStyle = rgba(h.color, 0.16 + p * 0.2);
    ctx.beginPath(); ctx.arc(h.x, h.y, h.r * p, 0, TAU); ctx.fill();
    // Borde sólido y brillante (los círculos de tus meteoritos son discontinuos)
    ctx.shadowColor = h.color;
    ctx.shadowBlur = 12 * VIEW;
    ctx.strokeStyle = rgba(h.color, 0.7 + p * 0.3);
    ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(h.x, h.y, h.r, 0, TAU); ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = `rgba(255,255,255,${0.25 + p * 0.5})`;
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(h.x, h.y, h.r * p, 0, TAU); ctx.stroke();
    // Señal de peligro en el centro
    const s = 15 * (0.9 + 0.1 * blink);
    ctx.fillStyle = rgba(h.color, 0.9);
    ctx.beginPath();
    ctx.moveTo(h.x, h.y - s); ctx.lineTo(h.x + s, h.y + s * 0.75); ctx.lineTo(h.x - s, h.y + s * 0.75);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(h.x - 1.6, h.y - s * 0.45, 3.2, s * 0.62);
    ctx.fillRect(h.x - 1.6, h.y + s * 0.3, 3.2, 3.2);
  }
}

function drawEnemies() {
  // Franja de aviso de los centinelas que van a embestir
  worldT();
  ctx.lineCap = 'round';
  for (const e of enemies) {
    if (e.mode !== 1 || e.dead || !inView(e.x, e.y, 300)) continue;
    const L = e.speed * CHARGE_K * CHARGE_T, pulse = 0.5 + 0.5 * Math.sin(G.time * 30);
    const ex = e.x + Math.cos(e.ca) * L, ey = e.y + Math.sin(e.ca) * L;
    ctx.strokeStyle = rgba(e.color, 0.25 + 0.3 * pulse);
    ctx.lineWidth = e.r * 1.6;
    ctx.beginPath(); ctx.moveTo(e.x, e.y); ctx.lineTo(ex, ey); ctx.stroke();
    ctx.strokeStyle = `rgba(255,255,255,${0.35 + 0.45 * pulse})`;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(e.x, e.y); ctx.lineTo(ex, ey); ctx.stroke();
  }
  ctx.lineCap = 'butt';

  for (const e of enemies) {
    if (e.dead || !inView(e.x, e.y, e.r + 120)) continue;
    if (e.boss) { drawBoss(e); continue; }
    const s = e.flash > 0 ? e.sprF : e.spr;
    if (skinImg[e.type]) { // con imagen: derecho, con un balanceo como si caminara
      const w = G.time * 9 + e.phase;
      rotT(e.x, e.y - Math.abs(Math.sin(w)) * 2.5, Math.sin(w) * 0.1);
    } else {
      rotT(e.x, e.y, e.angle);
    }
    ctx.drawImage(s.c, -s.half, -s.half, s.half * 2, s.half * 2);
  }
  worldT();
  // Barras de vida de los enemigos de élite
  for (const e of enemies) {
    if (!e.elite || e.dead || e.hp >= e.maxHp || !inView(e.x, e.y, 40)) continue;
    const w = 36;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(e.x - w / 2 - 1, e.y - e.r - 15, w + 2, 6);
    ctx.fillStyle = '#ffd84d';
    ctx.fillRect(e.x - w / 2, e.y - e.r - 14, w * (e.hp / e.maxHp), 4);
  }
}

function polyPath(n, r) {
  ctx.beginPath();
  for (let i = 0; i < n; i++) { const a = (i / n) * TAU; ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r); }
  ctx.closePath();
}

function drawBoss(b) {
  if (!b.air) { drawBossBody(b); return; }
  // Saltando: su sombra se queda en el suelo y el jefe se dibuja más arriba
  worldT();
  const k = 1 - b.air * 0.35;
  ctx.fillStyle = `rgba(0,0,0,${0.5 - b.air * 0.2})`;
  ctx.beginPath(); ctx.ellipse(b.x, b.y + b.r * 0.3, b.r * k, b.r * 0.45 * k, 0, 0, TAU); ctx.fill();
  const y = b.y;
  b.y -= b.air * 120;
  drawBossBody(b);
  b.y = y;
}

function drawBossBody(b) {
  const t = G.time;
  const tele = b.state === 'ring' || b.state === 'summon' || b.state === 'dashPrep' ||
    b.state === 'slam' || b.state === 'jumpPrep' || b.state === 'storm';
  const pulse = tele ? 0.5 + 0.5 * Math.sin(t * 28) : 0;
  const col = b.color;
  worldT();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = 0.55 + pulse * 0.45;
  drawImg(halo(col), b.x, b.y, b.r * (3.2 + pulse * 0.8));
  ctx.globalAlpha = 1;
  if (b.state === 'dashPrep') { // aviso de embestida
    const L = 430;
    ctx.strokeStyle = rgba(col, 0.12 + pulse * 0.25);
    ctx.lineWidth = b.r * 1.6;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(b.x + Math.cos(b.dashA) * L, b.y + Math.sin(b.dashA) * L);
    ctx.stroke();
    ctx.lineCap = 'butt';
  }
  ctx.globalCompositeOperation = 'source-over';

  if (b.final) { // anillo exterior con fragmentos orbitando
    rotT(b.x, b.y, -t * 0.6);
    ctx.strokeStyle = rgba(col, 0.7);
    ctx.lineWidth = 2;
    ctx.setLineDash([10, 14]);
    ctx.beginPath(); ctx.arc(0, 0, b.r * 1.45, 0, TAU); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = b.phase2 ? '#ffffff' : col;
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * TAU;
      ctx.beginPath(); ctx.arc(Math.cos(a) * b.r * 1.45, Math.sin(a) * b.r * 1.45, 5, 0, TAU); ctx.fill();
    }
  }

  if (skinImg[b.skin]) { // jefe con imagen personalizada
    const s = skinSprite(b.skin, col, b.r, b.flash > 0, false);
    const R = s.half - 10; // un poco por fuera de la imagen
    rotT(b.x, b.y, b.angle);
    ctx.shadowColor = col;
    ctx.shadowBlur = 18 * VIEW;
    ctx.strokeStyle = b.flash > 0 ? '#ffffff' : col;
    ctx.lineWidth = 3;
    ctx.setLineDash([18, 10]);
    ctx.beginPath(); ctx.arc(0, 0, R, 0, TAU); ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineWidth = 4;
    for (let i = 0; i < b.sides; i++) { // púas girando alrededor
      const a = (i / b.sides) * TAU, c = Math.cos(a), sn = Math.sin(a);
      ctx.beginPath(); ctx.moveTo(c * R, sn * R); ctx.lineTo(c * (R + 14), sn * (R + 14)); ctx.stroke();
    }
    ctx.shadowBlur = 0;
    rotT(b.x, b.y, Math.sin(t * 2) * 0.06, 1 + pulse * 0.06);
    ctx.drawImage(s.c, -s.half, -s.half, s.half * 2, s.half * 2);
    worldT();
    return;
  }

  rotT(b.x, b.y, b.angle);
  ctx.shadowColor = col;
  ctx.shadowBlur = 24 * VIEW;
  ctx.lineJoin = 'round';
  polyPath(b.sides, b.r);
  ctx.fillStyle = b.flash > 0 ? 'rgba(255,255,255,0.9)' : rgba(col, 0.2);
  ctx.fill();
  ctx.strokeStyle = b.flash > 0 ? '#ffffff' : col;
  ctx.lineWidth = 4;
  ctx.stroke();
  for (let i = 0; i < b.sides; i++) { // púas
    const a = (i / b.sides) * TAU, c = Math.cos(a), s = Math.sin(a);
    ctx.beginPath(); ctx.moveTo(c * b.r, s * b.r); ctx.lineTo(c * (b.r + 14), s * (b.r + 14)); ctx.stroke();
  }
  rotT(b.x, b.y, -b.angle * 1.8);
  polyPath(b.sides, b.r * 0.6);
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 2.5;
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Núcleo con un "ojo" que te sigue
  worldT();
  ctx.globalCompositeOperation = 'lighter';
  drawImg(glow(col), b.x, b.y, b.r * 0.75 * (1 + pulse * 0.3));
  ctx.globalCompositeOperation = 'source-over';
  const ea = Math.atan2(P.y - b.y, P.x - b.x);
  ctx.fillStyle = '#0a0410';
  ctx.beginPath();
  ctx.arc(b.x + Math.cos(ea) * b.r * 0.14, b.y + Math.sin(ea) * b.r * 0.14, b.r * 0.12, 0, TAU);
  ctx.fill();
}

// Todo lo que brilla se dibuja con mezcla aditiva ('lighter')
function drawLights() {
  ctx.globalCompositeOperation = 'lighter';

  for (const b of projectiles) {
    if (b.dead || !inView(b.x, b.y, 40)) continue;
    if (b.kind === 0) {
      rotT(b.x, b.y, b.a);
      const L = b.r * 4.5, h = b.r * 1.7;
      ctx.drawImage(streak(b.color), -L * 1.3, -h, L * 2, h * 2);
      worldT();
      drawImg(glow(b.color), b.x, b.y, b.r * 2.2);
    } else {
      worldT();
      drawImg(halo(b.color), b.x, b.y, b.r * 2.6);
      rotT(b.x, b.y, b.spin, b.r / 13);
      const s = discSprite(b.color);
      ctx.drawImage(s.c, -s.half, -s.half, s.half * 2, s.half * 2);
    }
  }

  worldT();
  const pulse = 1 + Math.sin(G.time * 20) * 0.15;
  for (const b of ebullets) {
    if (b.dead || !inView(b.x, b.y, 20)) continue;
    drawImg(glow(b.color), b.x, b.y, b.r * 2.6 * pulse);
  }

  for (const w of P.weapons) {
    if (w.id === 'orbes' && w.orbs) {
      for (const o of w.orbs) {
        for (let k = 1; k <= 5; k++) { // estela del orbe
          const a = o.a - o.dir * k * 0.12;
          ctx.globalAlpha = 0.5 - k * 0.08;
          drawImg(glow(o.color), P.x + Math.cos(a) * o.R, P.y + Math.sin(a) * o.R, w.orbR * (1.8 - k * 0.2));
        }
        ctx.globalAlpha = 1;
        drawImg(halo(o.color), o.x, o.y, w.orbR * 4);
        drawImg(glow(o.color), o.x, o.y, w.orbR * 2.2);
      }
    }
    if (w.id === 'dron' && w.drones) {
      for (const d of w.drones) {
        drawImg(halo('#a6ff4d'), d.x, d.y, 24);
        rotT(d.x, d.y, d.aim);
        const s = droneSprite();
        ctx.drawImage(s.c, -s.half, -s.half, s.half * 2, s.half * 2);
        if (d.flash > 0) drawImg(glow('#e6ffb0'), 13, 0, 9);
        worldT();
      }
    }
  }

  ctx.lineJoin = 'round';
  for (const b of bolts) {
    const a = b.life / b.maxLife;
    ctx.beginPath();
    ctx.moveTo(b.pts[0], b.pts[1]);
    for (let i = 2; i < b.pts.length; i += 2) ctx.lineTo(b.pts[i], b.pts[i + 1]);
    ctx.strokeStyle = rgba(b.color, 0.35 * a);
    ctx.lineWidth = b.w * 4;
    ctx.stroke();
    ctx.strokeStyle = `rgba(255,255,255,${a})`;
    ctx.lineWidth = b.w;
    ctx.stroke();
    const n = b.pts.length;
    drawImg(glow(b.color), b.pts[n - 2], b.pts[n - 1], 22 * a);
  }

  for (const s of strikes) { // meteoritos cayendo
    if (s.t < 0) continue;
    const p = s.t / s.dur, e = 1 - p * p;
    const mx = s.x + 300 * e, my = s.y - 520 * e;
    rotT(mx, my, Math.atan2(520, -300));
    ctx.drawImage(streak(s.color), -100, -14, 110, 28);
    worldT();
    drawImg(halo(s.color), mx, my, 46);
    drawImg(glow('#ffe9a8'), mx, my, 14);
  }

  for (const p of particles) {
    if (!inView(p.x, p.y, 20)) continue;
    const a = p.life / p.max;
    ctx.globalAlpha = a;
    const sp = p.kind === 1 ? Math.hypot(p.vx, p.vy) : 0;
    if (sp > 5) {
      const len = clamp(sp * 0.05, 4, 26);
      const c = (p.vx / sp) * VIEW, s = (p.vy / sp) * VIEW;
      ctx.setTransform(c, s, -s, c, OX + p.x * VIEW, OY + p.y * VIEW);
      ctx.drawImage(streak(p.color), -len, -p.size, len * 2, p.size * 2);
    } else {
      worldT();
      drawImg(glow(p.color), p.x, p.y, p.size * (0.5 + a * 0.8) * 2);
    }
  }
  ctx.globalAlpha = 1;

  worldT();
  for (const r of rings) {
    const k = 1 - r.life / r.maxLife;
    const rad = r.max * (1 - (1 - k) * (1 - k));
    ctx.strokeStyle = rgba(r.color, 1 - k);
    ctx.lineWidth = r.w * (1 - k) + 0.5;
    ctx.beginPath(); ctx.arc(r.x, r.y, rad, 0, TAU); ctx.stroke();
  }
  ctx.globalCompositeOperation = 'source-over';
}

function drawPlayer() {
  worldT();
  ctx.globalCompositeOperation = 'lighter';
  for (const t of P.trail) {
    if (t.life <= 0) continue;
    const a = t.life / 0.35;
    ctx.globalAlpha = a * 0.5;
    drawImg(glow('#4df3ff'), t.x, t.y, 10 * a + 4);
  }
  // radio del imán
  ctx.globalAlpha = 0.07 + beat * 0.05;
  ctx.strokeStyle = '#4df3ff';
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(P.x, P.y, P.magnet, 0, TAU); ctx.stroke();
  ctx.globalAlpha = 1;

  const blink = P.invul > 0 && state === 'playing' && Math.floor(G.time * 24) % 2 === 0;
  if (!blink && state !== 'ending' && state !== 'over') {
    drawImg(halo(P.hurtT > 0 ? '#ff3366' : '#4df3ff'), P.x, P.y, 48 + beat * 6);
    drawImg(glow('#9ffcff'), P.x, P.y, 20);
    ctx.globalCompositeOperation = 'source-over';
    // tres triángulos girando alrededor del núcleo
    const skin = skinImg.jugador ? skinSprite('jugador', '#4df3ff', P.r, false, false) : null;
    const orbitR = skin ? skin.half - 8 : 17;
    ctx.fillStyle = '#bffcff';
    const a0 = G.time * 2.4;
    for (let k = 0; k < 3; k++) {
      const a = a0 + (k / 3) * TAU;
      rotT(P.x + Math.cos(a) * orbitR, P.y + Math.sin(a) * orbitR, a + Math.PI / 2);
      ctx.beginPath(); ctx.moveTo(0, -4); ctx.lineTo(3.5, 3); ctx.lineTo(-3.5, 3); ctx.closePath(); ctx.fill();
    }
    if (skin) { // jugador con imagen personalizada
      rotT(P.x, P.y, Math.sin(G.time * 10) * Math.min(1, Math.hypot(P.vx, P.vy) / 200) * 0.1);
      ctx.drawImage(skin.c, -skin.half, -skin.half, skin.half * 2, skin.half * 2);
    } else {
      worldT();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.arc(P.x, P.y, 6.5, 0, TAU); ctx.fill();
    }
    // indicador de dirección
    rotT(P.x, P.y, P.facing);
    ctx.strokeStyle = '#4df3ff';
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    const dr = orbitR + 5;
    ctx.beginPath(); ctx.moveTo(dr, -6); ctx.lineTo(dr + 6, 0); ctx.lineTo(dr, 6); ctx.stroke();
    ctx.lineCap = 'butt';
    worldT();
  }
  ctx.globalCompositeOperation = 'source-over';

  // barra de vida bajo el jugador
  if (state !== 'over' && state !== 'ending') {
    const bw = 40, bh = 4.5, bx = P.x - bw / 2, by = P.y + 26;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(bx - 1, by - 1, bw + 2, bh + 2);
    ctx.fillStyle = P.hp / P.maxHp < 0.3 ? '#ff3355' : '#ff4fa0';
    ctx.fillRect(bx, by, bw * clamp(P.hp / P.maxHp, 0, 1), bh);
  }
}

function drawTexts() {
  worldT();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  for (const t of texts) {
    if (!inView(t.x, t.y, 40)) continue;
    const k = t.life / t.max;
    const pop = 1 + Math.max(0, (k - 0.8) / 0.2) * 0.5;
    ctx.globalAlpha = Math.min(1, k * 2.5);
    ctx.font = `700 ${Math.round(t.size * pop)}px Rajdhani, "Segoe UI", sans-serif`;
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(10,0,20,0.75)';
    ctx.strokeText(t.txt, t.x, t.y);
    ctx.fillStyle = t.color;
    ctx.fillText(t.txt, t.x, t.y);
  }
  ctx.globalAlpha = 1;
}

// Flechas en el borde de la pantalla que señalan cofres y jefes fuera de vista
function drawIndicators() {
  const targets = [];
  for (const p of pickups) if (p.kind === 'chest' && !p.dead) targets.push([p.x, p.y, '#ffd84d']);
  for (const b of bossList) if (!b.dead) targets.push([b.x, b.y, b.color]);
  // Márgenes para no tapar el HUD (arriba hay más cosas en el móvil)
  const ml = 40 * DPR, mt = (IS_TOUCH ? 135 : 75) * DPR, mb = 60 * DPR;
  const cx0 = W / 2, cy0 = (mt + H - mb) / 2, hw = W / 2 - ml, hh = Math.max(20, (H - mb - mt) / 2);
  for (const [x, y, col] of targets) {
    const sx = OX + x * VIEW, sy = OY + y * VIEW;
    if (sx > 0 && sx < W && sy > 0 && sy < H) continue;
    const a = Math.atan2(sy - cy0, sx - cx0), c = Math.cos(a), s = Math.sin(a);
    const k = Math.min(Math.abs(c) > 1e-6 ? hw / Math.abs(c) : Infinity, Math.abs(s) > 1e-6 ? hh / Math.abs(s) : Infinity);
    const sc = DPR * (IS_TOUCH ? 1.2 : 1) * (1 + Math.sin(performance.now() / 150) * 0.12);
    ctx.setTransform(c * sc, s * sc, -s * sc, c * sc, cx0 + c * k, cy0 + s * k);
    ctx.shadowColor = col;
    ctx.shadowBlur = 12 * DPR;
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.moveTo(16, 0); ctx.lineTo(-8, 11); ctx.lineTo(-3, 0); ctx.lineTo(-8, -11); ctx.closePath(); ctx.fill();
    ctx.shadowBlur = 0;
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

// Joystick táctil: base translúcida + pomo brillante que sigue al dedo
function drawJoystick() {
  if (!touch.active || state !== 'playing') return;
  const R = STICK_R * DPR, ox = touch.ox * DPR, oy = touch.oy * DPR;
  let dx = (touch.x - touch.ox) * DPR, dy = (touch.y - touch.oy) * DPR;
  const l = Math.hypot(dx, dy);
  if (l > R) { dx = (dx / l) * R; dy = (dy / l) * R; }
  const kx = ox + dx, ky = oy + dy;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  // base
  ctx.fillStyle = 'rgba(8,5,25,0.35)';
  ctx.beginPath(); ctx.arc(ox, oy, R, 0, TAU); ctx.fill();
  ctx.strokeStyle = 'rgba(77,243,255,0.55)';
  ctx.lineWidth = 2 * DPR;
  ctx.stroke();
  ctx.strokeStyle = 'rgba(77,243,255,0.18)';
  ctx.beginPath(); ctx.arc(ox, oy, R * 0.55, 0, TAU); ctx.stroke();
  // flecha de dirección en el borde
  if (l > STICK_DEAD * DPR) {
    const a = Math.atan2(dy, dx);
    ctx.setTransform(Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), ox, oy);
    ctx.fillStyle = 'rgba(77,243,255,0.8)';
    ctx.beginPath();
    ctx.moveTo(R + 10 * DPR, 0); ctx.lineTo(R + 2 * DPR, -7 * DPR); ctx.lineTo(R + 2 * DPR, 7 * DPR);
    ctx.closePath(); ctx.fill();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
  // pomo
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = 0.7;
  drawImg(halo('#4df3ff'), kx, ky, 46 * DPR);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = 'rgba(77,243,255,0.45)';
  ctx.beginPath(); ctx.arc(kx, ky, 24 * DPR, 0, TAU); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 2 * DPR;
  ctx.stroke();
}

function drawMenuScene() {
  const t = performance.now() / 1000;
  for (const m of menuEnts) {
    if (skinImg[m.type]) rotT(m.x, m.y, Math.sin(t * 2 + m.a) * 0.15);
    else rotT(m.x, m.y, m.a);
    ctx.globalAlpha = 0.6;
    ctx.drawImage(m.spr.c, -m.spr.half, -m.spr.half, m.spr.half * 2, m.spr.half * 2);
  }
  ctx.globalAlpha = 1;
}

// Calcula qué parte del mundo se ve en pantalla
function setView(cx, cy) {
  OX = W / 2 - cx * VIEW;
  OY = H / 2 - cy * VIEW;
  const hw = W / (2 * VIEW), hh = H / (2 * VIEW);
  viewL = cx - hw; viewR = cx + hw; viewT = cy - hh; viewB = cy + hh;
}

function render() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#05030d';
  ctx.fillRect(0, 0, W, H);

  const inGame = state !== 'menu' && P && G;
  let sx = 0, sy = 0;
  if (inGame && G.shake > 0.3) { sx = rand(-1, 1) * G.shake; sy = rand(-1, 1) * G.shake; }
  const cx = cam.x + sx, cy = cam.y + sy;
  setView(cx, cy);

  drawBackdrop(cx, cy);
  worldT();
  if (!inGame) {
    drawGrid(cx, cy);
    drawMenuScene();
  } else {
    drawGrid(P.x, P.y);
    drawWaves();
    worldT();
    drawStrikeMarks();
    drawGems();
    drawPickups();
    drawHazards();
    drawEnemies();
    drawLights();
    drawPlayer();
    drawTexts();
  }

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  if (inGame) drawIndicators();
  ctx.drawImage(vignette, 0, 0, W, H);
  if (inGame) {
    if (P.hp / P.maxHp < 0.3 && state === 'playing') {
      ctx.globalAlpha = 0.45 + Math.sin(performance.now() / 160) * 0.25;
      ctx.drawImage(vignetteRed, 0, 0, W, H);
      ctx.globalAlpha = 1;
    }
    if (G.flashA > 0.01) {
      ctx.fillStyle = `rgba(${G.flashC},${G.flashA})`;
      ctx.fillRect(0, 0, W, H);
    }
  }
  drawJoystick();
}

// =============================================================================
// 9. INTERFAZ
// =============================================================================
const el = {
  hud: $('hud'), xpfill: $('xpfill'), lvl: $('lvl'), wslots: $('wslots'), pslots: $('pslots'),
  timer: $('timer'), kills: $('killcount'), bossbar: $('bossbar'), bossname: $('bossname'),
  bossfill: $('bossfill'), hpfill: $('hpfill'), hptext: $('hptext'),
};
let hudCache = {};

function setText(node, key, val) {
  if (hudCache[key] !== val) { hudCache[key] = val; node.textContent = val; }
}
function setWidth(node, key, frac) {
  const v = Math.round(clamp(frac, 0, 1) * 1000) / 10;
  if (hudCache[key] !== v) { hudCache[key] = v; node.style.width = v + '%'; }
}

function updateHud() {
  setText(el.timer, 'timer', fmtTime(G.time));
  setText(el.kills, 'kills', G.kills.toLocaleString('es-ES'));
  setText(el.lvl, 'lvl', 'NV ' + P.level);
  setWidth(el.xpfill, 'xp', P.xp / P.xpNext);
  setWidth(el.hpfill, 'hp', P.hp / P.maxHp);
  setText(el.hptext, 'hpt', `${Math.ceil(P.hp)} / ${P.maxHp}`);
  const b = bossList.find(x => !x.dead);
  const hasBoss = b ? 1 : 0;
  if (hudCache.boss !== hasBoss) {
    hudCache.boss = hasBoss;
    el.bossbar.classList.toggle('hidden', !b);
    el.timer.classList.toggle('danger', !!b);
  }
  if (b) {
    setText(el.bossname, 'bname', b.name);
    setWidth(el.bossfill, 'bhp', b.hp / b.maxHp);
  }
}

function slotHTML(icon, color, lv, passive, evolved, title) {
  return `<div class="slot${passive ? ' passive' : ''}${evolved ? ' evolved' : ''}" style="--c:${color}" title="${title || ''}">${svg(icon)}${lv !== '' ? `<span class="slot-lv">${lv}</span>` : ''}</div>`;
}

function refreshSlots() {
  el.wslots.innerHTML = P.weapons.map(w => {
    const d = WEAPONS[w.id];
    return slotHTML(w.id, d.color, w.evolved ? '★' : w.level, false, w.evolved, w.evolved ? d.evo.name : d.name);
  }).join('');
  el.pslots.innerHTML = P.passives.map(p => slotHTML(p.id, PASSIVES[p.id].color, p.level, true, false, PASSIVES[p.id].name)).join('');
}

function hideScreens() {
  for (const id of ['menu', 'levelup', 'chest', 'pause', 'gameover']) hide($(id));
}

// ---------- Opciones de mejora -----------------------------------------------------
let currentOptions = [], luOpenedAt = 0, chestOpenedAt = 0;

function rollOptions() {
  const pool = [];
  for (const id in WEAPONS) {
    const w = getWeapon(id);
    if (w) { if (w.level < maxLevel(id)) pool.push([{ kind: 'weapon', id }, 3]); }
    else if (P.weapons.length < MAX_WEAPONS) pool.push([{ kind: 'weapon', id }, P.weapons.length < 3 ? 3.2 : 1.6]);
  }
  for (const id in PASSIVES) {
    const p = getPassive(id);
    if (p) { if (p.level < PASSIVES[id].max) pool.push([{ kind: 'passive', id }, 2]); }
    else if (P.passives.length < MAX_PASSIVES) pool.push([{ kind: 'passive', id }, 1.4]);
  }
  const out = [];
  while (out.length < 3 && pool.length) {
    const opt = weightedPick(pool);
    out.push(opt);
    pool.splice(pool.findIndex(e => e[0] === opt), 1);
  }
  if (!out.length) out.push({ kind: 'heal' }, { kind: 'maxhp' });
  return out;
}

function optionInfo(o) {
  if (o.kind === 'weapon') return { name: WEAPONS[o.id].name, color: WEAPONS[o.id].color, icon: o.id };
  if (o.kind === 'passive') return { name: PASSIVES[o.id].name, color: PASSIVES[o.id].color, icon: o.id };
  if (o.kind === 'heal') return { name: 'Reparación', color: '#ff5ea8', icon: 'curar' };
  return { name: 'Núcleo Reforzado', color: '#ffd84d', icon: 'nucleo' };
}

function applyOption(o) {
  if (o.kind === 'weapon') {
    const w = getWeapon(o.id);
    if (w) w.level++; else addWeapon(o.id);
  } else if (o.kind === 'passive') {
    const p = getPassive(o.id);
    if (p) p.level++; else P.passives.push({ id: o.id, level: 1 });
    PASSIVES[o.id].apply(P);
  } else if (o.kind === 'heal') {
    healPlayer(P.maxHp * 0.5);
  } else {
    P.maxHp += 10;
    P.hp += 10;
  }
  recalcStats();
  refreshSlots();
}

function modText(mods, def) {
  const parts = [];
  for (const k in mods) {
    const v = mods[k];
    if (k === 'dmg') parts.push(`+${v} de daño`);
    else if (k === 'cd') parts.push(`-${v}% de recarga`);
    else if (k === 'amount') parts.push(`+${v} ${v > 1 ? def.unit[1] : def.unit[0]}`);
    else if (k === 'pierce') parts.push(`+${v} de perforación`);
    else if (k === 'area') parts.push(`+${v}% de área`);
    else if (k === 'speed') parts.push(`+${v}% de velocidad`);
    else if (k === 'chains') parts.push(`+${v} ${v > 1 ? 'saltos' : 'salto'} de cadena`);
    else if (k === 'range') parts.push(`+${v} de alcance`);
  }
  return parts.join('<br>');
}

function pipsHTML(cur, max) {
  let s = '';
  for (let i = 0; i < max; i++) s += `<i class="pip${i < cur ? ' on' : i === cur ? ' next' : ''}"></i>`;
  return s;
}

function cardHTML(o, i) {
  const info = optionInfo(o);
  let tag = 'EXTRA', desc = '', pips = '', isNew = false;
  if (o.kind === 'weapon') {
    const d = WEAPONS[o.id], w = getWeapon(o.id), max = maxLevel(o.id);
    if (!w) { isNew = true; tag = 'NUEVA ARMA'; desc = d.desc; }
    else {
      tag = `NIVEL ${w.level} → ${w.level + 1}`;
      desc = modText(d.levels[w.level - 1], d);
      if (w.level + 1 === max) desc += `<span class="evo-hint">★ Nivel máximo. Con <b>${PASSIVES[d.evo.with].name}</b>, un cofre de jefe lo hará evolucionar.</span>`;
    }
    pips = pipsHTML(w ? w.level : 0, max);
  } else if (o.kind === 'passive') {
    const d = PASSIVES[o.id], p = getPassive(o.id);
    if (!p) { isNew = true; tag = 'NUEVA MEJORA'; } else tag = `NIVEL ${p.level} → ${p.level + 1}`;
    desc = d.desc;
    const evoFor = P.weapons.find(w => WEAPONS[w.id].evo.with === o.id && !w.evolved);
    if (evoFor && !p) desc += `<span class="evo-hint">★ Permite evolucionar ${WEAPONS[evoFor.id].name}</span>`;
    pips = pipsHTML(p ? p.level : 0, d.max);
  } else if (o.kind === 'heal') {
    desc = 'Recupera el 50% de tu vida.';
  } else {
    desc = '+10 de vida máxima.';
  }
  return `<button class="card" style="--c:${info.color}" data-i="${i}">
    <span class="card-key">${i + 1}</span>
    <span class="card-icon">${svg(info.icon)}</span>
    <span class="card-tag${isNew ? ' new' : ''}">${tag}</span>
    <span class="card-name">${info.name}</span>
    <span class="card-desc">${desc}</span>
    ${pips ? `<span class="card-pips">${pips}</span>` : ''}
  </button>`;
}

// ---------- Subida de nivel ----------------------------------------------------------
function openLevelUp() {
  state = 'levelup';
  currentOptions = rollOptions();
  $('lu-sub').textContent = 'NIVEL ' + (P.level - G.pending + 1);
  $('cards').innerHTML = currentOptions.map(cardHTML).join('');
  show($('levelup'));
  luOpenedAt = performance.now();
  resetTouch();
  buzz([15, 30, 15]);
  Sound.muffle(true);
  Sound.sfx.levelUp();
  burst(P.x, P.y, '#4df3ff', 40, 380, 0.7);
  addRing(P.x, P.y, 260, '#4df3ff', 0.6, 6);
  if (G.bot) chooseCard(randInt(0, currentOptions.length - 1), true);
}

function chooseCard(i, force) {
  if (state !== 'levelup') return;
  // Evita elegir sin querer si estabas tocando la pantalla justo al subir de nivel
  if (!force && performance.now() - luOpenedAt < (IS_TOUCH ? 600 : 350)) return;
  const opt = currentOptions[i];
  if (!opt) return;
  applyOption(opt);
  hide($('levelup'));
  G.pending--;
  // Onda que aparta a los enemigos cercanos para darte un respiro
  forEachNear(P.x, P.y, 230, e => {
    if (e.boss) return;
    const dx = e.x - P.x, dy = e.y - P.y, d = Math.hypot(dx, dy) || 1;
    if (d > 230) return;
    const f = (1 - d / 230) * 700;
    e.kbx += (dx / d) * f;
    e.kby += (dy / d) * f;
  });
  if (G.pending > 0) openLevelUp(); else resume();
}

$('cards').addEventListener('click', e => {
  const c = e.target.closest('.card');
  if (c) chooseCard(+c.dataset.i);
});

// ---------- Cofres ------------------------------------------------------------------
function openChest() {
  state = 'chest';
  resetTouch();
  buzz([20, 40, 20, 40, 60]);
  Sound.muffle(true);
  Sound.sfx.chest();
  G.flashA = 0.5;
  G.flashC = '255,216,77';
  burst(P.x, P.y, '#ffd84d', 60, 420, 0.9);
  const box = $('chest-content');
  const evo = P.weapons.find(canEvolve);
  if (evo) {
    evo.evolved = true;
    recalcStats();
    refreshSlots();
    const d = WEAPONS[evo.id];
    $('chest-title').textContent = '¡EVOLUCIÓN!';
    box.innerHTML = `<div class="evo">
        <span class="card-icon">${svg(evo.id)}</span>
        <div class="evo-from">${d.name}</div>
        <div class="evo-arrow">▼</div>
        <div class="evo-name">${d.evo.name}</div>
        <div class="evo-desc">${d.evo.desc}</div>
      </div>`;
  } else {
    const gains = [];
    for (let i = 0; i < 3; i++) {
      let opts = rollOptions().filter(o => (o.kind === 'weapon' && getWeapon(o.id)) || (o.kind === 'passive' && getPassive(o.id)));
      if (!opts.length) opts = rollOptions().filter(o => o.kind === 'weapon' || o.kind === 'passive');
      if (!opts.length) break;
      const o = pick(opts);
      const info = optionInfo(o);
      applyOption(o);
      const lv = o.kind === 'weapon' ? getWeapon(o.id).level : getPassive(o.id).level;
      gains.push({ ...info, text: `${info.name} <b>→ Nv ${lv}</b>` });
    }
    if (!gains.length) {
      healPlayer(P.maxHp, true);
      gains.push({ color: '#ff5ea8', icon: 'curar', text: 'Vida restaurada al <b>máximo</b>' });
    }
    $('chest-title').textContent = '¡COFRE!';
    box.innerHTML = gains.map(g => `<div class="gain" style="--c:${g.color}">${slotHTML(g.icon, g.color, '', false)}<span>${g.text}</span></div>`).join('');
  }
  show($('chest'));
  chestOpenedAt = performance.now();
  if (G.bot) closeChest(true);
}

function closeChest(force) {
  if (state !== 'chest') return;
  if (!force && performance.now() - chestOpenedAt < 500) return;
  hide($('chest'));
  if (G.pending > 0) openLevelUp(); else resume();
}
$('btn-chest').addEventListener('click', () => closeChest());

// ---------- Pausa ---------------------------------------------------------------------
function resume() {
  state = 'playing';
  Sound.muffle(false);
  lastT = performance.now();
}

function togglePause() {
  if (state === 'playing') {
    state = 'paused';
    resetTouch();
    renderPauseBuild();
    show($('pause'));
    Sound.muffle(true);
  } else if (state === 'paused') {
    hide($('pause'));
    resume();
  }
}

function renderPauseBuild() {
  const pct = v => { const n = Math.round(v * 100); return (n > 0 ? '+' : n < 0 ? '-' : '') + Math.abs(n) + '%'; };
  const ws = P.weapons.map(w => {
    const d = WEAPONS[w.id];
    return slotHTML(w.id, d.color, w.evolved ? '★' : w.level, false, w.evolved, w.evolved ? d.evo.name : d.name);
  }).join('');
  const ps = P.passives.map(p => slotHTML(p.id, PASSIVES[p.id].color, p.level, true, false, PASSIVES[p.id].name)).join('');
  $('pause-build').innerHTML = `
    <div class="build-row">${ws}</div>
    ${ps ? `<div class="build-row">${ps}</div>` : ''}
    <div class="build-stats">
      <span>Daño <b>${pct(P.might - 1)}</b></span>
      <span>Recarga <b>${pct(P.haste - 1)}</b></span>
      <span>Área <b>${pct(P.area - 1)}</b></span>
      <span>Velocidad <b>${pct(P.speedMul - 1)}</b></span>
      <span>Vida <b>${Math.ceil(P.hp)} / ${P.maxHp}</b></span>
      <span>Tiempo <b>${fmtTime(G.time)}</b></span>
    </div>`;
  $('btn-music').textContent = 'MÚSICA: ' + (Sound.isMusicOn() ? 'SÍ' : 'NO');
  $('btn-vibrate').textContent = 'VIBRACIÓN: ' + (vibrateOn ? 'SÍ' : 'NO');
  updateFullscreenButtons();
}

function toggleMusic() {
  const on = Sound.toggleMusic();
  $('btn-music').textContent = 'MÚSICA: ' + (on ? 'SÍ' : 'NO');
}

function toggleVibrate() {
  vibrateOn = !vibrateOn;
  store.set('vibrate', vibrateOn);
  $('btn-vibrate').textContent = 'VIBRACIÓN: ' + (vibrateOn ? 'SÍ' : 'NO');
  buzz(60);
}

// ---------- Pantalla completa (sobre todo para móviles) -----------------------------------
const canFullscreen = !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);
const isFullscreen = () => !!(document.fullscreenElement || document.webkitFullscreenElement);

function setFullscreen(on) {
  try {
    const d = document, root = d.documentElement;
    if (on && !isFullscreen()) {
      const req = root.requestFullscreen || root.webkitRequestFullscreen;
      const p = req && req.call(root, { navigationUI: 'hide' });
      if (p && p.catch) p.catch(() => {});
    } else if (!on && isFullscreen()) {
      const exit = d.exitFullscreen || d.webkitExitFullscreen;
      const p = exit && exit.call(d);
      if (p && p.catch) p.catch(() => {});
    }
  } catch (e) { /* el navegador no lo permite */ }
}

function updateFullscreenButtons() {
  for (const id of ['btn-fs', 'btn-fs-menu']) {
    const b = $(id);
    b.classList.toggle('hidden', !canFullscreen);
    b.textContent = isFullscreen() ? 'SALIR DE PANTALLA COMPLETA' : 'PANTALLA COMPLETA';
  }
}
document.addEventListener('fullscreenchange', updateFullscreenButtons);
document.addEventListener('webkitfullscreenchange', updateFullscreenButtons);

$('btn-pause').addEventListener('click', togglePause);
$('btn-resume').addEventListener('click', togglePause);
$('btn-music').addEventListener('click', toggleMusic);
$('btn-vibrate').addEventListener('click', toggleVibrate);
$('btn-fs').addEventListener('click', () => setFullscreen(!isFullscreen()));
$('btn-fs-menu').addEventListener('click', () => setFullscreen(!isFullscreen()));
$('btn-restart').addEventListener('click', startGame);
$('btn-quit').addEventListener('click', () => { Sound.fadeOut(); showMenu(); });

// ---------- Fin de partida --------------------------------------------------------------
const SRC_INFO = { bomba: { name: 'Bomba', color: '#ffffff', icon: 'bomba' } };

function showGameOver(win) {
  state = 'over';
  resetTouch();
  hide(el.hud);
  hideScreens();
  if (win) Sound.fadeOut();

  const title = $('go-title');
  title.textContent = win ? '¡VICTORIA!' : 'HAS CAÍDO';
  title.className = 'panel-title ' + (win ? 'win' : 'lose');
  $('go-sub').textContent = win
    ? 'Has destruido el Núcleo del Vacío. La horda se desvanece.'
    : `Resististe ${fmtTime(G.time)} frente a la horda.`;
  $('go-time').textContent = fmtTime(G.time);
  $('go-level').textContent = P.level;
  $('go-kills').textContent = fmtNum(G.kills);

  const best = store.get('best', null);
  const better = !best || (win && !best.win) || (win === !!best.win && G.time > best.time);
  if (better) store.set('best', { time: G.time, kills: G.kills, level: P.level, win });
  $('go-record').classList.toggle('hidden', !(better && G.time > 20));

  const entries = Object.entries(G.dmgBy).sort((a, b) => b[1] - a[1]);
  const top = entries.length ? entries[0][1] : 1;
  $('go-dmg').innerHTML = entries.map(([id, v]) => {
    const w = WEAPONS[id], info = w ? { name: w.name, color: w.color, icon: id } : SRC_INFO[id] || { name: id, color: '#ffffff', icon: 'nucleo' };
    const ev = P.weapons.find(x => x.id === id && x.evolved);
    return `<div class="dmg-row" style="--c:${info.color}">
        ${slotHTML(info.icon, info.color, '', false, !!ev)}
        <span>${ev ? WEAPONS[id].evo.name : info.name}</span>
        <div class="dmg-bar"><i style="width:${((v / top) * 100).toFixed(1)}%"></i></div>
        <span class="dmg-val">${fmtNum(v)}</span>
      </div>`;
  }).join('') || '<div class="go-sub">Ningún daño registrado.</div>';

  show($('gameover'));
}

$('btn-retry').addEventListener('click', startGame);
$('btn-menu').addEventListener('click', showMenu);

// ---------- Menú ------------------------------------------------------------------------
function initMenuScene() {
  menuEnts = [];
  const types = ['zangano', 'veloz', 'divisor', 'centinela', 'tanque'];
  for (let i = 0; i < 22; i++) {
    const type = pick(types), vx = rand(-45, 45), vy = rand(-35, 35);
    menuEnts.push({
      x: cam.x + rand(-800, 800), y: cam.y + rand(-500, 500), vx, vy,
      a: ENEMY_TYPES[type].face ? Math.atan2(vy, vx) : rand(TAU),
      spin: ENEMY_TYPES[type].face ? 0 : rand(-1, 1),
      spr: enemySprite(type, false, false), type,
    });
  }
}

function updateMenu(dt) {
  cam.x += 30 * dt;
  cam.y += 12 * dt;
  const hw = W / (2 * VIEW) + 60, hh = H / (2 * VIEW) + 60;
  for (const m of menuEnts) {
    m.x += m.vx * dt;
    m.y += m.vy * dt;
    m.a += m.spin * dt;
    if (m.x < cam.x - hw) m.x += hw * 2; else if (m.x > cam.x + hw) m.x -= hw * 2;
    if (m.y < cam.y - hh) m.y += hh * 2; else if (m.y > cam.y + hh) m.y -= hh * 2;
  }
}

function showMenu() {
  state = 'menu';
  hide(el.hud);
  hideScreens();
  show($('menu'));
  const best = store.get('best', null);
  $('best').textContent = best
    ? `RÉCORD · ${fmtTime(best.time)} · NV ${best.level} · ${fmtNum(best.kills)} ENEMIGOS${best.win ? ' · ★ VICTORIA' : ''}`
    : '';
  updateFullscreenButtons();
  initMenuScene();
}

$('btn-play').addEventListener('click', startGame);

// ---------- Nueva partida -----------------------------------------------------------------
function startGame() {
  Sound.init();
  Sound.sfx.click();
  enemies = []; bossList = []; projectiles = []; ebullets = []; hazards = []; gems = []; pickups = [];
  particles = []; rings = []; bolts = []; waves = []; strikes = []; texts = []; timers = [];
  pCursor = 0;
  grid.clear();
  P = newPlayer();
  G = newGameState();
  cam.x = 0;
  cam.y = 0;
  addWeapon('pulso');
  hudCache = {};
  refreshSlots();
  hideScreens();
  show(el.hud);
  state = 'playing';
  resetTouch();
  perf.t = 0;
  perf.n = 0;
  if (IS_TOUCH) {
    // En móvil: pantalla completa al empezar y una pista de cómo moverse
    if (!params.has('dev')) setFullscreen(true);
    const hint = $('touch-hint');
    hint.classList.remove('hidden');
    hint.style.animation = 'none';
    void hint.offsetWidth; // reinicia la animación
    hint.style.animation = '';
  }
  Sound.muffle(false);
  Sound.setIntensity(0);
  Sound.startMusic();
  lastT = performance.now();
}

// =============================================================================
// 10. BUCLE PRINCIPAL
// =============================================================================
let lastT = performance.now();

function step(rdt) {
  if (state === 'playing') {
    let dt = rdt;
    if (G.slow > 0) { G.slow -= rdt; dt *= 0.3; } // cámara lenta
    update(dt);
  } else if (state === 'ending') {
    updateFx(rdt * 0.6);
    G.endT -= rdt;
    if (G.endT <= 0) showGameOver(false);
  } else if (state === 'over') {
    updateFx(rdt);
  } else if (state === 'menu') {
    updateMenu(rdt);
  }
  if (G) {
    G.shake *= Math.exp(-9 * rdt);
    G.flashA *= Math.exp(-5 * rdt);
  }
  beat = Math.max(0, beat - rdt * 4);
}

function frame(now) {
  requestAnimationFrame(frame);
  let rdt = (now - lastT) / 1000;
  lastT = now;
  if (!(rdt > 0)) rdt = 0;
  watchPerf(rdt);
  step(Math.min(rdt, 0.05));
  render();
}

Sound.onBeat(() => { beat = 1; });
resize();
addEventListener('resize', resize);
buildBackdrop();
loadSkins();
showMenu();
requestAnimationFrame(frame);

// Modo de pruebas: index.html?dev=120 empieza una partida automática y la
// adelanta 120 segundos (el jugador se mueve solo y es invencible).
// Con &show=levelup|chest|pause|win|lose abre esa pantalla al terminar.
const dev = params.get('dev');
if (dev !== null) {
  startGame();
  G.god = true;
  G.bot = true;
  const target = parseFloat(dev) || 0;
  while (G.time < target && state === 'playing') { step(1 / 60); setView(cam.x, cam.y); }
  const showUi = params.get('show');
  if (showUi) {
    G.bot = false;
    if (showUi === 'levelup') { G.pending = 1; openLevelUp(); }
    else if (showUi === 'chest') openChest();
    else if (showUi === 'pause') togglePause();
    else if (showUi === 'win' || showUi === 'lose') showGameOver(showUi === 'win');
  }
}

// Acceso para depuración desde la consola del navegador
window.__HN = {
  startGame, update, render, step,
  get state() { return state; }, get G() { return G; }, get P() { return P; },
  get bosses() { return bossList; }, get enemies() { return enemies; },
  counts: () => ({ enemies: enemies.length, bosses: bossList.length, projectiles: projectiles.length, ebullets: ebullets.length, hazards: hazards.length, gems: gems.length, particles: particles.length, pickups: pickups.length }),
  chooseCard, closeChest, applyOption,
};

})();
