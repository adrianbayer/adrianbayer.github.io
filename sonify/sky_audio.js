/* sky_audio.js -- the Web Audio engine shared by the sky views (sky.html, globe.html, lightcone.html).
 *
 * Every data-carrying choice is a pure function in sky_core.js; this file only builds the audio
 * graph. Under Node it runs against a mock AudioContext (tests/sky_audio.test.js).
 *
 * Data -> sound (documented in paper/impl_notes/skyviews.md; the pages' Sound key shows the numbers):
 *  - one voice per component, fixed timbre, own register (CMB lowest ... CIB highest);
 *  - pitch from SIGNED dT (hot = high), register centre = the scale's centre value (the map median in the
 *    default scale, 0 muK in the physical ones; the engine receives dT - centre); loudness from |dT - empty|/sigma;
 *  - click: one note per voice, onsets staggered by STAGGER s in register order; optional
 *    reference tone at dT = 0 (register centre) just before each note;
 *  - scan: one continuous oscillator per voice; the path is resampled at a fixed angular spacing
 *    (SkyCore.ScanPath) and one sample is applied per control tick (CONTROL_RATE Hz) with
 *    setTargetAtTime, timed on the audio clock;
 *  - halo sounds (a bell): mass -> pitch (heavier = lower), comoving distance -> level ~ 1/chi, low-pass
 *    and a constant reverb send (falling direct-to-reverberant ratio); optional HRTF position;
 *  - 'artistic' halo sound ('hey!' or a recorded clip), off by default, level-normalized.
 * Gain staging: at the default volume, voices + a halo sound peak below -3 dBFS at 99.9 per cent of sky
 * positions (measured), 3 dB under the safety limiter (threshold 0 dBFS, knee 0, ratio 20, so its
 * Web Audio make-up gain is exactly 1); the limiter only catches the rest.
 */
