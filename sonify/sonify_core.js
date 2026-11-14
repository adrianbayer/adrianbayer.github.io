/*
 * sonify_core.js -- the pure math of the Multi-Probe Sky sonifier (no DOM, no Web Audio).
 *
 * Loaded two ways, with no build step:
 *   browser:  <script src="sonify_core.js"></script>   -> window.SonifyCore, window.SONIFY_API
 *   Node:     const Core = require('./web/sonify_core.js')   (unit tests in tests/)
 *
 * Conventions (paper/web_upgrade_spec.md section 2; the same as sonify_cosmo.py offline):
 *   Analysis pitch map  f = F_MIN (l/L_MIN)^ALPHA,  ALPHA = ln(F_MAX/F_MIN)/ln(L_MAX/L_MIN)
 *                       (l 2..6000 -> 40..8000 Hz). Used by noise, additive, layers, sweeps, the plot.
 *   Musical pitch map   f = f_band (l/L_MIN)^BETA,  BETA = 5 ln2 / ln(L_MAX/L_MIN)  (5 octaves),
 *                       f_band = 110 Hz * 2^(s/12), s = the band's A-minor-pentatonic degree
 *                       (bands ascend A2 C3 D3 E3 G3 A3 ...). Used by Instruments.
 *   Duet pitch map      f_A = 110 Hz (l/L_MIN)^GAMMA, GAMMA = 3 ln2 / ln(L_MAX/L_MIN)  (3 octaves,
 *                       110-880 Hz for every band; voice B at most an octave above, <= 1760 Hz).
 *   Spectral density    audio power per ln f  ∝  D_l  (D_l is the variance per ln l and
 *                       d ln f = ALPHA d ln l), i.e. PSD per Hz ∝ D_l(l(f)) / f.
 *   Level               digital variance = (L_REF / REF)^2 * integral D dln l over what is heard:
 *                       audio RMS re L_REF equals the sky-field RMS (muK) re REF (muK).
 *   D_l on the grid     piecewise linear in ln l between the grid points of cl_data.json v2. Its
 *                       integral over the whole grid equals sum_i D_i dlnell_i exactly, because the
 *                       bin edges are geometric midpoints.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else if (root) {
    root.SonifyCore = api;
    root.SONIFY_API = api.API;
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VERSION = '2.2.0';

  // ==========================================================================
  // Constants
  // ==========================================================================
  const ELL_MIN = 2, ELL_MAX = 6000, F_MIN = 40, F_MAX = 8000;
  const LN_ELL_RANGE = Math.log(ELL_MAX / ELL_MIN);
  const ALPHA = Math.log(F_MAX / F_MIN) / LN_ELL_RANGE;        // 0.6618: audio octaves per l-octave
  const L_REF = 0.1;           // digital RMS assigned to REF (-20 dBFS), = sonify_cosmo.TARGET_RMS
  const LOG_FLOOR_DB = -60;    // 'log volume' floor (amplitude dB re REF)
  const COMPONENTS = ['dT_cmblens', 'dT_ksz', 'dT_tsz', 'dT_cib', 'T_tot'];
  const VOICED = ['dT_cmblens', 'dT_tsz', 'dT_cib', 'dT_ksz'];
  // The Total's parts come from the data (T_tot_parts in cl_data.json / sky_img.json, see totalParts);
  // files written before that field existed summed CMB + tSZ + CIB.
  const LEGACY_T_TOT_PARTS = Object.freeze(['dT_cmblens', 'dT_tsz', 'dT_cib']);
  const COMP_LABELS = Object.freeze({ dT_cmblens: 'CMB', dT_tsz: 'tSZ', dT_cib: 'CIB', dT_ksz: 'kSZ', T_tot: 'Total' });
  const SHORT = { dT_cmblens: 'cmblens', dT_tsz: 'tsz', dT_cib: 'cib', dT_ksz: 'ksz', T_tot: 'ttot' };
  const LAYER_BANDS = [[2, 100], [100, 1000], [1000, 6000]];
  const BUFFER_LOG2 = 19;      // loop length 2^19 samples = 11.9 s at 44.1 kHz (>= 8 s up to 65 kHz)
  // Experiment grouping of the observing bands (GHz): labels for the band buttons of the sonifier and
  // the sky views only. The band list itself always comes from the data files (cl_data.json, sky_img.json).
  const BAND_GROUPS = Object.freeze({ 93: 'SO MF', 145: 'SO MF', 225: 'SO HF', 280: 'SO HF',
    143: 'Planck', 217: 'Planck', 353: 'Planck', 545: 'Planck' });

  function clamp(x, a, b) { return x < a ? a : (x > b ? b : x); }

  // ==========================================================================
  // 2.1 Pitch maps
  // ==========================================================================
  /** Analysis map: f = F_MIN (l/L_MIN)^ALPHA, l clamped to [2, 6000]. */
  function ellToFreq(ell) { return F_MIN * Math.pow(clamp(ell, ELL_MIN, ELL_MAX) / ELL_MIN, ALPHA); }
  /** Inverse of ellToFreq, f clamped to [40, 8000] Hz. */
  function freqToEll(f) { return ELL_MIN * Math.pow(clamp(f, F_MIN, F_MAX) / F_MIN, 1 / ALPHA); }

  // Musical map (Instruments): a compressed 5-octave law, with the band as the scale degree. The Duet
  // has its own 3-octave map (duetFreq, section 2.6).
  const MUSICAL = {
    BASE_HZ: 110,                       // A2: the lowest band's note at l = L_MIN
    OCTAVES: 5,                         // l 2..6000 spans 5 octaves
    PENTA: [0, 3, 5, 7, 10],            // A minor pentatonic, semitones above A
  };
  const BETA = MUSICAL.OCTAVES * Math.LN2 / LN_ELL_RANGE;     // 0.4329
  const NOTE_SEMIS = { C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11 };
  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  /** Equal temperament, A4 = 440 Hz, scientific pitch notation (octave numbers change at C). */
  function noteToFreq(name, octave) {
    if (!(name in NOTE_SEMIS)) throw new Error('unknown note ' + name);
    return 440 * Math.pow(2, (NOTE_SEMIS[name] - 9) / 12 + (octave - 4));
  }
  /** Nearest equal-tempered note name, e.g. 'A4', with the deviation in cents. */
  function freqToNote(f) {
    const midi = 69 + 12 * Math.log2(f / 440), m = Math.round(midi);
    return { name: NOTE_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1), cents: Math.round(100 * (midi - m)), midi: m };
  }
  function sortedBands(bands) { return bands.map(Number).sort(function (a, b) { return a - b; }); }
  /** Scale degree of a band = its index in the ascending band list. */
  function bandDegree(band, bands) { const i = sortedBands(bands).indexOf(Number(band)); return i < 0 ? 0 : i; }
  /** Semitones above A2 of scale degree d (A C D E G, then the next octave). */
  function degreeSemis(d) { return MUSICAL.PENTA[d % 5] + 12 * Math.floor(d / 5); }
  /** The band's reference note at l = L_MIN. */
  function bandNote(band, bands) {
    const d = bandDegree(band, bands), s = degreeSemis(d), midi = 45 + s;   // A2 = MIDI 45
    return { degree: d, semis: s, freq: MUSICAL.BASE_HZ * Math.pow(2, s / 12),
      name: NOTE_NAMES[midi % 12] + (Math.floor(midi / 12) - 1) };
  }
  /** Snap a frequency to the nearest A-minor-pentatonic note (any octave). */
  function quantizeToScale(f) {
    const semi = 12 * Math.log2(f / 440), oct = Math.floor(semi / 12);   // re A4
    let best = semi, bd = Infinity;
    for (let o = oct - 1; o <= oct + 1; o++) {
      for (const s of MUSICAL.PENTA) {
        const cand = 12 * o + s, d = Math.abs(cand - semi);
        if (d < bd) { bd = d; best = cand; }
      }
    }
    return 440 * Math.pow(2, best / 12);
  }
  /** Musical map: f = f_band (l/L_MIN)^BETA, optionally snapped to the pentatonic scale. */
  function musicalFreq(ell, band, bands, snap) {
    const f = bandNote(band, bands).freq * Math.pow(clamp(ell, ELL_MIN, ELL_MAX) / ELL_MIN, BETA);
    return snap ? quantizeToScale(f) : f;
  }

  // ==========================================================================
  // Seeded randomness (mulberry32) and hashing
  // ==========================================================================
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  /** Derived 32-bit seed for an independent stream named `tag`. */
  function hashSeed(seed, tag) {
    let h = 0x811c9dc5 ^ (seed >>> 0);
    const s = String(tag);
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
    return h >>> 0;
  }
  /** FNV-1a 32-bit hash of bytes (Uint8Array) or of a typed array's bytes. Returns 8 hex digits. */
  function fnv1a32(data) {
    const b = data instanceof Uint8Array ? data : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    let h = 0x811c9dc5;
    for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 0x01000193); }
    return ('00000000' + (h >>> 0).toString(16)).slice(-8);
  }
  /** Seeded uniform white noise in [-1, 1). */
  function whiteNoise(n, seed) {
    const rng = mulberry32(seed), x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = 2 * rng() - 1;
    return x;
  }

  // ==========================================================================
  // FFT (iterative radix-2) and real inverse FFT
  // ==========================================================================
  const _tw = new Map();
  function twiddles(n) {
    let t = _tw.get(n);
    if (t) return t;
    const c = new Float64Array(n >> 1), s = new Float64Array(n >> 1);
    for (let k = 0; k < (n >> 1); k++) { const a = 2 * Math.PI * k / n; c[k] = Math.cos(a); s[k] = Math.sin(a); }
    t = { c: c, s: s };
    _tw.set(n, t);
    return t;
  }
  /** In-place complex FFT. Forward uses exp(-i...), inverse exp(+i...). Unnormalized. */
  function fft(re, im, inverse) {
    const n = re.length;
    if (n < 1 || (n & (n - 1))) throw new Error('fft length must be a power of 2');
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    const tw = twiddles(n), sign = inverse ? 1 : -1;
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1, step = n / len;
      for (let i = 0; i < n; i += len) {
        for (let k = 0; k < half; k++) {
          const wr = tw.c[k * step], wi = sign * tw.s[k * step];
          const a = i + k, b = a + half;
          const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
        }
      }
    }
  }
  /**
   * Real inverse FFT: x[n] = (1/N) sum_{k=0}^{N-1} X[k] exp(+2 pi i k n/N) for a Hermitian X given
   * by its first N/2+1 bins (Xre, Xim). Uses one N/2-point complex FFT.
   */
  function irfft(Xre, Xim, N) {
    const M = N >> 1;
    if (Xre.length < M + 1) throw new Error('irfft needs N/2+1 bins');
    const zr = new Float64Array(M), zi = new Float64Array(M), tw = twiddles(N);
    for (let k = 0; k < M; k++) {
      const ar = Xre[k], ai = Xim[k], br = Xre[M - k], bi = -Xim[M - k];
      const er = 0.5 * (ar + br), ei = 0.5 * (ai + bi);
      const dr = 0.5 * (ar - br), di = 0.5 * (ai - bi);
      const or_ = dr * tw.c[k] - di * tw.s[k], oi = dr * tw.s[k] + di * tw.c[k];
      zr[k] = er - oi; zi[k] = ei + or_;
    }
    fft(zr, zi, true);
    const x = new Float64Array(N), inv = 1 / M;
    for (let m = 0; m < M; m++) { x[2 * m] = zr[m] * inv; x[2 * m + 1] = zi[m] * inv; }
    return x;
  }
  /** Forward real FFT (bins 0..N/2) via a complex FFT; for analysis and tests. */
  function rfft(x) {
    const N = x.length, re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = x[i];
    fft(re, im, false);
    return { re: re.subarray(0, (N >> 1) + 1), im: im.subarray(0, (N >> 1) + 1) };
  }

  // ==========================================================================
  // The l grid of cl_data.json v2, interpolation and integration in ln l
  // ==========================================================================
  const _gridCache = new WeakMap();
  function makeGrid(ell) {
    const n = ell.length, lnEll = new Float64Array(n);
    for (let i = 0; i < n; i++) lnEll[i] = Math.log(ell[i]);
    return { ell: Float64Array.from(ell), lnEll: lnEll, n: n };
  }
  /** Grid object for a cl_data.json v2 object (cached). */
  function gridOf(clData) {
    let g = _gridCache.get(clData);
    if (!g) { g = makeGrid(clData.ell); _gridCache.set(clData, g); }
    return g;
  }
  function _seg(lnx, x) {          // index i with x[i] <= lnx < x[i+1] (clamped to [0, n-2])
    let lo = 0, hi = x.length - 1;
    if (lnx <= x[0]) return 0;
    if (lnx >= x[hi]) return hi - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (x[mid] <= lnx) lo = mid; else hi = mid; }
    return lo;
  }
  /** y(l) linear in ln l between grid points; held constant beyond the ends. */
  function interpLn(lnGrid, y, lnx) {
    const n = lnGrid.length;
    if (lnx <= lnGrid[0]) return y[0];
    if (lnx >= lnGrid[n - 1]) return y[n - 1];
    const i = _seg(lnx, lnGrid), t = (lnx - lnGrid[i]) / (lnGrid[i + 1] - lnGrid[i]);
    return y[i] + t * (y[i + 1] - y[i]);
  }
  /** D_l at multipole ell (linear interpolation in ln l on the v2 grid). */
  function dlAt(grid, D, ell) { return interpLn(grid.lnEll, D, Math.log(ell)); }
  /**
   * Exact integral of the piecewise-linear (in ln l) interpolant of y over ln l in [lnA, lnB],
   * restricted to the grid's domain (zero outside: there is no data beyond l = 2..6000).
   */
  function integrateLn(lnGrid, y, lnA, lnB) {
    const n = lnGrid.length;
    let a = Math.max(lnA, lnGrid[0]), b = Math.min(lnB, lnGrid[n - 1]);
    if (!(b > a)) return 0;
    let i = _seg(a, lnGrid), sum = 0;
    while (i < n - 1 && lnGrid[i] < b) {
      const x0 = Math.max(a, lnGrid[i]), x1 = Math.min(b, lnGrid[i + 1]);
      if (x1 > x0) {
        const h = lnGrid[i + 1] - lnGrid[i];
        const y0 = y[i] + (x0 - lnGrid[i]) / h * (y[i + 1] - y[i]);
        const y1 = y[i] + (x1 - lnGrid[i]) / h * (y[i + 1] - y[i]);
        sum += 0.5 * (y0 + y1) * (x1 - x0);
      }
      i++;
    }
    return sum;
  }
  /** integral of D dln l between multipoles lo and hi (muK^2): the field variance in that range. */
  function bandPower(grid, D, lo, hi) { return integrateLn(grid.lnEll, D, Math.log(lo), Math.log(hi)); }

  // ==========================================================================
  // Data access (cl_data.json v2, cross_data.json v2)
  // ==========================================================================
  function isFreqIndep(clData, comp) { return (clData.freq_indep || []).indexOf(comp) >= 0; }
  /** D_l array of one component in one band (band ignored for band-independent components). */
  function getSpectrum(clData, comp, band) {
    const v = clData.Dl && clData.Dl[comp];
    if (!v) return null;
    if (Array.isArray(v)) return v;
    return v[String(band)] || null;
  }
  function bandsOf(clData) { return sortedBands(clData.bands || []); }
  /** The components summed into T_tot, from the data's T_tot_parts (cl_data.json or sky_img.json), in
   *  VOICED order; LEGACY_T_TOT_PARTS when the field is absent (data written before it existed). */
  function totalParts(data) {
    const d = data && data.T_tot_parts;
    const p = Array.isArray(d) ? VOICED.filter(function (c) { return d.indexOf(c) >= 0; }) : [];
    return p.length ? p : LEGACY_T_TOT_PARTS.slice();
  }
  /** 'CMB + tSZ + CIB + kSZ': the Total's parts as text. */
  function totalPartsLabel(data) { return totalParts(data).map(function (c) { return COMP_LABELS[c]; }).join(' + '); }

  const _crossCache = new WeakMap();
  function _crossLn(crossData) {
    let c = _crossCache.get(crossData);
    if (!c) {
      const lnEll = Float64Array.from(crossData.ell, Math.log);
      const lnModes = crossData.n_modes ? Float64Array.from(crossData.n_modes, Math.log) : null;
      c = { lnEll: lnEll, lnModes: lnModes };
      _crossCache.set(crossData, c);
    }
    return c;
  }
  /** r_l array of the pair (A, B) at a band ('all' for band-independent pairs), or null. */
  function crossArray(crossData, A, B, band) {
    if (!crossData || !crossData.pairs) return null;
    const a = SHORT[A], b = SHORT[B];
    const v = crossData.pairs[a + '-' + b] || crossData.pairs[b + '-' + a];
    if (!v) return null;
    if (Array.isArray(v)) return v;                       // v1 layout
    return v.all || v[String(band)] || null;
  }
  /** r_XY at multipole ell: linear interpolation in ln l between bin centres, constant beyond. */
  function crossR(crossData, A, B, band, ell) {
    if (A === B) return 1;
    const arr = crossArray(crossData, A, B, band);
    if (!arr) return 0;
    return interpLn(_crossLn(crossData).lnEll, arr, Math.log(ell));
  }
  /** n_modes of the r bins, interpolated in ln l (log-log); null if absent. */
  function crossNModes(crossData, ell) {
    if (!crossData || !crossData.n_modes) return null;
    const c = _crossLn(crossData);
    return Math.exp(interpLn(c.lnEll, c.lnModes, Math.log(ell)));
  }
  /** Exact per-pair D_XY on the grid (cl_data Dl_cross, present only after a raw-alm run). */
  function exactCross(clData, A, B, band) {
    const dc = clData.Dl_cross;
    if (!dc) return null;
    const a = SHORT[A], b = SHORT[B], v = dc[a + '-' + b] || dc[b + '-' + a];
    if (!v) return null;
    if (Array.isArray(v)) return v;
    return v.all || v[String(band)] || null;
  }

  // ==========================================================================
  // 2.4 Mixing with cross terms
  // ==========================================================================
  /** Check an active set: T_tot and its parts (totalParts(data)) are mutually exclusive. Returns a cleaned list. */
  function validateSelection(comps, data) {
    const out = [], parts = totalParts(data);
    for (const c of comps) if (COMPONENTS.indexOf(c) >= 0 && out.indexOf(c) < 0) out.push(c);
    if (out.indexOf('T_tot') >= 0 && out.some(function (c) { return parts.indexOf(c) >= 0; })) {
      throw new Error('T_tot and its components (' + parts.map(function (c) { return COMP_LABELS[c]; }).join(', ') + ') are mutually exclusive');
    }
    return out;
  }
  /**
   * D_mix(l) = sum_X D_X + 2 sum_{X<Y} D_XY on the cl_data grid, D_XY = r_XY sqrt(D_X D_Y) with r from
   * cross_data.json (interpolated in ln l at the band), or the exact D_XY when cl_data has Dl_cross.
   * T_tot (with a non-part) mixes through its parts: D_{Ttot,Y} = sum_{P in totalParts} D_{P,Y}.
   * opts.exact (default true): use Dl_cross when present.
   */
  function mixDl(clData, crossData, comps, band, opts) {
    opts = opts || {};
    const sel = validateSelection(comps, clData), g = gridOf(clData), n = g.n, tp = totalParts(clData);
    const out = new Float64Array(n);
    const D = {};
    function spec(c) {
      if (!D[c]) {
        const s = getSpectrum(clData, c, band);
        if (!s) throw new Error('no spectrum for ' + c + ' at ' + band);
        D[c] = s;
      }
      return D[c];
    }
    for (const c of sel) { const s = spec(c); for (let i = 0; i < n; i++) out[i] += s[i]; }
    const parts = function (c) { return c === 'T_tot' ? tp : [c]; };
    for (let a = 0; a < sel.length; a++) {
      for (let b = a + 1; b < sel.length; b++) {
        for (const X of parts(sel[a])) {
          for (const Y of parts(sel[b])) {
            const ex = opts.exact === false ? null : exactCross(clData, X, Y, band);
            if (ex) { for (let i = 0; i < n; i++) out[i] += 2 * ex[i]; continue; }
            const arr = crossArray(crossData, X, Y, band);
            if (!arr) continue;
            const lnC = _crossLn(crossData).lnEll, dx = spec(X), dy = spec(Y);
            for (let i = 0; i < n; i++) {
              const r = interpLn(lnC, arr, g.lnEll[i]);
              out[i] += 2 * r * Math.sqrt(Math.max(dx[i], 0) * Math.max(dy[i], 0));
            }
          }
        }
      }
    }
    for (let i = 0; i < n; i++) if (out[i] < 0) out[i] = 0;
    return out;
  }

  // ==========================================================================
  // Stereo: correlation between the fields heard in the two channels
  // ==========================================================================
  const TSZ_NULL_GHZ = 217.5;      // non-relativistic tSZ null (x = 3.83): decrement below, increment above
  // Correlation of the CIB with itself in two different bands. Not among the data products
  // (cross_data.json holds component pairs within one band); 1 is the upper bound, stated in the UI.
  const CIB_INTERBAND_R = 1;
  /** Sign of the tSZ spectral function g(nu): -1 below the 217 GHz null, +1 above. */
  function tszSign(band) { return Number(band) < TSZ_NULL_GHZ ? -1 : 1; }
  /**
   * r between component X observed in band bX and component Y in band bY, at multipole ell.
   * Same band: r_XY from cross_data (1 for X = Y). Different bands: a band-independent component
   * (CMB, kSZ) is the same field in both; the tSZ is one y map times g(nu) (cl_data: the tSZ spectra
   * of all bands are proportional to 1e-5), so it carries over with the sign of g(nuX) g(nuY);
   * CIB x CIB across bands uses CIB_INTERBAND_R.
   */
  function pairR(clData, crossData, X, bX, Y, bY, ell) {
    const iX = isFreqIndep(clData, X), iY = isFreqIndep(clData, Y);
    if (iX) bX = bY;
    if (iY) bY = bX;
    if (String(bX) === String(bY)) return crossR(crossData, X, Y, bX, ell);
    if (X === Y) return X === 'dT_tsz' ? tszSign(bX) * tszSign(bY) : (X === 'dT_cib' ? CIB_INTERBAND_R : 1);
    if (X === 'dT_tsz') return tszSign(bX) * tszSign(bY) * crossR(crossData, X, Y, bY, ell);   // tSZ@bX = c tSZ@bY
    if (Y === 'dT_tsz') return tszSign(bX) * tszSign(bY) * crossR(crossData, X, Y, bX, ell);
    return 0;
  }
  /**
   * Correlation coefficient rho(l) on the cl_data grid between the field of selection compsL in band
   * bandL (left channel) and of compsR in bandR (right channel):
   *   rho = sum_{X in L, Y in R} r_{X,Y} sqrt(D_X D_Y) / sqrt(D_mix,L D_mix,R)   (T_tot through its parts).
   * For one band this equals (D_mix(L u R) - D_mix(L) - D_mix(R)) / (2 sqrt(D_mix(L) D_mix(R))).
   */
  function stereoCoherence(clData, crossData, compsL, bandL, compsR, bandR) {
    const g = gridOf(clData), n = g.n, tp = totalParts(clData), parts = function (c) { return c === 'T_tot' ? tp : [c]; };
    const DL = mixDl(clData, crossData, compsL, bandL), DR = mixDl(clData, crossData, compsR, bandR);
    const C = new Float64Array(n), out = new Float64Array(n);
    for (const cl of validateSelection(compsL, clData)) for (const X of parts(cl)) {
      const dx = getSpectrum(clData, X, bandL);
      for (const cr of validateSelection(compsR, clData)) for (const Y of parts(cr)) {
        const dy = getSpectrum(clData, Y, bandR);
        if (!dx || !dy) continue;
        for (let i = 0; i < n; i++) C[i] += pairR(clData, crossData, X, bandL, Y, bandR, g.ell[i]) * Math.sqrt(Math.max(dx[i], 0) * Math.max(dy[i], 0));
      }
    }
    for (let i = 0; i < n; i++) { const den = Math.sqrt(DL[i] * DR[i]); out[i] = den > 0 ? clamp(C[i] / den, -1, 1) : 0; }
    return out;
  }

  // ==========================================================================
  // 2.3 Loudness compensation: ISO 226:2003 equal-loudness contours
  // ==========================================================================
  // Table 1 of ISO 226:2003 (frequency, alpha_f, L_U, T_f).
  const ISO226 = {
    f: [20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000,
      1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500],
    af: [0.532, 0.506, 0.480, 0.455, 0.432, 0.409, 0.387, 0.367, 0.349, 0.330, 0.315, 0.301, 0.288,
      0.276, 0.267, 0.259, 0.253, 0.250, 0.246, 0.244, 0.243, 0.243, 0.243, 0.242, 0.242, 0.245,
      0.254, 0.271, 0.301],
    LU: [-31.6, -27.2, -23.0, -19.1, -15.9, -13.0, -10.3, -8.1, -6.2, -4.5, -3.1, -2.0, -1.1, -0.4,
      0.0, 0.3, 0.5, 0.0, -2.7, -4.1, -1.0, 1.7, 2.5, 1.2, -2.1, -7.1, -11.2, -10.7, -3.1],
    Tf: [78.5, 68.7, 59.5, 51.1, 44.0, 37.5, 31.5, 26.5, 22.1, 17.9, 14.4, 11.4, 8.6, 6.2, 4.4, 3.0,
      2.2, 2.4, 3.5, 1.7, -1.3, -4.2, -6.0, -5.4, -1.5, 6.0, 12.6, 13.9, 12.3],
  };
  /** Sound pressure level (dB) of the `phon` contour at table index i (ISO 226:2003 eq. 1). */
  function iso226At(i, phon) {
    const af = ISO226.af[i], LU = ISO226.LU[i], Tf = ISO226.Tf[i];
    const Af = 4.47e-3 * (Math.pow(10, 0.025 * phon) - 1.15) + Math.pow(0.4 * Math.pow(10, (Tf + LU) / 10 - 9), af);
    return (10 / af) * Math.log10(Af) - LU + 94;
  }
  const _isoCache = new Map();
  /** The contour at the 29 table frequencies (cached per phon). */
  function iso226Contour(phon) {
    let c = _isoCache.get(phon);
    if (!c) { c = ISO226.f.map(function (_, i) { return iso226At(i, phon); }); _isoCache.set(phon, c); }
    return c;
  }
  /** SPL of the contour at any f: linear in log10 f between table frequencies, held beyond them. */
  function iso226SPL(f, phon) {
    const F = ISO226.f, n = F.length, L = iso226Contour(phon);
    if (f <= F[0]) return L[0];
    if (f >= F[n - 1]) return L[n - 1];
    let i = 0;
    while (i < n - 2 && F[i + 1] <= f) i++;
    const t = Math.log(f / F[i]) / Math.log(F[i + 1] / F[i]);
    return L[i] + t * (L[i + 1] - L[i]);
  }
  /**
   * Inverse-equal-loudness power weighting in dB at frequency f: the contour at `phon` relative to
   * its value at 1 kHz, boosts capped at capDb. Positive = boost (the ear is less sensitive there).
   */
  function loudnessCompDb(f, phon, capDb) {
    phon = phon == null ? 60 : phon;
    capDb = capDb == null ? 30 : capDb;
    return Math.min(iso226SPL(f, phon) - iso226SPL(1000, phon), capDb);
  }

  // ==========================================================================
  // 2.3 Display density: beam, loudness compensation, log volume
  // ==========================================================================
  /** dB-linear 'log volume' map of an amplitude ratio a (re REF): 1 + dB/60, floored at 0. */
  function logMapAmp(a, floorDb) {
    floorDb = floorDb == null ? LOG_FLOOR_DB : floorDb;
    if (!(a > 0)) return 0;
    return Math.max(0, 1 + 20 * Math.log10(a) / (-floorDb));
  }
  /**
   * The density that is actually synthesized, on the grid:
   *   D -> D / B^2 (opts.B2, beam deconvolution) -> * 10^(compDb/10) (opts.compDb, per grid point)
   *     -> D_REF * logMapAmp(sqrt(D / D_REF))^2 (opts.logAnchor = D_REF > 0).
   */
  function displayDensity(D, opts) {
    opts = opts || {};
    const n = D.length, out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let v = Math.max(D[i], 0);
      if (opts.B2) v /= Math.max(opts.B2[i], 1e-12);
      if (opts.compDb) v *= Math.pow(10, opts.compDb[i] / 10);
      if (opts.logAnchor > 0) { const m = logMapAmp(Math.sqrt(v / opts.logAnchor)); v = opts.logAnchor * m * m; }
      out[i] = v;
    }
    return out;
  }

  // ==========================================================================
  // 2.5 Sweep window: Butterworth band-pass (cascaded biquads), constant width in ln l
  // ==========================================================================
  const WINDOW_ORDER = 6;             // minimum Butterworth prototype order (band-pass order 12)
  const WINDOW_LEAK_DB = -60;         // spec 2.5: leakage one l-octave from the centre below this
  /** Fractional bandwidth b = 2^(ALPHA w/2) - 2^(-ALPHA w/2) for a -3 dB width of w l-octaves. */
  function windowB(widthOct) { return Math.pow(2, ALPHA * widthOct / 2) - Math.pow(2, -ALPHA * widthOct / 2); }
  /**
   * Prototype order of the window of width w: the smallest n >= WINDOW_ORDER whose analog response
   * one l-octave from the centre, 1/(1 + Omega_1^(2n)), is below WINDOW_LEAK_DB with 6 dB to spare
   * for the bilinear warping (which widens the lower skirt near the Nyquist frequency).
   * n = 6 for w = 0.25 and 0.5 (digital leakage <= -108 and -72 dB), n = 11 for w = 1 (<= -64 dB).
   */
  function windowOrder(widthOct) {
    const om1 = (Math.pow(2, ALPHA) - Math.pow(2, -ALPHA)) / windowB(widthOct);
    return Math.max(WINDOW_ORDER, Math.ceil((-WINDOW_LEAK_DB + 6) / (20 * Math.log10(om1))));
  }
  /** Analog window power |H|^2 at x = ln(l / l_c): 1 / (1 + Omega^(2n)), Omega = (r - 1/r)/b, r = e^(ALPHA x). */
  function windowPower(x, widthOct, order) {
    order = order || windowOrder(widthOct);
    const r = Math.exp(ALPHA * x), Om = (r - 1 / r) / windowB(widthOct);
    return 1 / (1 + Math.pow(Om * Om, order));
  }
  /**
   * Butterworth low-pass prototype of order n -> band-pass of fractional bandwidth b (centre 1):
   * the n pole pairs as biquad sections {fMul, Q} (multiples of the centre frequency), and the
   * gain G0 that makes the product of unit-peak band-pass sections equal to 1 at the centre.
   */
  function _bpSections(b, order) {
    const roots = [];
    for (let k = 1; k <= order; k++) {
      const th = Math.PI * (2 * k + order - 1) / (2 * order);
      const pr = Math.cos(th), pi = Math.sin(th);            // prototype pole (left half plane)
      // roots of s^2 - p b s + 1 = 0 (one of the two has Im > 0)
      const Br = pr * b, Bi = pi * b;
      const dr = Br * Br - Bi * Bi - 4, di = 2 * Br * Bi;
      const mod = Math.sqrt(Math.hypot(dr, di)), arg = Math.atan2(di, dr) / 2;
      const sr = mod * Math.cos(arg), si = mod * Math.sin(arg);
      for (const sgn of [1, -1]) {
        const re = 0.5 * (Br + sgn * sr), im = 0.5 * (Bi + sgn * si);
        if (im > 0) roots.push([re, im]);
      }
    }
    roots.sort(function (u, v) { return Math.hypot(u[0], u[1]) - Math.hypot(v[0], v[1]); });
    let prodBw = 1;
    const sections = roots.map(function (z) {
      const w = Math.hypot(z[0], z[1]);
      prodBw *= -2 * z[0];
      return { fMul: w, Q: w / (-2 * z[0]) };
    });
    return { sections: sections, G0: Math.pow(b, order) / prodBw };
  }
  /** The analog sweep window of width widthOct l-octaves (its sections, for reference and tests). */
  function bandpassDesign(widthOct, order) {
    order = order || windowOrder(widthOct);
    const b = windowB(widthOct), d = _bpSections(b, order);
    return { sections: d.sections, G0: d.G0, widthOct: widthOct, order: order, b: b };
  }
  /**
   * Settings of the Web Audio 'bandpass' BiquadFilterNodes for a window centred at fc: the band-pass
   * is designed in the bilinear-warped domain (Omega = tan(pi f / sr)) with its -3 dB edges prewarped
   * from fc 2^(+-ALPHA w/2), so the digital edges are exact at every fc. Each RBJ section is then
   * exactly the bilinear transform of its analog section: f0 = (sr/pi) atan(Omega_k), same Q.
   * Returns {sections: [{freq, Q}], gain} (gain = the normalization making the centre 0 dB).
   */
  function sweepFilterSettings(design, fc, sampleRate) {
    const h = Math.pow(2, ALPHA * design.widthOct / 2), ny = 0.499 * sampleRate;
    const fLo = Math.min(fc / h, ny * 0.98), fHi = Math.min(fc * h, ny);
    const Wlo = Math.tan(Math.PI * fLo / sampleRate), Whi = Math.tan(Math.PI * fHi / sampleRate);
    const W0 = Math.sqrt(Wlo * Whi), d = _bpSections((Whi - Wlo) / W0, design.order);
    return {
      sections: d.sections.map(function (s) {
        return { freq: Math.min(sampleRate / Math.PI * Math.atan(W0 * s.fMul), ny), Q: s.Q };
      }),
      gain: d.G0,
    };
  }
  /** RBJ / Web Audio 'bandpass' biquad (constant 0 dB peak gain), coefficients normalized by a0. */
  function rbjBandpass(f0, Q, sampleRate) {
    const w0 = 2 * Math.PI * f0 / sampleRate, al = Math.sin(w0) / (2 * Q), a0 = 1 + al;
    return { b0: al / a0, b1: 0, b2: -al / a0, a1: -2 * Math.cos(w0) / a0, a2: (1 - al) / a0 };
  }
  function biquadPower(c, f, sampleRate) {
    const w = 2 * Math.PI * f / sampleRate, c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
    const nr = c.b0 + c.b1 * c1 + c.b2 * c2, ni = -(c.b1 * s1 + c.b2 * s2);
    const dr = 1 + c.a1 * c1 + c.a2 * c2, di = -(c.a1 * s1 + c.a2 * s2);
    return (nr * nr + ni * ni) / (dr * dr + di * di);
  }
  /**
   * White-noise power gain of the RBJ / Web Audio 'bandpass' biquad (0 dB peak): the sum of its
   * squared impulse response = (1/pi) integral_0^pi |H|^2 dw = alpha / (1 + alpha), alpha = sin(w0)/(2Q).
   * (For f0 << sr this is the analog (pi/2) (f0/Q) / (sr/2): the noise bandwidth is pi/2 times f0/Q.)
   */
  function rbjBandpassNoiseGain(f0, Q, sampleRate) {
    const al = Math.sin(2 * Math.PI * f0 / sampleRate) / (2 * Q);
    return al / (1 + al);
  }
  /**
   * The digital cascade (as Web Audio realizes it) centred at fc: its settings and its power
   * response |H(f)|^2 (normalized to 0 dB at fc) as a function of f. Build once, evaluate often.
   */
  function sweepFilterResponse(design, fc, sampleRate) {
    const st = sweepFilterSettings(design, fc, sampleRate);
    const cs = st.sections.map(function (s) { return rbjBandpass(s.freq, s.Q, sampleRate); }), g2 = st.gain * st.gain;
    return { settings: st, power: function (f) { let p = g2; for (const c of cs) p *= biquadPower(c, f, sampleRate); return p; } };
  }
  /** Power response |H(f)|^2 of the digital cascade (as Web Audio realizes it), centred at fc, normalized. */
  function sweepFilterPower(design, fc, f, sampleRate) { return sweepFilterResponse(design, fc, sampleRate).power(f); }
  /**
   * Carrier the l-sweep band-passes, given the Play method: a D-shaped full-range buffer, so that the
   * windowed output variance is scale^2 * integral D W dln l. Shaped noise and additive partials are
   * D-shaped; the Scale-Layers buffer is not (one tone per l band, flat noise above l = 1000), so a
   * Layers sweep uses the shaped-noise carrier.
   */
  function sweepCarrierMethod(method) { return method === 'additive' ? 'additive' : 'noise'; }

  // ==========================================================================
  // Fine uniform ln l grid and windowed band power (sweep, instruments, duet)
  // ==========================================================================
  function fineGrid(M) {
    M = M || 1024;
    const a = Math.log(ELL_MIN), dx = LN_ELL_RANGE / (M - 1), ln = new Float64Array(M);
    for (let i = 0; i < M; i++) ln[i] = a + i * dx;
    return { lnEll: ln, dx: dx, M: M };
  }
  function resampleFine(grid, D, fg) {
    const out = new Float64Array(fg.M);
    for (let i = 0; i < fg.M; i++) out[i] = interpLn(grid.lnEll, D, fg.lnEll[i]);
    return out;
  }
  function windowKernel(fg, widthOct, order) {
    const w = [];
    for (let j = 0; ; j++) {
      const v = windowPower(j * fg.dx, widthOct, order);
      if (v < 1e-12 || j >= fg.M) break;
      w.push(v);
    }
    return Float64Array.from(w);       // symmetric in ln l (the Butterworth band-pass is geometric-symmetric)
  }
  const _kernelFFT = new WeakMap();
  /**
   * A_w^2(l_c) = integral D W(ln l - ln l_c) dln l on the fine grid (trapezoid rule; zero outside
   * 2..6000). Linear convolution by FFT (the kernel is symmetric).
   */
  function windowedPower(fineD, kernel, dx) {
    const M = fineD.length, K = kernel.length - 1;
    let L = 1;
    while (L < M + 2 * K + 1) L <<= 1;
    let kf = _kernelFFT.get(kernel);
    if (!kf || kf.L !== L) {
      const re = new Float64Array(L), im = new Float64Array(L);
      re[0] = kernel[0];
      for (let j = 1; j <= K; j++) { re[j] = kernel[j]; re[L - j] = kernel[j]; }
      fft(re, im, false);
      kf = { L: L, re: re, im: im };
      _kernelFFT.set(kernel, kf);
    }
    const re = new Float64Array(L), im = new Float64Array(L);
    for (let i = 0; i < M; i++) re[i] = fineD[i];
    re[0] *= 0.5; re[M - 1] *= 0.5;                  // trapezoid weights at the data edges
    fft(re, im, false);
    for (let k = 0; k < L; k++) {
      const a = re[k], b = im[k];
      re[k] = a * kf.re[k] - b * kf.im[k]; im[k] = a * kf.im[k] + b * kf.re[k];
    }
    fft(re, im, true);
    const out = new Float64Array(M), s = dx / L;
    for (let c = 0; c < M; c++) out[c] = Math.max(re[c] * s, 0);
    return out;
  }

  // ==========================================================================
  // 2.3 Level model: one reference per display family, Absolute or Equalized
  // ==========================================================================
  /**
   * LevelModel(clData, crossData, opts) with opts {deconvolve, loudComp, logVolume, windowOct,
   * phon=60, capDb=30}. Families:
   *   'play'  : full-spectrum renders (Play, Build-Up, nu-Sweep). Amplitude A = sqrt(int D_disp dln l)
   *             over the l range. REF_play = max over all spectra and bands of A over l 2..6000.
   *   'win'   : l-sweep (windowed). A_w(l_c) = sqrt(int D_disp W dln l). REF_win = max over spectra,
   *             bands and l_c. The sweep's fixed make-up gain is REF_play/REF_win.
   *   'voice' : Instruments, Duet. A_v(l) = A_w(l) of the voice's own spectrum (beam only), times
   *             sqrt(G_ISO(f_voice)) when loudness compensation is on; log volume maps A_v/REF_voice.
   *             f_voice is the voice's own pitch: on the musical map (Instruments), or on the duet map
   *             (duetFreq) times 2^(semis/12): the root for voice A and the noise cue, the rung above it
   *             for voice B's tone. REF_VOICE_DUET is the maximum over all those pitches, so no duet
   *             voice exceeds it. Without loudness compensation A_v depends on neither, and
   *             REF_VOICE_DUET = REF_VOICE.
   *             The duet's default level mode ('common', duetLevels) does not use A_v at all.
   * 'All spectra' = the five components (CMB, kSZ, tSZ, CIB, T_tot) in every band.
   */
  function LevelModel(clData, crossData, opts) {
    this.cl = clData; this.cross = crossData;
    this.o = Object.assign({ deconvolve: false, loudComp: false, logVolume: false, windowOct: 0.5, phon: 60, capDb: 30 }, opts || {});
    this.grid = gridOf(clData);
    this.bands = bandsOf(clData);
    this.fine = fineGrid(1024);
    this.kernel = windowKernel(this.fine, this.o.windowOct);
    this.B2 = this.o.deconvolve ? clData.beam_B2 : null;
    const self = this;
    this.compDbGrid = this.o.loudComp ? Array.from(this.grid.ell, function (l) { return loudnessCompDb(ellToFreq(l), self.o.phon, self.o.capDb); }) : null;
    this._cache = new Map();
    this._initRefs();
  }
  LevelModel.prototype._key = function (comps, band) { return comps.slice().sort().join('+') + '@' + band; };
  /** Mixed, beam-treated D (no compensation, no log). */
  LevelModel.prototype.baseDensity = function (comps, band) {
    const k = 'base:' + this._key(comps, band);
    if (!this._cache.has(k)) this._cache.set(k, displayDensity(mixDl(this.cl, this.cross, comps, band), { B2: this.B2 }));
    return this._cache.get(k);
  };
  /** The density synthesized by the analysis-map modes (beam, ISO weighting at f(l), log volume). */
  LevelModel.prototype.analysisDensity = function (comps, band, logAnchor) {
    const anchor = this.o.logVolume ? (logAnchor || this.D_REF) : 0;
    const k = 'ana:' + this._key(comps, band) + ':' + anchor;
    if (!this._cache.has(k)) {
      this._cache.set(k, displayDensity(this.baseDensity(comps, band), { compDb: this.compDbGrid, logAnchor: anchor }));
    }
    return this._cache.get(k);
  };
  LevelModel.prototype._spectraList = function () {
    const list = [];
    for (const c of COMPONENTS) {
      if (isFreqIndep(this.cl, c)) { if (getSpectrum(this.cl, c, null)) list.push({ comps: [c], band: this.bands[0], label: c }); }
      else for (const b of this.bands) if (getSpectrum(this.cl, c, b)) list.push({ comps: [c], band: b, label: c + '@' + b });
    }
    return list;
  };
  LevelModel.prototype.fullPower = function (D) { return integrateLn(this.grid.lnEll, D, Math.log(ELL_MIN), Math.log(ELL_MAX)); };
  LevelModel.prototype.windowedAmp2 = function (D) {
    return windowedPower(resampleFine(this.grid, D, this.fine), this.kernel, this.fine.dx);
  };
  /** max over a list of selections of the full-range power and of the windowed power (linear + display). */
  LevelModel.prototype._refsOver = function (list) {
    let pLin = 0, labLin = '';
    for (const s of list) {
      const D = displayDensity(this.baseDensity(s.comps, s.band), { compDb: this.compDbGrid });
      const p = this.fullPower(D);
      if (p > pLin) { pLin = p; labLin = s.label; }
    }
    const D_REF = pLin / LN_ELL_RANGE;          // flat density whose full-range integral is REF_lin^2
    let pPlay = 0, labPlay = '', pWin = 0, labWin = '';
    for (const s of list) {
      const D = this.analysisDensity(s.comps, s.band, D_REF);
      const p = this.fullPower(D);
      if (p > pPlay) { pPlay = p; labPlay = s.label; }
      const w = this.windowedAmp2(D);
      for (let i = 0; i < w.length; i++) if (w[i] > pWin) { pWin = w[i]; labWin = s.label + ' l=' + Math.round(Math.exp(this.fine.lnEll[i])); }
    }
    return { refLin: Math.sqrt(pLin), D_REF: D_REF, refPlay: Math.sqrt(pPlay), refWin: Math.sqrt(pWin),
      labels: { lin: labLin, play: labPlay, win: labWin } };
  };
  LevelModel.prototype._initRefs = function () {
    const r = this._refsOver(this._spectraList());
    this.REF_LIN = r.refLin; this.D_REF = r.D_REF; this.REF_PLAY = r.refPlay; this.REF_WIN = r.refWin;
    this.refLabels = r.labels;
    // voice family (beam only; ISO weighting at the voice's pitch: musical map, or the duet map at every
    // pitch a duet voice can take there: the root (voice A, the cue) and each rung above it (voice B))
    for (const map of ['musical', 'duet']) {
      let best = 0, lab = '';
      const ups = map === 'duet' && this.o.loudComp ? DUET_PITCH_OFFSETS : [0];
      for (const s of this._spectraList()) {
        for (const up of ups) {
          const a = this.voiceAmpArray(s.comps[0], s.band, map, up);
          for (let i = 0; i < a.length; i++) if (a[i] > best) { best = a[i]; lab = s.label + (up ? ' +' + up + ' st' : ''); }
        }
      }
      if (map === 'duet') { this.REF_VOICE_DUET = best; this.refLabels.voice_duet = lab; }
      else { this.REF_VOICE = best; this.refLabels.voice = lab; }
    }
  };
  /** Per-selection references: the same maxima over the bands of this selection only. */
  LevelModel.prototype.selectionRefs = function (comps) {
    comps = validateSelection(comps, this.cl);
    const k = 'sel:' + comps.slice().sort().join('+');
    if (!this._cache.has(k)) {
      const indep = comps.every(function (c) { return (this.cl.freq_indep || []).indexOf(c) >= 0; }, this);
      const bands = indep ? [this.bands[0]] : this.bands;
      this._cache.set(k, this._refsOver(bands.map(function (b) { return { comps: comps, band: b, label: comps.join('+') + '@' + b }; })));
    }
    return this._cache.get(k);
  };
  /**
   * Voice amplitude A_v on the fine grid (muK; with sqrt(ISO gain) at the voice's pitch if loudComp).
   * map: 'musical' (default; Instruments, musicalFreq unsnapped) or 'duet' (duetFreq unsnapped, times
   * 2^(semis/12): semis = 0 (default) for voice A and the cue at the root, the rung's semitones for
   * voice B's tone, so that every duet voice is compensated at its own pitch).
   */
  LevelModel.prototype.voiceAmpArray = function (comp, band, map, semis) {
    const duet = map === 'duet' && this.o.loudComp;          // the map matters only through the ISO gain
    const up = duet ? (semis || 0) : 0;
    const k = 'voice:' + comp + '@' + band + (duet ? ':duet' + (up ? '+' + up : '') : '');
    if (!this._cache.has(k)) {
      const w = this.windowedAmp2(this.baseDensity([comp], band)), out = new Float64Array(w.length);
      const f0 = duet ? DUET.BASE_HZ * Math.pow(2, up / 12) : bandNote(band, this.bands).freq, ex = duet ? DUET_GAMMA : BETA;
      for (let i = 0; i < w.length; i++) {
        let a = Math.sqrt(Math.max(w[i], 0));
        if (this.o.loudComp) {
          const f = f0 * Math.exp(ex * (this.fine.lnEll[i] - this.fine.lnEll[0]));   // musicalFreq / duetFreq, unsnapped
          a *= Math.pow(10, loudnessCompDb(f, this.o.phon, this.o.capDb) / 20);
        }
        out[i] = a;
      }
      this._cache.set(k, out);
    }
    return this._cache.get(k);
  };
  LevelModel.prototype.fineAt = function (arr, ell) { return interpLn(this.fine.lnEll, arr, Math.log(clamp(ell, ELL_MIN, ELL_MAX))); };
  /**
   * Per-voice reference for the 'equalized' mode: the voice's own max over bands and l (on its pitch map;
   * on the duet map with loudness compensation also over every pitch a duet voice can take, as REF_VOICE_DUET).
   */
  LevelModel.prototype.voiceRefEqualized = function (comp, map) {
    const duet = map === 'duet' && this.o.loudComp;
    const k = 'veq:' + comp + (duet ? ':duet' : '');
    if (!this._cache.has(k)) {
      let m = 0;
      const bands = isFreqIndep(this.cl, comp) ? [this.bands[0]] : this.bands;
      for (const b of bands) {
        for (const up of (duet ? DUET_PITCH_OFFSETS : [0])) {
          const a = this.voiceAmpArray(comp, b, map, up);
          for (let i = 0; i < a.length; i++) if (a[i] > m) m = a[i];
        }
      }
      this._cache.set(k, m);
    }
    return this._cache.get(k);
  };
  /**
   * Play family: {scale2 (digital variance per muK^2), ref, D_disp} for a selection. In Equalized
   * mode the reference is the maximum over the bands of `refComps` (default: the selection itself).
   * Renders that must share one scale pass the larger selection: Build-Up passes ['T_tot'] for every
   * stage, the component-stereo mode passes the whole selection for each channel.
   */
  LevelModel.prototype.playSetup = function (comps, band, levelMode, refComps) {
    let ref = this.REF_PLAY, anchor = this.D_REF;
    if (levelMode === 'equalized') { const r = this.selectionRefs(refComps || comps); ref = r.refPlay; anchor = r.D_REF; }
    const D = this.analysisDensity(comps, band, anchor);
    return { D: D, ref: ref, scale2: ref > 0 ? (L_REF * L_REF) / (ref * ref) : 0 };
  };
  /** Level of a full-spectrum render over [lo, hi], in dB re its REF. */
  LevelModel.prototype.playLevelDb = function (comps, band, levelMode, lo, hi, refComps) {
    const s = this.playSetup(comps, band, levelMode, refComps);
    const p = bandPower(this.grid, s.D, lo, hi);
    return 10 * Math.log10(Math.max(p, 1e-300) / (s.ref * s.ref));
  };
  /** Sweep family: windowed amplitude array (fine grid, muK), its REF, and the make-up gain. */
  LevelModel.prototype.sweepSetup = function (comps, band, levelMode) {
    let refPlay = this.REF_PLAY, refWin = this.REF_WIN, anchor = this.D_REF;
    if (levelMode === 'equalized') { const r = this.selectionRefs(comps); refPlay = r.refPlay; refWin = r.refWin; anchor = r.D_REF; }
    const D = this.analysisDensity(comps, band, anchor);
    const w = this.windowedAmp2(D), amp = new Float64Array(w.length);
    for (let i = 0; i < w.length; i++) amp[i] = Math.sqrt(Math.max(w[i], 0));
    return { D: D, amp: amp, refPlay: refPlay, refWin: refWin, makeup: refWin > 0 ? refPlay / refWin : 0,
      scale2: refPlay > 0 ? (L_REF * L_REF) / (refPlay * refPlay) : 0 };
  };
  /**
   * Voice target digital RMS and its level in dB re REF at multipole ell (map: 'musical' or 'duet';
   * semis: on the duet map, the voice's pitch above the root, see voiceAmpArray).
   */
  LevelModel.prototype.voiceLevel = function (comp, band, ell, levelMode, map, semis) {
    const a = this.fineAt(this.voiceAmpArray(comp, band, map, semis), ell);
    const ref = levelMode === 'equalized' ? this.voiceRefEqualized(comp, map) : (map === 'duet' ? this.REF_VOICE_DUET : this.REF_VOICE);
    const ratio = ref > 0 ? a / ref : 0;
    const g = this.o.logVolume ? logMapAmp(ratio) : ratio;
    return { rms: L_REF * g, ratio: ratio, db: 20 * Math.log10(Math.max(ratio, 1e-15)), amp: a, ref: ref };
  };
  /**
   * Duet levels at multipole ell (v2.2): voice A at the root f_A (duetFreq, unsnapped like every voice's
   * pitch in the level model), voice B's tone at its own pitch f_B = f_A 2^(semis/12), and the noise cue
   * that stands in for B in the gated state, centred on the root, at f_A. Returns {A, B, cue}, each with
   * voiceLevel's fields plus f (the pitch whose ISO gain applies), compDb (that gain, dB) and mode.
   *  duetLevel 'common' (the page's default): one constant level for every voice, DUET.COMMON_DB re L_REF,
   *    whatever the data, so the duet carries r by the interval and the spread only. With loudness
   *    compensation each voice gets the ISO gain at its own pitch re the gain's maximum over the duet
   *    register (duetCompMaxDb): the compensated levels never exceed the common level.
   *  duetLevel 'data': each voice's data level (voiceLevel on the duet map; levelMode 'absolute' or
   *    'equalized'), with the ISO gain at each voice's own pitch (B's tone at f_B, the cue at f_A). One
   *    component can then be 20-60 dB below the other (paper/impl_notes/sonifier.md section 10).
   */
  LevelModel.prototype.duetLevels = function (A, B, band, ell, semis, levelMode, duetLevel) {
    const o = this.o, fA = duetFreq(ell, false), fB = fA * Math.pow(2, (semis || 0) / 12);
    const comp = function (f) { return o.loudComp ? loudnessCompDb(f, o.phon, o.capDb) : 0; };
    if (duetLevel === 'data') {
      const tag = function (lv, f) { lv.f = f; lv.compDb = comp(f); lv.mode = 'data'; return lv; };
      return { A: tag(this.voiceLevel(A, band, ell, levelMode, 'duet', 0), fA),
        B: tag(this.voiceLevel(B, band, ell, levelMode, 'duet', semis || 0), fB),
        cue: tag(this.voiceLevel(B, band, ell, levelMode, 'duet', 0), fA) };
    }
    const top = o.loudComp ? duetCompMaxDb(o.phon, o.capDb) : 0;
    const common = function (f) {
      const c = o.loudComp ? comp(f) - top : 0, db = DUET.COMMON_DB + c, ratio = Math.pow(10, db / 20);
      return { rms: L_REF * ratio, ratio: ratio, db: db, amp: null, ref: null, f: f, compDb: c, mode: 'common' };
    };
    return { A: common(fA), B: common(fB), cue: common(fA) };
  };

  // ==========================================================================
  // 2.2 Synthesis: shaped noise (IFFT), additive partials, scale layers
  // ==========================================================================
  function bufferLength() { return 1 << BUFFER_LOG2; }
  /**
   * Target PSD per Hz on the rfft bins of an N-sample buffer:
   *   S(f) = scale2 * D(l(f)) / (ALPHA f) for f(l_lo) <= f <= f(l_hi), else 0,
   * so that the variance in d ln f is scale2 * D dln l.
   */
  function buildTargetPSD(o) {
    const N = o.N, sr = o.sampleRate, half = N >> 1, df = sr / N, g = o.grid || makeGrid(o.ell);
    const fLo = ellToFreq(Math.max(o.ellLo || ELL_MIN, ELL_MIN)), fHi = ellToFreq(Math.min(o.ellHi || ELL_MAX, ELL_MAX));
    const f = new Float64Array(half + 1), psd = new Float64Array(half + 1);
    let j = 0;
    for (let k = 0; k <= half; k++) {
      const fk = k * df;
      f[k] = fk;
      if (k === 0 || fk < fLo || fk > fHi) continue;
      const lnl = Math.log(ELL_MIN) + Math.log(fk / F_MIN) / ALPHA;
      while (j < g.n - 2 && g.lnEll[j + 1] <= lnl) j++;
      let Dv;
      if (lnl <= g.lnEll[0]) Dv = o.D[0];
      else if (lnl >= g.lnEll[g.n - 1]) Dv = o.D[g.n - 1];
      else { const t = (lnl - g.lnEll[j]) / (g.lnEll[j + 1] - g.lnEll[j]); Dv = o.D[j] + t * (o.D[j + 1] - o.D[j]); }
      psd[k] = o.scale2 * Math.max(Dv, 0) / (ALPHA * fk);
    }
    return { f: f, psd: psd, df: df };
  }
  function _finish(Xre, Xim, N) {
    const x = irfft(Xre, Xim, N), out = new Float32Array(N);
    for (let i = 0; i < N; i++) out[i] = x[i];
    return out;
  }
  /**
   * Right channel of a correlated stereo pair (o.rho = rho(l) on the cl_data grid, from
   * stereoCoherence): phase offsets delta_k = s_k arccos(rho(l(f_k))) with seeded signs s_k = +-1,
   * added to the left channel's phases. Every bin's zero-lag correlation between L and R is then
   * cos(delta_k) = rho, so the interaural coherence follows the data and the mono fold-down L + R has
   * power |X_L|^2 + |X_R|^2 + 2 rho |X_L||X_R| in each bin (the mixed field's power), while each
   * channel keeps its exact magnitude spectrum. The random signs keep R from lagging L systematically.
   */
  function _stereoDelta(o, half, df, g) {
    if (!o.rho) return null;
    const rng = mulberry32(hashSeed(o.seed >>> 0, 'stereoR')), d = new Float64Array(half + 1);
    for (let k = 0; k <= half; k++) {
      const s = rng() < 0.5 ? -1 : 1;
      if (k === 0) continue;
      d[k] = s * Math.acos(clamp(interpLn(g.lnEll, o.rho, Math.log(freqToEll(k * df))), -1, 1));
    }
    return d;
  }
  /**
   * Shaped noise: |X_k| = (N/2) sqrt(2 S(f_k) df), seeded uniform phases, inverse FFT. Circular, so
   * the buffer loops seamlessly. A phase is drawn for every bin, so changing the range or the
   * spectrum never changes the phases of the other bins (buffers with the same seed share phases).
   * o: {ell|grid, D, sampleRate, N, ellLo, ellHi, scale2, seed, rho (right channel, optional)}
   */
  function synthShapedNoise(o) {
    const N = o.N, half = N >> 1, t = buildTargetPSD(o);
    const rng = mulberry32(hashSeed(o.seed >>> 0, 'noise'));
    const delta = _stereoDelta(o, half, t.df, o.grid || makeGrid(o.ell));
    const Xre = new Float64Array(half + 1), Xim = new Float64Array(half + 1);
    for (let k = 0; k <= half; k++) {
      const ph = 2 * Math.PI * rng() + (delta ? delta[k] : 0);
      if (t.psd[k] <= 0 || k === half) continue;
      const A = half * Math.sqrt(2 * t.psd[k] * t.df);
      Xre[k] = A * Math.cos(ph); Xim[k] = A * Math.sin(ph);
    }
    return _finish(Xre, Xim, N);
  }
  /**
   * Additive partials: spacing 'semitone' (f = 40 Hz * 2^(j/12), each partial carrying the band power
   * of its 1/12-octave bin) or 'grid' (one partial per cl_data grid point, as sonify_cosmo.py).
   * Returns [{f, ell, power}] with power = integral D dln l over the partial's bin within [ellLo, ellHi].
   */
  function additivePartials(o) {
    const g = o.grid || makeGrid(o.ell), lo = Math.log(Math.max(o.ellLo || ELL_MIN, ELL_MIN));
    const hi = Math.log(Math.min(o.ellHi || ELL_MAX, ELL_MAX)), out = [];
    function add(f, la, lb) {
      const a = Math.max(la, lo), b = Math.min(lb, hi);
      out.push({ f: f, ell: freqToEll(f), power: b > a ? integrateLn(g.lnEll, o.D, a, b) : 0 });
    }
    if (o.spacing === 'grid') {
      for (let i = 0; i < g.n; i++) {
        const la = i === 0 ? g.lnEll[0] : 0.5 * (g.lnEll[i - 1] + g.lnEll[i]);
        const lb = i === g.n - 1 ? g.lnEll[g.n - 1] : 0.5 * (g.lnEll[i] + g.lnEll[i + 1]);
        add(ellToFreq(g.ell[i]), la, lb);
      }
    } else {
      const J = Math.floor(12 * Math.log2(F_MAX / F_MIN) + 1e-9);
      for (let j = 0; j <= J; j++) {
        const fa = j === 0 ? F_MIN : F_MIN * Math.pow(2, (j - 0.5) / 12);
        const fb = j === J ? F_MAX : F_MIN * Math.pow(2, (j + 0.5) / 12);
        add(F_MIN * Math.pow(2, j / 12), Math.log(freqToEll(fa)), Math.log(freqToEll(fb)));
      }
    }
    return out;
  }
  /** Additive synthesis: each partial on an integer number of cycles per buffer, amp^2 = 2 scale2 P. */
  function synthAdditive(o) {
    const N = o.N, half = N >> 1, sr = o.sampleRate;
    const parts = additivePartials(o), rng = mulberry32(hashSeed(o.seed >>> 0, 'additive'));
    const delta = _stereoDelta(o, half, sr / N, o.grid || makeGrid(o.ell));
    const Xre = new Float64Array(half + 1), Xim = new Float64Array(half + 1);
    for (const p of parts) {
      const k = Math.max(1, Math.min(half - 1, Math.round(p.f * N / sr)));
      const ph = 2 * Math.PI * rng() + (delta ? delta[k] : 0);
      if (!(p.power > 0)) continue;
      const A = half * Math.sqrt(2 * o.scale2 * p.power);
      Xre[k] += A * Math.cos(ph); Xim[k] += A * Math.sin(ph);
    }
    return _finish(Xre, Xim, N);
  }
  /**
   * Acoustic peaks of a spectrum: local maxima of D smoothed by a Gaussian in ln l (sigma = 0.02),
   * kept if they stand at least `minProm` (5%) above the higher of the lowest points within
   * +-0.35 in ln l on either side (so cosmic-variance wiggles are rejected). Returns the first nMax
   * peak multipoles with lo <= l <= hi, rounded to integers. On the v2 CMB spectrum this gives
   * l = 220, 527, 813, 1125, 1411 in 100-2000. (A 5-point running mean on the v2 grid, as in
   * sonify_cosmo.cmb_peaks, returns cosmic-variance wiggles at l = 103, 109, 121 instead.)
   */
  function cmbPeaks(ell, D, lo, hi, nMax, opts) {
    opts = opts || {};
    const sig = opts.sigma || 0.02, minProm = opts.minProm == null ? 0.05 : opts.minProm, reach = opts.reach || 0.35;
    const g = makeGrid(ell), fg = fineGrid(2048), Df = resampleFine(g, D, fg);
    const K = Math.ceil(4 * sig / fg.dx), w = [];
    for (let j = -K; j <= K; j++) w.push(Math.exp(-0.5 * Math.pow(j * fg.dx / sig, 2)));
    const S = new Float64Array(fg.M);
    for (let i = 0; i < fg.M; i++) {
      let s = 0, ws = 0;
      for (let j = -K; j <= K; j++) { const k = i + j; if (k < 0 || k >= fg.M) continue; s += Df[k] * w[j + K]; ws += w[j + K]; }
      S[i] = s / ws;
    }
    const R = Math.round(reach / fg.dx), out = [];
    for (let i = 1; i < fg.M - 1; i++) {
      const l = Math.exp(fg.lnEll[i]);
      if (l < lo || l > hi || !(S[i] >= S[i - 1] && S[i] > S[i + 1])) continue;
      let lmin = Infinity, rmin = Infinity;
      for (let j = 1; j <= R; j++) {
        if (i - j >= 0) lmin = Math.min(lmin, S[i - j]);
        if (i + j < fg.M) rmin = Math.min(rmin, S[i + j]);
      }
      if (S[i] / Math.max(lmin, rmin) - 1 >= minProm) out.push(Math.round(l));
      if (nMax && out.length >= nMax) break;
    }
    return out;
  }
  /**
   * Scale layers (= sonify_cosmo.py): l 2-100 -> one sine; l 100-1000 -> sines at the CMB acoustic
   * peaks weighted by sqrt(D) there; l 1000-6000 -> band-limited white noise. Each layer's variance =
   * scale2 * its band power within [ellLo, ellHi], and every layer sounds inside the part of its band
   * that lies in [ellLo, ellHi] (so no sound appears at audio frequencies of excluded l):
   *   layer 1: one sine at f(sqrt(a b)), [a, b] = [2, 100] clipped to the range;
   *   layer 2: the peaks (first three in 100-1000) that lie in the range; if none does, one sine at
   *            the geometric centre of [100, 1000] clipped to the range;
   *   layer 3: white noise over f([1000, 6000] clipped to the range).
   * Timbres decorative, levels carry data.
   * o: {ell|grid, D, Dcmb, sampleRate, N, ellLo, ellHi, scale2, seed, rho (right channel, optional)}
   */
  function synthLayers(o) {
    const N = o.N, half = N >> 1, sr = o.sampleRate, g = o.grid || makeGrid(o.ell);
    const lo = Math.max(o.ellLo || ELL_MIN, ELL_MIN), hi = Math.min(o.ellHi || ELL_MAX, ELL_MAX);
    const clip = LAYER_BANDS.map(function (bd) { return [Math.max(bd[0], lo), Math.min(bd[1], hi)]; });
    const P = clip.map(function (c) { return c[1] > c[0] ? bandPower(g, o.D, c[0], c[1]) : 0; });
    const rng = mulberry32(hashSeed(o.seed >>> 0, 'layers'));
    const delta = _stereoDelta(o, half, sr / N, g);
    const Xre = new Float64Array(half + 1), Xim = new Float64Array(half + 1);
    // a tone on the FFT bin nearest f, kept inside f([a, b]) (a loop has whole cycles only)
    function put(f, A, ph, a, b) {
      let k = Math.max(1, Math.min(half - 1, Math.round(f * N / sr)));
      const ka = Math.ceil(ellToFreq(a) * N / sr), kb = Math.floor(ellToFreq(b) * N / sr);
      if (kb >= ka) k = clamp(k, ka, kb);
      if (delta) ph += delta[k];
      Xre[k] += half * A * Math.cos(ph); Xim[k] += half * A * Math.sin(ph);
      return k * sr / N;
    }
    const info = { powers: P, bands: clip, f1: 0, peaks: [], f3: [0, 0] };
    // layer 1
    const ph1 = 2 * Math.PI * rng();
    if (P[0] > 0) info.f1 = put(ellToFreq(Math.sqrt(clip[0][0] * clip[0][1])), Math.sqrt(2 * o.scale2 * P[0]), ph1, clip[0][0], clip[0][1]);
    // layer 2: three phases are drawn whatever the range, so the stream does not depend on it
    const peaksAll = cmbPeaks(g.ell, o.Dcmb || o.D, LAYER_BANDS[1][0], LAYER_BANDS[1][1], 3);
    const ph2 = [0, 1, 2].map(function () { return 2 * Math.PI * rng(); });
    let peaks = peaksAll.filter(function (l) { return l >= clip[1][0] && l <= clip[1][1]; });
    if (!peaks.length && P[1] > 0) peaks = [Math.sqrt(clip[1][0] * clip[1][1])];
    const w = peaks.map(function (l) { return Math.sqrt(Math.max(dlAt(g, o.D, l), 0)); });
    const wn = Math.sqrt(w.reduce(function (s, v) { return s + v * v; }, 0));
    for (let i = 0; i < peaks.length; i++) {
      let f = ellToFreq(peaks[i]);
      if (wn > 0 && P[1] > 0) f = put(f, (w[i] / wn) * Math.sqrt(2 * o.scale2 * P[1]), ph2[i % 3], clip[1][0], clip[1][1]);
      info.peaks.push({ ell: peaks[i], f: f, weight: wn > 0 ? w[i] / wn : 0 });
    }
    // layer 3: flat |X| in the band (white), total variance scale2 * P3
    const a3 = clip[2][0], b3 = clip[2][1];
    const k0 = Math.ceil(ellToFreq(a3) * N / sr), k1 = Math.floor(ellToFreq(b3) * N / sr);
    const rng3 = mulberry32(hashSeed(o.seed >>> 0, 'layers3'));
    info.f3 = [k0 * sr / N, k1 * sr / N];
    if (b3 > a3 && k1 >= k0 && P[2] > 0) {
      const A = half * Math.sqrt(2 * o.scale2 * P[2] / (k1 - k0 + 1));
      for (let k = 0; k <= half; k++) {
        const ph = 2 * Math.PI * rng3() + (delta ? delta[k] : 0);
        if (k < k0 || k > k1) continue;
        Xre[k] += A * Math.cos(ph); Xim[k] += A * Math.sin(ph);
      }
    }
    const x = _finish(Xre, Xim, N);
    x.info = info;
    return x;
  }

  // ==========================================================================
  // 2.5 / 2.8 Sweep timing (a pure function of audio time)
  // ==========================================================================
  /** Sweep position in [0, 1] at time t after the start, period = one pass. */
  function sweepPos(t, period, pingPong) {
    if (!(period > 0)) return 0;
    const u = Math.max(t, 0) / period;
    if (pingPong) { const ph = u % 2; return ph <= 1 ? ph : 2 - ph; }
    return u % 1;
  }
  /** l at sweep position pos between lo and hi (log by default, or linear in l). */
  function sweepEll(pos, lo, hi, linear) { return linear ? lo + pos * (hi - lo) : lo * Math.pow(hi / lo, pos); }
  /** Inverse of sweepEll. */
  function sweepPosOfEll(ell, lo, hi, linear) {
    return clamp(linear ? (ell - lo) / (hi - lo) : Math.log(ell / lo) / Math.log(hi / lo), 0, 1);
  }

  // ==========================================================================
  // 2.6 Duet: correlation -> interval (ordered by sensory dissonance), register, tone, significance gate
  // ==========================================================================
  // Ladder. From r = +1 to r = -1, ordered by Sethares' sensory dissonance of two harmonic tones in
  // 12-TET AT THE PITCH WHERE THE DUET PLAYS, which must hold at every one of those pitches, not only on
  // average. Over the v2.1 register (root 110-7040 Hz) P8 < P5 < TT < m2 was the longest 12-TET ladder
  // strictly monotone at every quarter tone for all 24 timbre variants tested (5-8 harmonics, roll-off
  // 0.7/0.88/1, min or product rule; kept as a control in tests/core.test.js). In the v2.2 register
  // (110-880 Hz, below) the duet tone would allow six rungs (P8 P5 M6 m6 TT m2); four are kept for wider
  // margins, the instrument option and absolute-identification limits (about.html#ladder). The v2.0
  // ladder P8 P5 P4 m6 TT M2 m2 had m6 > TT above ~590 Hz. Spec order kept (P8 ... P5 ... TT ... m2);
  // r ~ +1 is the octave: no unison rung, and the gated state plays no unison either (see duetGateMix).
  //
  // Register and tone (v2.2; paper/design_rationale.md 1a.7 items 1 and 2). v2.1 played the duet on the
  // 5-octave musical map (root 110-7040 Hz) with the instrument voices, whose body low-passes leave
  // nearly pure tones above ~1 kHz: there the fifth and the tritone differ little in roughness, and the
  // top of the range lies beyond the upper limit of musical pitch for pure tones. Now:
  //  - Pitch map (duetFreq): f_A = DUET.BASE_HZ (l/2)^DUET_GAMMA, DUET_GAMMA = DUET.OCTAVES ln2 / ln 3000
  //    = 0.2597: l 2..6000 -> 110..880 Hz (A2..A5), voice B = f_A 2^(semis/12) <= 1760 Hz (an octave
  //    above 880 Hz). No band offsets: with the musical map's pentatonic offsets (up to an octave for 6
  //    bands, 17 semitones for 8) a 3-octave register would leave 2 octaves or less per band, and the
  //    bounds would depend on how many bands the data have. The band is heard through r (e.g. the tSZ
  //    sign flip at 217 GHz), not through pitch. Snapping (pentatonic) keeps f_A in [110, 880] Hz: both
  //    ends are A's, which are scale notes.
  //  - Tone (duetToneAmps): both voices play ONE harmonic complex tone, DUET.N_HARM harmonics with
  //    amplitudes DUET.ROLLOFF^(k-1), no body filters, RMS-calibrated like every voice. Band-limited by
  //    construction: the highest partial is 8 x 1760 = 14.1 kHz, below the Nyquist frequency of any
  //    context at >= 32 kHz. For this tone P8 < P5 < TT < m2 holds at every quarter tone of the
  //    register (min and product rule, both Sethares parameter sets; with the min rule also with voice B
  //    3 to 40 dB below or 20 dB above A), and the smallest P8-P5 / P5-TT gaps are 12 / 21 per cent of
  //    the largest m2 roughness in the register (min rule; 12 / 22 with the product rule), both at the
  //    880 Hz top (paper/analysis/ladder_roughness.json 'A0_duet_tone_v22'; tests/core.test.js test 5).
  //
  // Levels (v2.2; paper/impl_notes/sonifier.md section 10). By default ('common') both voices, and the
  // noise cue that replaces voice B, play at ONE constant level, DUET.COMMON_DB re L_REF: with data-driven
  // levels one voice was often 20-60 dB below the other (B and its cue 47-59 dB below A in the default
  // CMB x tSZ duet at 143 GHz), and the interval carries r only if both voices are heard. The data levels
  // ('data': Absolute or Equalized, LevelModel.voiceLevel) stay as a labelled option. COMMON_DB = -5 dB is
  // the largest whole-dB level whose peak stays below the Equalized duet's (-6.18 dBFS, rendered) even if
  // the crests of voice A, B's tone and the cue coincide (tone crest 8.79 dB, cue loop <= 14.0 dB at seeds 42, 1, 7;
  // worst -6.42 dBFS; up to 15.5 dB and -5.6 dBFS at other seeds). Rendered peaks, bound: sonifier.md section 10;
  // pinned in tests/core.test.js ('duet levels').
  const DUET = Object.freeze({ BASE_HZ: 110, OCTAVES: 3, N_HARM: 8, ROLLOFF: 0.88, COMMON_DB: -5 });
  const DUET_LEVELS = ['common', 'data'];
  const DUET_GAMMA = DUET.OCTAVES * Math.LN2 / LN_ELL_RANGE;  // 0.2597
  /** Duet root pitch (voice A): f = 110 Hz (l/2)^DUET_GAMMA, l clamped to [2, 6000]; optionally snapped. */
  function duetFreq(ell, snap) {
    const f = DUET.BASE_HZ * Math.pow(clamp(ell, ELL_MIN, ELL_MAX) / ELL_MIN, DUET_GAMMA);
    return snap ? quantizeToScale(f) : f;
  }
  /** Amplitudes of the duet tone's harmonics 1..DUET.N_HARM: ROLLOFF^(k-1) (the PeriodicWave coefficients). */
  function duetToneAmps() {
    const a = [];
    for (let k = 1; k <= DUET.N_HARM; k++) a.push(Math.pow(DUET.ROLLOFF, k - 1));
    return a;
  }
  const DUET_LADDER = [
    { semis: 12, name: 'octave' }, { semis: 7, name: 'perfect 5th' }, { semis: 6, name: 'tritone' },
    { semis: 1, name: 'minor 2nd' }];
  /** Pitches a duet voice can take above the root, in semitones: 0 (voice A, the cue) and every rung (voice B). */
  const DUET_PITCH_OFFSETS = [0].concat(DUET_LADDER.map(function (r) { return r.semis; }));
  /**
   * Largest ISO 226 gain (loudnessCompDb) at any pitch a duet voice can take on the unsnapped duet map:
   * 110 Hz to an octave above 880 Hz. The contour is linear in log f between its table frequencies, so the
   * maximum lies at an end of the range or at a table frequency inside it (+17.3 dB at 110 Hz for 60 phon).
   */
  function duetCompMaxDb(phon, capDb) {
    const lo = DUET.BASE_HZ, hi = DUET.BASE_HZ * Math.pow(2, DUET.OCTAVES + 1);
    let m = Math.max(loudnessCompDb(lo, phon, capDb), loudnessCompDb(hi, phon, capDb));
    for (const f of ISO226.f) if (f > lo && f < hi) m = Math.max(m, loudnessCompDb(f, phon, capDb));
    return m;
  }
  /**
   * Ladder rung for r: r cut into equal bins, idx = min(L - 1, floor((1 - r)/2 * L)), monotone in r.
   * With 4 rungs: r > 0.5 octave, 0 < r <= 0.5 fifth, -0.5 < r <= 0 tritone, r <= -0.5 minor second;
   * so positive correlations are consonant and negative ones dissonant.
   */
  function duetInterval(r) {
    const L = DUET_LADDER.length, idx = clamp(Math.floor((1 - clamp(r, -1, 1)) / 2 * L), 0, L - 1);
    return { idx: idx, semis: DUET_LADDER[idx].semis, name: DUET_LADDER[idx].name };
  }
  /** sigma_r ~ (1 - r^2) / sqrt(n_modes) (Gaussian full-sky fields). */
  function duetSigmaR(r, nModes) { return (1 - r * r) / Math.sqrt(Math.max(nModes, 1)); }
  /** Significance weight s in [0, 1]: 0 for |r| < 2 sigma (gate closed), rising to 1 at 3 sigma. */
  function duetGate(r, sigma) { return clamp(Math.abs(r) / Math.max(sigma, 1e-12) - 2, 0, 1); }
  /**
   * Gate state (v2.2): amplitude weights of voice B's tone and of the band-pass noise cue that replaces
   * it, at significance weight s: tone = sqrt(s), cue = sqrt(1 - s), so the power of B's tone plus the
   * cue's (uncorrelated) is voice B's data level at every s. |r| < 2 sigma (s = 0): no B tone at all,
   * only A + the cue (one tone plus noise, never an interval or a doubled unison); 2-3 sigma: the
   * interval fades in as the cue fades out (equal power at 2.5 sigma, s = 0.5); >= 3 sigma: the interval
   * alone. Voice B always sits at its interval above A (v2.1 dropped it to a unison at -6 dB, which in
   * the closest evaluated precedent, frid2021, means 'most coherent').
   */
  function duetGateMix(s) { s = clamp(s, 0, 1); return { tone: Math.sqrt(s), cue: Math.sqrt(1 - s) }; }
  /** Stereo spread in [0, 1]: (1 - r)/2, scaled by the significance weight (0 in the gated state). */
  function duetSpread(r, s) { return clamp((1 - r) / 2, 0, 1) * (s == null ? 1 : s); }
  /**
   * Sethares' parametrization of the Plomp-Levelt curve for two sine partials; amplitude weight
   * min(a1, a2) (Sethares 2005) or a1 a2 (Sethares 1993) with rule = 'prod'.
   */
  function setharesPair(f1, f2, a1, a2, rule) {
    const b1 = 3.5, b2 = 5.75, xs = 0.24, s1 = 0.0207, s2 = 18.96;
    const s = xs / (s1 * Math.min(f1, f2) + s2), d = Math.abs(f2 - f1);
    return (rule === 'prod' ? a1 * a2 : Math.min(a1, a2)) * (Math.exp(-b1 * s * d) - Math.exp(-b2 * s * d));
  }
  /**
   * Sensory dissonance of two harmonic tones (nHarm partials, amplitudes decay^(k-1)) a given interval
   * apart; partials above fMax (e.g. the Nyquist frequency of the render) are left out (default: none).
   */
  function dyadDissonance(f0, semis, nHarm, decay, rule, fMax) {
    nHarm = nHarm || 6; decay = decay == null ? 0.88 : decay; fMax = fMax || Infinity;
    const fr = [], am = [], f1 = f0 * Math.pow(2, semis / 12);
    for (let k = 1; k <= nHarm; k++) {
      if (f0 * k <= fMax) { fr.push(f0 * k); am.push(Math.pow(decay, k - 1)); }
      if (f1 * k <= fMax) { fr.push(f1 * k); am.push(Math.pow(decay, k - 1)); }
    }
    let d = 0;
    for (let i = 0; i < fr.length; i++) for (let j = i + 1; j < fr.length; j++) d += setharesPair(fr[i], fr[j], am[i], am[j], rule);
    return d;
  }
  /** Dyad dissonance minus that of the unison, averaged over f0 log-uniform in [lo, hi] (25 points). */
  function registerDissonance(semis, o) {
    o = o || {};
    const lo = o.lo || 110, hi = o.hi || 3520, nf = 25;
    let acc = 0;
    for (let i = 0; i < nf; i++) {
      const f0 = lo * Math.pow(hi / lo, i / (nf - 1));
      acc += dyadDissonance(f0, semis, o.nHarm, o.decay, o.rule) - dyadDissonance(f0, 0, o.nHarm, o.decay, o.rule);
    }
    return acc / nf;
  }

  // ==========================================================================
  // Crossfades and level calibration windows
  // ==========================================================================
  /**
   * Crossfade gains at progress p in [0, 1] from signal x (out) to y (in), given their correlation r
   * (clamped to [0, 1]): a = (1 - p)/n, b = p/n, n = sqrt((1 - p)^2 + p^2 + 2 r p (1 - p)). For two
   * signals of equal power the power of a x + b y is then the same at every p: r = 1 (coherent:
   * aligned buffers that share their phases) gives the linear law, r = 0 (unrelated signals) an
   * equal-power law, and partial correlations lie in between. No dip and no bump in either case.
   */
  function xfadeGains(p, r) {
    p = clamp(p, 0, 1); r = clamp(r || 0, 0, 1);
    const u = 1 - p, n = Math.sqrt(u * u + p * p + 2 * r * p * u);
    return { a: u / n, b: p / n };
  }
  /** Zero-lag correlation of two equally long arrays (sum x y / sqrt(sum x^2 sum y^2)); 0 if either is silent. */
  function correlation(x, y) {
    let sxy = 0, sxx = 0, syy = 0;
    const n = Math.min(x.length, y.length);
    for (let i = 0; i < n; i++) { sxy += x[i] * y[i]; sxx += x[i] * x[i]; syy += y[i] * y[i]; }
    return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
  }
  /**
   * Samples [i0, i1) of a calibration render over which a voice's RMS equals its long-term RMS: an
   * integer number of periods 2/f (every partial of a voice sits at a multiple of f/2: harmonics and
   * the bass sub-octave), starting after `skip` seconds (filter transients) and at most `len` long.
   */
  function periodicWindow(f, sampleRate, skip, len) {
    const P = 2 / f, K = Math.max(1, Math.floor(len / P)), i0 = Math.round(skip * sampleRate);
    return [i0, i0 + Math.round(K * P * sampleRate)];
  }

  // ==========================================================================
  // Big Bang (artistic): peaks from the data, Cramer-style linear scaling
  // ==========================================================================
  /** Peaks = local maxima of the CMB D_l in 150-2000; f = f_fund * l / l_peak1; amp = sqrt(D/Dmax). */
  function bigBangPlan(ell, Dcmb, fundamental) {
    fundamental = fundamental || 60;
    const g = makeGrid(ell), peaks = cmbPeaks(ell, Dcmb, 150, 2000, 0);
    const D = peaks.map(function (l) { return Math.max(dlAt(g, Dcmb, l), 0); });
    const Dmax = Math.max.apply(null, D.concat([1e-300]));
    return peaks.map(function (l, i) { return { ell: l, f: fundamental * l / peaks[0], amp: Math.sqrt(D[i] / Dmax) }; });
  }

  // ==========================================================================
  // Reverb impulse response (Musical preset, Big Bang): seeded
  // ==========================================================================
  function reverbIR(sampleRate, seconds, seed) {
    const n = Math.floor(sampleRate * seconds), out = [];
    for (let ch = 0; ch < 2; ch++) {
      const rng = mulberry32(hashSeed(seed >>> 0, 'reverb' + ch)), d = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const t = i / sampleRate;
        d[i] = (2 * rng() - 1) * Math.pow(1 - t / seconds, 3.5) * (0.7 + 0.3 * Math.sin(200 * t));
      }
      out.push(d);
    }
    return out;
  }

  // ==========================================================================
  // WAV encoding (PCM 16 or 24 bit, interleaved, little-endian)
  // ==========================================================================
  function encodeWAV(channels, sampleRate, bitDepth) {
    bitDepth = bitDepth === 24 ? 24 : 16;
    const nch = channels.length, n = channels[0].length, bps = bitDepth / 8;
    const dataBytes = n * nch * bps, buf = new ArrayBuffer(44 + dataBytes), dv = new DataView(buf);
    const u8 = new Uint8Array(buf);
    function str(o, s) { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); }
    str(0, 'RIFF'); dv.setUint32(4, 36 + dataBytes, true); str(8, 'WAVE');
    str(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, nch, true);
    dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * nch * bps, true);
    dv.setUint16(32, nch * bps, true); dv.setUint16(34, bitDepth, true);
    str(36, 'data'); dv.setUint32(40, dataBytes, true);
    const full = bitDepth === 24 ? 8388607 : 32767;
    let p = 44, clipped = 0, peak = 0;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < nch; c++) {
        let x = channels[c][i];
        if (!(x === x)) x = 0;
        const ax = Math.abs(x);
        if (ax > peak) peak = ax;
        if (x > 1) { x = 1; clipped++; } else if (x < -1) { x = -1; clipped++; }
        let v = Math.round(x * full);
        if (bitDepth === 16) { dv.setInt16(p, v, true); p += 2; }
        else { if (v < 0) v += 16777216; u8[p] = v & 255; u8[p + 1] = (v >> 8) & 255; u8[p + 2] = (v >> 16) & 255; p += 3; }
      }
    }
    return { bytes: u8, clipped: clipped, peak: peak };
  }

  // ==========================================================================
  // Exports
  // ==========================================================================
  const Core = {
    VERSION: VERSION,
    ELL_MIN: ELL_MIN, ELL_MAX: ELL_MAX, F_MIN: F_MIN, F_MAX: F_MAX, ALPHA: ALPHA, BETA: BETA,
    L_REF: L_REF, LOG_FLOOR_DB: LOG_FLOOR_DB, LN_ELL_RANGE: LN_ELL_RANGE, COMPONENTS: COMPONENTS,
    VOICED: VOICED, LEGACY_T_TOT_PARTS: LEGACY_T_TOT_PARTS, COMP_LABELS: COMP_LABELS, SHORT: SHORT, LAYER_BANDS: LAYER_BANDS, MUSICAL: MUSICAL,
    WINDOW_ORDER: WINDOW_ORDER, WINDOW_LEAK_DB: WINDOW_LEAK_DB, DUET_LADDER: DUET_LADDER, ISO226: ISO226,
    DUET: DUET, DUET_GAMMA: DUET_GAMMA, DUET_LEVELS: DUET_LEVELS, DUET_PITCH_OFFSETS: DUET_PITCH_OFFSETS,
    BUFFER_LOG2: BUFFER_LOG2, TSZ_NULL_GHZ: TSZ_NULL_GHZ, CIB_INTERBAND_R: CIB_INTERBAND_R, BAND_GROUPS: BAND_GROUPS,
    clamp: clamp,
    ellToFreq: ellToFreq, freqToEll: freqToEll,
    noteToFreq: noteToFreq, freqToNote: freqToNote, bandDegree: bandDegree, degreeSemis: degreeSemis,
    bandNote: bandNote, quantizeToScale: quantizeToScale, musicalFreq: musicalFreq,
    mulberry32: mulberry32, hashSeed: hashSeed, fnv1a32: fnv1a32, whiteNoise: whiteNoise,
    fft: fft, irfft: irfft, rfft: rfft,
    makeGrid: makeGrid, gridOf: gridOf, interpLn: interpLn, dlAt: dlAt, integrateLn: integrateLn, bandPower: bandPower,
    isFreqIndep: isFreqIndep, getSpectrum: getSpectrum, bandsOf: bandsOf, totalParts: totalParts, totalPartsLabel: totalPartsLabel,
    crossArray: crossArray, crossR: crossR, crossNModes: crossNModes, exactCross: exactCross,
    validateSelection: validateSelection, mixDl: mixDl, tszSign: tszSign, pairR: pairR, stereoCoherence: stereoCoherence,
    iso226At: iso226At, iso226Contour: iso226Contour, iso226SPL: iso226SPL, loudnessCompDb: loudnessCompDb,
    logMapAmp: logMapAmp, displayDensity: displayDensity,
    windowB: windowB, windowOrder: windowOrder, windowPower: windowPower, bandpassDesign: bandpassDesign,
    rbjBandpass: rbjBandpass, biquadPower: biquadPower, rbjBandpassNoiseGain: rbjBandpassNoiseGain,
    sweepFilterSettings: sweepFilterSettings, sweepFilterResponse: sweepFilterResponse, sweepFilterPower: sweepFilterPower,
    sweepCarrierMethod: sweepCarrierMethod,
    fineGrid: fineGrid, resampleFine: resampleFine, windowKernel: windowKernel, windowedPower: windowedPower,
    LevelModel: LevelModel,
    bufferLength: bufferLength, buildTargetPSD: buildTargetPSD, synthShapedNoise: synthShapedNoise,
    additivePartials: additivePartials, synthAdditive: synthAdditive, cmbPeaks: cmbPeaks, synthLayers: synthLayers,
    sweepPos: sweepPos, sweepEll: sweepEll, sweepPosOfEll: sweepPosOfEll,
    duetInterval: duetInterval, duetSigmaR: duetSigmaR, duetGate: duetGate, duetSpread: duetSpread,
    duetFreq: duetFreq, duetToneAmps: duetToneAmps, duetGateMix: duetGateMix, duetCompMaxDb: duetCompMaxDb,
    setharesPair: setharesPair, dyadDissonance: dyadDissonance, registerDissonance: registerDissonance,
    xfadeGains: xfadeGains, correlation: correlation, periodicWindow: periodicWindow,
    bigBangPlan: bigBangPlan, reverbIR: reverbIR, encodeWAV: encodeWAV,
  };
  // The small public surface named in the spec (window.SONIFY_API).
  Core.API = {
    version: VERSION, ellToFreq: ellToFreq, freqToEll: freqToEll, musicalFreq: musicalFreq, duetFreq: duetFreq,
    buildTargetPSD: buildTargetPSD, mixDl: mixDl, duetInterval: duetInterval, duetGate: duetGate,
    duetSigmaR: duetSigmaR, loudnessCompDb: loudnessCompDb, iso226SPL: iso226SPL, stereoCoherence: stereoCoherence,
    synthShapedNoise: synthShapedNoise, synthAdditive: synthAdditive, synthLayers: synthLayers,
    LevelModel: LevelModel, encodeWAV: encodeWAV, mulberry32: mulberry32,
  };
  return Core;
}));