(function (root, factory) {
  const core = root.SkyCore || (typeof require === 'function' ? require('./sky_core.js') : null);
  const api = factory(core);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SkyAudio = api;
})(typeof self !== 'undefined' ? self : this, function (C) {
  'use strict';

  // Gain staging (measured on the real maps, tests/sky_audio.test.js): with VOICE_BASE 0.3 and the
  // default volume 0.7, the summed peak of all voices at the 99.9th percentile of sky positions plus a
  // coincident halo sound stays below -3 dBFS (0.708), with equal loudness on or off, in every scale mode.
  // The limiter threshold is 0 dBFS with knee 0: a DynamicsCompressorNode applies a make-up gain
  // (1 / curve(1.0))^0.6 to everything (Web Audio spec), which is exactly 1 only when curve(1.0) = 1.
  // (Threshold -3 dB gave curve(1.0) = -2.85 dB, i.e. +1.71 dB above the computed levels.)
  const VOICE_BASE = 0.3;         // full-scale amplitude of one voice (after RMS normalization)
  const EQ_OFF_TRIM = 0.4;        // equal loudness off: same median level as on (measured ratio 0.36-0.42)
  const REF_REL = 0.2;            // reference tone level relative to a full-scale voice
  const EARCON_BASE = 0.25;      // data halo sound (bell) level; the identifier predates the name 'halo sound'
  const LIMIT_DB = 0;             // limiter threshold, dBFS (knee 0, ratio 20 -> unity make-up): a safety net only
  const DEFAULT_VOLUME = 0.7;
  const STAGGER = 0.04;           // s between voice onsets (register order)
  const NOTE_DUR = 0.45;          // s, click note
  const REF_DUR = 0.12, REF_GAP = 0.04;
  const CONTROL_RATE = 40;        // Hz, scan control ticks
  const GLIDE_TAU = 0.4 / CONTROL_RATE;
  const LOOKAHEAD = 0.1;          // s of audio-clock scheduling ahead of currentTime (survives main-thread stalls < 100 ms)
  const HEY_GAIN = 3.55;          // artistic 'hey!' level = the bell's level (peak 50-ms RMS)
  const CLIP_RMS = 0.35, CLIP_PEAK = 1.5;   // user clip: gated RMS target and peak cap (bell units)
  const REVERB = { seconds: 2.0, t60: 1.6, seed: 7, ret: 0.8 };   // DRR ~ +14 dB at chiRef, -2 dB at 3.2 Gpc/h

  function setParam(p, v, t) { if (p.setValueAtTime) p.setValueAtTime(v, t); else p.value = v; }

  function createSkyAudio(options) {
    options = options || {};
    // the scan scheduler's wake-up timer (injectable so tests can drive it on a mock clock);
    // parameter times always come from the audio clock (ctx.currentTime)
    const setI = options.setInterval || ((fn, ms) => setInterval(fn, ms));
    const clearI = options.clearInterval || ((id) => clearInterval(id));
    const E = {
      ctx: null, master: null, limiter: null, reverbIn: null, waves: {},
      volume: options.volume === undefined ? DEFAULT_VOLUME : options.volume,
      eq: options.eq === undefined ? true : !!options.eq,
      ref: !!options.ref, artistic: false,
      mute: new Set(), solo: new Set(),
      clipURL: null, clipBuf: null, clipGain: 0, rec: null,
    };
    const scan = { active: false, voices: {}, drones: {}, bus: null, panner: null, timer: null, nextT: 0,
      path: null, fns: null, first: true, comps: [] };

    // ------------------------------------------------------------------ graph
    function ensure() {
      if (E.ctx) {
        if (E.ctx.state === 'suspended' && E.ctx.resume) E.ctx.resume();
        return E.ctx;
      }
      const Ctor = options.AudioContext ||
        (typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext));
      if (!Ctor) return null;
      const ctx = E.ctx = new Ctor();
      E.master = ctx.createGain(); E.master.gain.value = E.volume;
      const L = E.limiter = ctx.createDynamicsCompressor();
      L.threshold.value = LIMIT_DB; L.knee.value = 0; L.ratio.value = 20; L.attack.value = 0.002; L.release.value = 0.15;
      E.master.connect(L); L.connect(ctx.destination);
      // seeded convolution reverb (distance cue for the halo sounds)
      const ir = C.reverbImpulse(ctx.sampleRate, REVERB.seconds, REVERB.t60, REVERB.seed);
      const buf = ctx.createBuffer(2, ir[0].length, ctx.sampleRate);
      buf.getChannelData(0).set(ir[0]); buf.getChannelData(1).set(ir[1]);
      const conv = ctx.createConvolver(); conv.normalize = false; conv.buffer = buf;
      E.reverbIn = ctx.createGain(); E.reverbIn.gain.value = 1;
      const ret = ctx.createGain(); ret.gain.value = REVERB.ret;
      E.reverbIn.connect(conv); conv.connect(ret); ret.connect(E.master);
      for (const comp in C.TIMBRES) {
        const h = C.TIMBRES[comp].harm, real = new Float32Array(h.length + 1), imag = new Float32Array(h.length + 1);
        for (let i = 0; i < h.length; i++) imag[i + 1] = h[i];
        E.waves[comp] = ctx.createPeriodicWave(real, imag, { disableNormalization: true });
      }
      if (E.clipURL) decodeClip(E.clipURL);
      return ctx;
    }

    function audible(comp) { return E.solo.size ? E.solo.has(comp) : !E.mute.has(comp); }
    /** Oscillator gain for a data voice at frequency f with data amplitude a in [0, 1]. */
    function voiceLevel(comp, f, a) {
      if (!audible(comp)) return 0;
      let g = VOICE_BASE * C.timbreRmsScale(C.TIMBRES[comp].harm) * a;
      g *= E.eq ? C.equalLoudnessGain(f) : EQ_OFF_TRIM;
      return g;
    }
    function refLevel(comp) {
      if (!audible(comp)) return 0;
      const f = C.registerCentre(comp);
      return VOICE_BASE * REF_REL * (E.eq ? C.equalLoudnessGain(f) : EQ_OFF_TRIM);
    }
    function sampleParams(s) {
      if (s.value === null || s.value === undefined || !isFinite(s.value)) return null;
      const f = C.voiceFreq(s.comp, s.value, s.pitchScale);
      const a = C.voiceAmp(s.value, s.empty, s.sigmaRef);
      return { f, a, g: voiceLevel(s.comp, f, a) };
    }
    function order(samples) {
      return samples.slice().sort((x, y) => C.VOICE_ORDER.indexOf(x.comp) - C.VOICE_ORDER.indexOf(y.comp));
    }

    function setPos(node, pos, t, tau) {
      if (node.positionX) {
        if (tau) {
          node.positionX.setTargetAtTime(pos[0], t, tau); node.positionY.setTargetAtTime(pos[1], t, tau);
          node.positionZ.setTargetAtTime(pos[2], t, tau);
        } else {
          setParam(node.positionX, pos[0], t); setParam(node.positionY, pos[1], t); setParam(node.positionZ, pos[2], t);
        }
      } else if (node.setPosition) node.setPosition(pos[0], pos[1], pos[2]);
    }
    /** HRTF panner at pos. rolloff 0 = direction only (a sky direction is 'at infinity');
     *  rolloff 1 with the inverse model = level ~ refDistance / distance. */
    function makePanner(pos, o) {
      const ctx = E.ctx, p = ctx.createPanner();
      p.panningModel = 'HRTF'; p.distanceModel = 'inverse';
      p.refDistance = (o && o.refDistance) || 1; p.rolloffFactor = (o && o.rolloff) || 0; p.maxDistance = 1e6;
      setPos(p, pos, ctx.currentTime);
      p.connect(E.master);
      return p;
    }
    function setListener(pos, fwd, up) {
      const ctx = E.ctx; if (!ctx) return;
      const L = ctx.listener, t = ctx.currentTime;
      if (L.positionX) {
        setParam(L.positionX, pos[0], t); setParam(L.positionY, pos[1], t); setParam(L.positionZ, pos[2], t);
        setParam(L.forwardX, fwd[0], t); setParam(L.forwardY, fwd[1], t); setParam(L.forwardZ, fwd[2], t);
        setParam(L.upX, up[0], t); setParam(L.upY, up[1], t); setParam(L.upZ, up[2], t);
      } else {
        if (L.setPosition) L.setPosition(pos[0], pos[1], pos[2]);
        if (L.setOrientation) L.setOrientation(fwd[0], fwd[1], fwd[2], up[0], up[1], up[2]);
      }
    }

    function tone(wave, f, g, t, dur, dest) {
      const ctx = E.ctx, o = ctx.createOscillator(), env = ctx.createGain();
      if (wave) o.setPeriodicWave(wave); else o.type = 'sine';
      setParam(o.frequency, f, t);
      setParam(env.gain, 0, t);
      env.gain.linearRampToValueAtTime(g, t + 0.015);
      env.gain.setValueAtTime(g, t + dur - 0.1);
      env.gain.setTargetAtTime(0, t + dur - 0.1, 0.025);
      o.connect(env); env.connect(dest);
      o.start(t); o.stop(t + dur + 0.1);
      o.onended = () => { try { env.disconnect(); } catch (e) { /* already gone */ } };
      return o;
    }

    // ------------------------------------------------------------------ click (point) notes
    /** samples: [{comp, value [muK], empty, pitchScale, sigmaRef}]. opts.position: [x,y,z] for an
     *  HRTF panner (direction only). Returns the schedule (for tests and the readout). */
    function playPoint(samples, opts) {
      const ctx = ensure(); if (!ctx) return null;
      opts = opts || {};
      const out = opts.position ? makePanner(opts.position, { rolloff: 0 }) : E.master;
      const t0 = ctx.currentTime + 0.02, sched = [];
      order(samples).forEach((s, k) => {
        const p = sampleParams(s); if (!p) return;
        let t = t0 + k * STAGGER;
        if (E.ref) {
          const gr = refLevel(s.comp);
          if (gr > 0) tone(null, C.registerCentre(s.comp), gr, t, REF_DUR, out);
          t += REF_DUR + REF_GAP;
        }
        if (p.g > 0) tone(E.waves[s.comp], p.f, p.g, t, NOTE_DUR, out);
        sched.push({ comp: s.comp, t, f: p.f, a: p.a, g: p.g });
      });
      if (out !== E.master) setTimeout(() => { try { out.disconnect(); } catch (e) { /* gone */ } },
        (NOTE_DUR + 0.5 + sched.length * STAGGER + (E.ref ? REF_DUR + REF_GAP : 0)) * 1000);
      return sched;
    }

    // ------------------------------------------------------------------ continuous scan
    function makeVoice(comp, t) {
      const ctx = E.ctx, o = ctx.createOscillator(), g = ctx.createGain();
      o.setPeriodicWave(E.waves[comp]);
      setParam(o.frequency, C.registerCentre(comp), t);
      setParam(g.gain, 0, t);
      o.connect(g); g.connect(scan.bus); o.start(t);
      return { o, g, comp };
    }
    function makeDrone(comp, t) {
      const ctx = E.ctx, o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; setParam(o.frequency, C.registerCentre(comp), t);
      setParam(g.gain, 0, t); g.gain.setTargetAtTime(refLevel(comp), t, 0.03);
      o.connect(g); g.connect(scan.bus); o.start(t);
      return { o, g, comp };
    }
    function fadeOut(v, t, fade) {
      v.g.gain.cancelScheduledValues(t); v.g.gain.setTargetAtTime(0, t, fade / 3);
      v.o.stop(t + fade + 0.05);
      v.o.onended = () => { try { v.g.disconnect(); } catch (e) { /* gone */ } };
    }
    /** (Re)build the scan voices for `comps`: new ones fade in (staggered), removed ones fade out. */
    function scanSetComps(comps) {
      if (!scan.active) { scan.comps = comps.slice(); return; }
      const t = E.ctx.currentTime;
      for (const c in scan.voices) if (comps.indexOf(c) < 0) { fadeOut(scan.voices[c], t, 0.08); delete scan.voices[c]; }
      for (const c in scan.drones) if (comps.indexOf(c) < 0 || !E.ref) { fadeOut(scan.drones[c], t, 0.08); delete scan.drones[c]; }
      for (const c of comps) {
        if (!scan.voices[c]) { scan.voices[c] = makeVoice(c, t); scan.voices[c].fresh = true; }
        if (E.ref && !scan.drones[c]) scan.drones[c] = makeDrone(c, t);
      }
      scan.comps = comps.slice();
    }
    /** Start (or retarget) a scan. path: SkyCore.ScanPath. fns.sample(theta, phi) -> samples;
     *  fns.onSample({theta, phi}, samples, params) at the moment the sample sounds;
     *  fns.position(theta, phi) -> [x,y,z] (optional, HRTF direction); fns.onStop(). */
    function scanStart(path, comps, fns) {
      const ctx = ensure(); if (!ctx) return false;
      scan.path = path; scan.fns = fns || {};
      if (!scan.active) {
        scan.bus = ctx.createGain(); scan.bus.gain.value = 1;
        if (scan.fns.position) {
          scan.panner = makePanner([0, 0, -1], { rolloff: 0 });
          scan.bus.connect(scan.panner);
        } else { scan.panner = null; scan.bus.connect(E.master); }
        scan.active = true; scan.voices = {}; scan.drones = {};
        scan.nextT = ctx.currentTime + 0.03;
        scan.timer = setI(tick, 1000 / CONTROL_RATE / 2);
      }
      scanSetComps(comps);
      return true;
    }
    function applySample(s, t) {
      const samples = scan.fns.sample ? scan.fns.sample(s.theta, s.phi) : [];
      const params = {};
      order(samples).forEach((smp, k) => {
        const v = scan.voices[smp.comp]; if (!v) return;
        const p = sampleParams(smp);
        const tg = v.fresh ? t + k * STAGGER : t;     // staggered onsets when a voice starts
        v.fresh = false;
        if (!p) { v.g.gain.setTargetAtTime(0, tg, GLIDE_TAU); return; }
        v.o.frequency.setTargetAtTime(p.f, t, GLIDE_TAU);
        v.g.gain.setTargetAtTime(p.g, tg, GLIDE_TAU);
        params[smp.comp] = p;
      });
      for (const c in scan.drones) scan.drones[c].g.gain.setTargetAtTime(refLevel(c), t, GLIDE_TAU);
      if (scan.panner && scan.fns.position) setPos(scan.panner, scan.fns.position(s.theta, s.phi), t, GLIDE_TAU);
      if (scan.fns.onSample) {
        const delay = Math.max(0, (t - E.ctx.currentTime) * 1000);
        setTimeout(() => scan.fns && scan.fns.onSample && scan.fns.onSample(s, samples, params), delay);
      }
    }
    function tick() {
      if (!scan.active) return;
      const ctx = E.ctx, now = ctx.currentTime;
      if (scan.nextT < now) scan.nextT = now + 0.005;      // the tab slept or the path was idle
      while (scan.nextT < now + LOOKAHEAD) {
        const s = scan.path.take();
        if (!s) { if (scan.path.inputDone) scanStop(); return; }
        applySample(s, scan.nextT);
        scan.nextT += 1 / CONTROL_RATE;
      }
    }
    function scanStop(fade) {
      if (!scan.active) return;
      fade = fade || 0.08;
      const t = E.ctx.currentTime;
      clearI(scan.timer); scan.timer = null;
      for (const c in scan.voices) fadeOut(scan.voices[c], t, fade);
      for (const c in scan.drones) fadeOut(scan.drones[c], t, fade);
      const bus = scan.bus, pan = scan.panner;
      setTimeout(() => { try { bus.disconnect(); if (pan) pan.disconnect(); } catch (e) { /* gone */ } }, (fade + 0.3) * 1000);
      scan.voices = {}; scan.drones = {}; scan.active = false;
      const fns = scan.fns; scan.fns = null;
      if (fns && fns.onStop) fns.onStop();
    }

    // ------------------------------------------------------------------ halo sounds
    /** h: {logM, chi [Mpc/h]}. opts.position: [x,y,z] (HRTF). opts.pannerDistance: true when the
     *  panner's inverse-distance model supplies the 1/chi level (lightcone; refDistance in scene
     *  units = DIST_CUE.chiRef); then opts.cueChi (Mpc/h, listener distance) sets the low-pass.
     *  With equal loudness ON, the data halo sound (the bell) gets the voices' ISO 226 gain at its fundamental
     *  (SkyCore.haloLoudnessGain: 1 at the top of the mass range, lower for lighter, higher-pitched
     *  clusters), so mass (pitch) does not leak into the distance (level) cue. The decorative artistic
     *  sounds are level-normalized instead and get no such gain. */
    function playHalo(h, opts) {
      const ctx = ensure(); if (!ctx) return null;
      opts = opts || {};
      const t = ctx.currentTime + 0.01;
      const f = C.massToFreq(h.logM);
      const cue = C.distanceCue(opts.cueChi === undefined ? h.chi : opts.cueChi);
      const eqGain = E.eq && !E.artistic ? C.haloLoudnessGain(f) : 1;
      const out = opts.position
        ? makePanner(opts.position, { rolloff: opts.pannerDistance ? 1 : 0, refDistance: opts.refDistance || 1 })
        : E.master;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 0.707;
      setParam(lp.frequency, cue.cutoffHz, t);
      const direct = ctx.createGain(); direct.gain.value = opts.pannerDistance ? 1 : cue.gain;
      const send = ctx.createGain(); send.gain.value = cue.reverbSend;
      const env = ctx.createGain(); env.gain.value = EARCON_BASE * eqGain;
      env.connect(lp); lp.connect(direct); direct.connect(out); lp.connect(send); send.connect(E.reverbIn);
      let end;
      if (E.artistic) end = artisticSound(f, env, t);
      else {
        end = t + 1.4;
        C.EARCON.ratios.forEach((r, i) => {
          const o = ctx.createOscillator(), g = ctx.createGain();
          o.type = 'sine'; setParam(o.frequency, f * r, t);
          setParam(g.gain, 0, t);
          g.gain.linearRampToValueAtTime(C.EARCON.amps[i], t + C.EARCON.attack);
          g.gain.setTargetAtTime(0, t + C.EARCON.attack, C.EARCON.decay[i]);
          o.connect(g); g.connect(env); o.start(t); o.stop(end);
        });
      }
      setTimeout(() => {
        try { env.disconnect(); lp.disconnect(); direct.disconnect(); send.disconnect(); if (out !== E.master) out.disconnect(); }
        catch (e) { /* gone */ }
      }, (end - ctx.currentTime + 2.2) * 1000);
      return { f, cue, t, artistic: E.artistic, eqGain };
    }

    // 'artistic' halo sound: a synthesized "hey!" or the user's clip, pitch-shifted by the same
    // mass ratio as the bell, level-normalized. Decorative; off by default.
    const ART_REF_HZ = C.massToFreq(14.85);
    function artisticSound(f, dest, t) {
      const ctx = E.ctx, r = f / ART_REF_HZ;
      if (E.clipBuf && E.clipGain > 0) {
        const s = ctx.createBufferSource(), g = ctx.createGain();
        s.buffer = E.clipBuf; s.playbackRate.value = r; g.gain.value = E.clipGain;
        s.connect(g); g.connect(dest); s.start(t);
        return t + E.clipBuf.duration / r + 0.05;
      }
      const o = ctx.createOscillator(); o.type = 'sawtooth';
      setParam(o.frequency, 300 * r, t);
      o.frequency.exponentialRampToValueAtTime(540 * r, t + 0.08);
      o.frequency.exponentialRampToValueAtTime(300 * r, t + 0.34);
      const f1 = ctx.createBiquadFilter(); f1.type = 'bandpass'; f1.frequency.value = 720; f1.Q.value = 5;
      const f2 = ctx.createBiquadFilter(); f2.type = 'bandpass'; f2.Q.value = 7;
      setParam(f2.frequency, 1650, t); f2.frequency.linearRampToValueAtTime(2200, t + 0.22);
      const g = ctx.createGain();
      // HEY_GAIN matches the bell's peak 50-ms RMS (simulated with RBJ biquads, as Web Audio's
      // BiquadFilter: bell 0.694, hey 0.195 at unit gain -> 3.55)
      setParam(g.gain, 0, t); g.gain.linearRampToValueAtTime(HEY_GAIN, t + 0.03);
      g.gain.setValueAtTime(HEY_GAIN, t + 0.18); g.gain.exponentialRampToValueAtTime(0.001, t + 0.36);
      o.connect(f1); o.connect(f2); f1.connect(g); f2.connect(g); g.connect(dest);
      o.start(t); o.stop(t + 0.4);
      return t + 0.45;
    }
    function decodeClip(url) {
      const ctx = E.ctx; if (!ctx || typeof fetch === 'undefined') return;
      fetch(url).then(r => r.arrayBuffer()).then(ab => new Promise((ok, bad) => {
        const p = ctx.decodeAudioData(ab, ok, bad); if (p && p.then) p.then(ok, bad);
      })).then(buf => {
        const ch = []; for (let i = 0; i < buf.numberOfChannels; i++) ch.push(buf.getChannelData(i));
        E.clipBuf = buf; E.clipGain = C.clipNormGain(ch, CLIP_RMS, 10, CLIP_PEAK);
      }).catch(() => { E.clipBuf = null; });
    }
    function loadStoredClip() {
      try { const d = localStorage.getItem('haloSound'); if (d) { E.clipURL = d; if (E.ctx) decodeClip(d); } }
      catch (e) { /* storage blocked: no clip */ }
    }
    /** Record up to 3 s from the microphone as the artistic halo sound. onState('recording' |
     *  'idle' | 'nomic' | 'denied'). Stored in localStorage (shared by the sky pages). */
    function recordClip(onState) {
      onState = onState || function () {};
      if (typeof MediaRecorder === 'undefined' || typeof navigator === 'undefined' || !navigator.mediaDevices) {
        onState('nomic'); return;
      }
      if (E.rec && E.rec.state === 'recording') { E.rec.stop(); return; }
      navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
        const rec = new MediaRecorder(stream), chunks = [];
        rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
        rec.onstop = () => {
          stream.getTracks().forEach(t => t.stop());
          const fr = new FileReader();
          fr.onload = () => {
            try { localStorage.setItem('haloSound', fr.result); } catch (e) { /* too big or blocked */ }
            E.clipURL = fr.result; ensure(); decodeClip(fr.result);
          };
          fr.readAsDataURL(new Blob(chunks, { type: rec.mimeType || 'audio/webm' }));
          E.rec = null; onState('idle');
        };
        rec.start(); E.rec = rec; onState('recording');
        setTimeout(() => { if (E.rec && E.rec.state === 'recording') E.rec.stop(); }, 3000);
      }).catch(() => onState('denied'));
    }

    // ------------------------------------------------------------------ settings
    function setVolume(v) { E.volume = v; if (E.master) setParam(E.master.gain, v, E.ctx.currentTime); }
    function setEq(on) { E.eq = !!on; }
    function setRef(on) { E.ref = !!on; if (scan.active) scanSetComps(scan.comps); }
    function setArtistic(on) { E.artistic = !!on; }
    function setMuteSolo(mute, solo) { E.mute = new Set(mute || []); E.solo = new Set(solo || []); }

    return {
      ensure, playPoint, playHalo, scanStart, scanStop, scanSetComps, setListener,
      setVolume, setEq, setRef, setArtistic, setMuteSolo, recordClip, loadStoredClip,
      get ctx() { return E.ctx; }, get scanning() { return scan.active; }, get state() { return E; },
      // exposed for tests / docs
      _voiceLevel: voiceLevel, _refLevel: refLevel,
    };
  }

  return { createSkyAudio, VOICE_BASE, EQ_OFF_TRIM, LIMIT_DB, DEFAULT_VOLUME, REF_REL, EARCON_BASE, HEY_GAIN, CLIP_RMS, CLIP_PEAK, STAGGER, NOTE_DUR, REF_DUR, REF_GAP, CONTROL_RATE,
    GLIDE_TAU, LOOKAHEAD, REVERB };
});
