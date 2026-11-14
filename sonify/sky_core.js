/* sky_core.js -- pure helpers shared by the sky views (sky.html, globe.html, lightcone.html).
 *
 * No DOM and no Web Audio here, so every function can be unit-tested under Node
 * (tests/sky_core.test.js). Loaded in the browser with <script src="sky_core.js"> as the
 * global `SkyCore`; in Node with require('../web/sky_core.js').
 *
 * Conventions (one per quantity; the same in the plot, the audio and the paper):
 *  - Sky coordinates are the simulation's HEALPix (theta, phi): theta = colatitude in [0, pi]
 *    (theta = 0 is the simulation north pole), phi = longitude in [0, 2 pi). NOT Galactic (l, b).
 *  - Display JPEGs are equirectangular: row 0 is theta = 0, phi increases to the right from 0 at the
 *    left edge (export_sky_images.py). Pixel centres: theta_i = (i + 0.5) pi / H, phi_j = (j + 0.5) 2 pi / W.
 *  - Value maps (sky_img.json version 3) are equal-area HEALPix maps, RING ordering, in the same
 *    (theta, phi) frame: the value at (theta, phi) is that of pixel ang2pixRing(nside, theta, phi)
 *    (healpy.ang2pix), the mean of the field over that pixel; no interpolation.
 *  - 3D: the three.js r128 SphereGeometry convention, which places the texture's top row (theta = 0)
 *    at +y:  x = -r cos(phi) sin(theta),  y = +r cos(theta),  z = r sin(phi) sin(theta).
 *    (Verified against the r128 source: SphereGeometry vertex/uv code + Texture.flipY = true.)
 *  - Temperatures in muK (thermodynamic, beam-convolved, monopole kept).
 */
(function (root, factory) {
  // ISO 226 and the seeded PRNG are shared with the sonifier: they come from sonify_core.js
  // (browser: load <script src="sonify_core.js"> before this file; Node: required here).
  const node = typeof module === 'object' && module.exports;
  const api = factory(node ? require('./sonify_core.js') : root.SonifyCore);
  if (node) module.exports = api;
  else root.SkyCore = api;
})(typeof self !== 'undefined' ? self : this, function (SonifyCore) {
  'use strict';
  if (!SonifyCore) throw new Error('sky_core.js needs sonify_core.js (load it first)');

  const VERSION = '2.2.0';
  const TWO_PI = 2 * Math.PI;
  const DEG = Math.PI / 180;

  // ======================================================================================
  // PNG decoding (grayscale, 8 or 16 bit, non-interlaced) without canvas getImageData.
  // Canvas reads can be perturbed by anti-fingerprinting and are 8-bit only, so the value
  // maps are fetched as bytes and decoded here; the zlib stream is inflated by an injected
  // function (browser: DecompressionStream('deflate'); Node: zlib.inflateSync).
  // ======================================================================================
  const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];

  function readU32(b, p) {
    return ((b[p] << 24) >>> 0) + (b[p + 1] << 16) + (b[p + 2] << 8) + b[p + 3];
  }

  /** Split a PNG into its header fields and IDAT payloads. Throws on anything unexpected. */
  function parsePNG(bytes) {
    if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
    for (let i = 0; i < 8; i++) if (bytes[i] !== PNG_SIG[i]) throw new Error('not a PNG file');
    let p = 8, hdr = null, total = 0, sawEnd = false;
    const idat = [];
    while (p + 8 <= bytes.length) {
      const len = readU32(bytes, p);
      const type = String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7]);
      const d0 = p + 8, d1 = d0 + len;
      if (d1 + 4 > bytes.length) throw new Error('truncated PNG chunk ' + type);
      if (type === 'IHDR') {
        hdr = {
          width: readU32(bytes, d0), height: readU32(bytes, d0 + 4), bitDepth: bytes[d0 + 8],
          colorType: bytes[d0 + 9], compression: bytes[d0 + 10], filter: bytes[d0 + 11], interlace: bytes[d0 + 12],
        };
      } else if (type === 'IDAT') {
        idat.push(bytes.subarray(d0, d1)); total += len;
      } else if (type === 'IEND') { sawEnd = true; break; }
      p = d1 + 4;                                   // skip CRC
    }
    if (!hdr) throw new Error('PNG has no IHDR');
    if (!sawEnd) throw new Error('PNG has no IEND');
    if (!idat.length) throw new Error('PNG has no IDAT');
    const zdata = new Uint8Array(total);
    let o = 0;
    for (const c of idat) { zdata.set(c, o); o += c.length; }
    return Object.assign(hdr, { zdata });
  }

  function paeth(a, b, c) {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
  }

  /** Reverse the per-row PNG filters (types 0-4). raw: inflated bytes, h rows of (1 + stride).
   *  bpp: bytes per complete pixel (2 for 16-bit gray). Returns h*stride unfiltered bytes. */
  function unfilter(raw, width, height, bpp) {
    const stride = width * bpp;
    if (raw.length < height * (stride + 1)) throw new Error('PNG image data too short');
    const out = new Uint8Array(height * stride);
    for (let y = 0; y < height; y++) {
      const f = raw[y * (stride + 1)], s = y * (stride + 1) + 1, r = y * stride, q = r - stride;
      switch (f) {
        case 0: out.set(raw.subarray(s, s + stride), r); break;
        case 1:
          for (let i = 0; i < stride; i++) out[r + i] = (raw[s + i] + (i >= bpp ? out[r + i - bpp] : 0)) & 255;
          break;
        case 2:
          for (let i = 0; i < stride; i++) out[r + i] = (raw[s + i] + (y ? out[q + i] : 0)) & 255;
          break;
        case 3:
          for (let i = 0; i < stride; i++) {
            const a = i >= bpp ? out[r + i - bpp] : 0, b = y ? out[q + i] : 0;
            out[r + i] = (raw[s + i] + ((a + b) >> 1)) & 255;
          }
          break;
        case 4:
          for (let i = 0; i < stride; i++) {
            const a = i >= bpp ? out[r + i - bpp] : 0, b = y ? out[q + i] : 0;
            const c = (y && i >= bpp) ? out[q + i - bpp] : 0;
            out[r + i] = (raw[s + i] + paeth(a, b, c)) & 255;
          }
          break;
        default: throw new Error('bad PNG filter type ' + f + ' in row ' + y);
      }
    }
    return out;
  }

  /** Decode a grayscale PNG. inflate(Uint8Array) -> Uint8Array or Promise of one.
   *  Returns {width, height, bitDepth, samples: Uint16Array (16-bit) or Uint8Array (8-bit)}. */
  async function decodePNGGray(bytes, inflate) {
    const h = parsePNG(bytes);
    if (h.colorType !== 0) throw new Error('value map must be grayscale (colour type 0), got ' + h.colorType);
    if (h.bitDepth !== 16 && h.bitDepth !== 8) throw new Error('unsupported bit depth ' + h.bitDepth);
    if (h.interlace !== 0) throw new Error('interlaced PNG not supported');
    const raw = await inflate(h.zdata);
    const bpp = h.bitDepth / 8;
    const px = unfilter(raw instanceof Uint8Array ? raw : new Uint8Array(raw), h.width, h.height, bpp);
    const n = h.width * h.height;
    let samples;
    if (h.bitDepth === 16) {
      samples = new Uint16Array(n);
      for (let j = 0; j < n; j++) samples[j] = (px[2 * j] << 8) | px[2 * j + 1];   // PNG is big-endian
    } else samples = px;
    return { width: h.width, height: h.height, bitDepth: h.bitDepth, samples };
  }

  /** Browser (and Node >= 18) zlib inflate through the Compression Streams API.
   *  PNG IDAT data is a zlib (RFC 1950) stream, which is what 'deflate' means here. */
  async function inflateStream(zbytes) {
    if (typeof DecompressionStream === 'undefined') {
      const err = new Error('this browser lacks DecompressionStream; sky values cannot be decoded');
      err.permanent = true;                         // retrying cannot help (createMapStore stops asking)
      throw err;
    }
    const stream = new Blob([zbytes]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // ======================================================================================
  // HEALPix (RING scheme): the value maps' pixelization. Exact ports of healpix_cxx 3
  // (T_Healpix_Base::ang2pix -> loc2pix, pix2loc), the code behind healpy.ang2pix/pix2ang, after
  // Gorski et al. (2005, ApJ 622, 759). Integers stay below 2^53 for any nside used here.
  // ======================================================================================
  const INV_HALFPI = 0.6366197723675813430755350534900574;   // 2 / pi, as healpix_cxx
  const TWOTHIRD = 2 / 3;
  /** healpix_cxx fmodulo: v1 mod v2 in [0, v2). */
  function fmodulo(v1, v2) {
    if (v1 >= 0) return v1 < v2 ? v1 : v1 % v2;
    const tmp = (v1 % v2) + v2;
    return tmp === v2 ? 0 : tmp;
  }
  function isqrt(x) {                                 // floor(sqrt(x)) for integers x >= 0
    let r = Math.floor(Math.sqrt(x));
    while (r * r > x) r--;
    while ((r + 1) * (r + 1) <= x) r++;
    return r;
  }
  /** RING index of the pixel containing (theta, phi) [rad] at this nside (= healpy.ang2pix(nside,
   *  theta, phi)). theta in [0, pi] (colatitude), any phi: like healpy (pointing::normalize before
   *  ang2pix) phi is first reduced to [0, 2 pi) with fmodulo, so a point on a pixel edge given with phi
   *  outside [0, 2 pi) lands where healpy puts it. Within 0.01 rad of a
   *  pole the polar-cap ring index uses sin(theta) instead of 1 - |cos(theta)| (as healpix_cxx).
   *  A point exactly on a pixel edge can land on either side when this engine's Math.cos differs
   *  from the C library's cos by one ulp (tests/sky_core.test.js shows that this is the only kind of
   *  difference from healpy). */
  function ang2pixRing(nside, theta, phi) {
    const haveSth = theta < 0.01 || theta > 3.14159 - 0.01;
    return loc2pixRing(nside, Math.cos(theta), fmodulo(phi, TWO_PI), haveSth ? Math.sin(theta) : 0, haveSth);
  }
  /** healpix_cxx loc2pix (RING) from z = cos(theta), phi and, near the poles, sth = sin(theta). */
  function loc2pixRing(nside, z, phi, sth, haveSth) {
    const za = Math.abs(z);
    const tt = fmodulo(phi * INV_HALFPI, 4.0);              // in [0, 4)
    if (za <= TWOTHIRD) {                                   // equatorial region
      const nl4 = 4 * nside;
      const temp1 = nside * (0.5 + tt), temp2 = nside * z * 0.75;
      const jp = Math.floor(temp1 - temp2);                 // index of the ascending edge line (>= 0)
      const jm = Math.floor(temp1 + temp2);                 // index of the descending edge line (>= 0)
      const ir = nside + 1 + jp - jm;                       // ring number counted from z = 2/3, in 1..2 nside + 1
      const kshift = 1 - (ir & 1);                          // 1 if ir is even
      const t1 = jp + jm - nside + kshift + 1 + nl4 + nl4;
      const ip = Math.floor(t1 / 2) % nl4;                  // in 0..4 nside - 1
      return 2 * nside * (nside - 1) + (ir - 1) * nl4 + ip;
    }
    const tp = tt - Math.floor(tt);                         // polar caps
    const tmp = (za < 0.99 || !haveSth) ? nside * Math.sqrt(3 * (1 - za))
      : nside * sth / Math.sqrt((1 + za) / 3);
    const jp = Math.floor(tp * tmp), jm = Math.floor((1 - tp) * tmp);
    const ir = jp + jm + 1;                                 // ring number counted from the closest pole
    const ip = Math.floor(tt * ir);                         // in 0..4 ir - 1
    return z > 0 ? 2 * ir * (ir - 1) + ip : 12 * nside * nside - 2 * ir * (ir + 1) + ip;
  }
  /** Centre {theta, phi} [rad] of RING pixel pix at this nside (= healpy.pix2ang(nside, pix)). */
  function pix2angRing(nside, pix) {
    const npix = 12 * nside * nside, ncap = 2 * nside * (nside - 1), fact2 = 4 / npix;
    let z, phi, sth = 0, haveSth = false;
    if (pix < ncap) {                                       // north polar cap
      const iring = (1 + isqrt(1 + 2 * pix)) >> 1, iphi = pix + 1 - 2 * iring * (iring - 1);
      const tmp = iring * iring * fact2;
      z = 1 - tmp;
      if (z > 0.99) { sth = Math.sqrt(tmp * (2 - tmp)); haveSth = true; }
      phi = (iphi - 0.5) * (Math.PI / 2) / iring;
    } else if (pix < npix - ncap) {                         // equatorial region
      const nl4 = 4 * nside, ip = pix - ncap, tmp = Math.floor(ip / nl4);
      const iring = tmp + nside, iphi = ip - nl4 * tmp + 1;
      const fodd = ((iring + nside) & 1) ? 1 : 0.5, fact1 = 2 * nside * fact2;
      z = (2 * nside - iring) * fact1;
      phi = (iphi - fodd) * Math.PI * 0.75 * fact1;
    } else {                                                // south polar cap
      const ip = npix - pix, iring = (1 + isqrt(2 * ip - 1)) >> 1;
      const iphi = 4 * iring + 1 - (ip - 2 * iring * (iring - 1));
      const tmp = iring * iring * fact2;
      z = tmp - 1;
      if (z < -0.99) { sth = Math.sqrt(tmp * (2 - tmp)); haveSth = true; }
      phi = (iphi - 0.5) * (Math.PI / 2) / iring;
    }
    return { theta: haveSth ? Math.atan2(sth, z) : Math.acos(z), phi };
  }
  /** Square root of the pixel area [rad] (the pixel 'size'; 6.87 arcmin at nside 512). */
  function healpixResolution(nside) { return Math.sqrt(4 * Math.PI / (12 * nside * nside)); }

  // ======================================================================================
  // Value maps: uint16 -> muK, and the value at (theta, phi)
  // ======================================================================================
  /** v [muK] = vmin + (vmax - vmin) u / 65535 (sky_img.json value_maps.decode). */
  function u16ToMicroK(u, vmin, vmax) { return vmin + (vmax - vmin) * u / 65535; }
  /** The pipeline's encoder (for tests and documentation): u = round(clip(v) ...). */
  function microKToU16(v, vmin, vmax) {
    const c = Math.min(vmax, Math.max(vmin, v));
    return Math.round((c - vmin) / (vmax - vmin) * 65535);
  }

  /** Check sky_img.json value_maps describes the HEALPix layout this code reads (version 3):
   *  RING ordering, nside a power of 2, PNG width 4 nside x height 3 nside (sample k = RING pixel k). */
  function checkValueLayout(vm) {
    const n = vm && vm.nside;
    if (!vm || vm.layout !== 'healpix' || vm.ordering !== 'RING') throw new Error('value maps must be HEALPix RING (sky_img.json value_maps)');
    if (!(Number.isInteger(n) && n >= 1 && (n & (n - 1)) === 0)) throw new Error('value_maps.nside ' + n + ' is not a power of 2');
    if (vm.width !== 4 * n || vm.height !== 3 * n) throw new Error('value_maps ' + vm.width + 'x' + vm.height + ' is not 4 nside x 3 nside');
    return n;
  }
  /** Bind a decoded 16-bit map to one sky_img.json entry (several entries may share a file).
   *  vm: sky_img.json value_maps (the layout). */
  function makeValueMap(entry, decoded, vm) {
    if (decoded.bitDepth !== 16) throw new Error(entry.file + ': value maps must be 16-bit');
    const nside = checkValueLayout(vm);
    if (decoded.width * decoded.height !== 12 * nside * nside) {
      throw new Error(entry.file + ': ' + decoded.width + 'x' + decoded.height + ' samples, not 12 nside^2 for nside ' + nside);
    }
    return {
      comp: entry.component, band: entry.band, file: entry.file,
      nside, npix: 12 * nside * nside, u16: decoded.samples,
      vmin: entry.vmin, vmax: entry.vmax, step: (entry.vmax - entry.vmin) / 65535,
      median: entry.median_uK, mean: entry.mean_uK, sigma: entry.sigma_uK,
      provisional: !!entry.provisional,
    };
  }

  function wrapPhi(phi) { phi %= TWO_PI; return phi < 0 ? phi + TWO_PI : phi; }

  /** Value [muK] at (theta, phi): the value of the HEALPix pixel that contains the point, i.e. the mean
   *  of the field over that equal-area pixel (no interpolation: the value is constant over a pixel). */
  function sampleMap(map, theta, phi) {
    return map.vmin + map.step * map.u16[ang2pixRing(map.nside, Math.min(Math.PI, Math.max(0, theta)), phi)];
  }
  /** Angular size [rad] of a value-map pixel (sqrt of its area), e.g. for the minimum scan spacing. */
  function valueMapResolution(meta) { return healpixResolution(checkValueLayout(meta.value_maps)); }

  /** Lazy loader for the value maps of one sky_img.json. opts: {base: URL prefix, fetch, inflate,
   *  onLoad(map), onError(err, entry), retryMs (default 30 s), now() (ms; default Date.now)}.
   *  Files shared by several entries (tSZ) are fetched and decoded once.
   *  get(comp, band) returns the map if ready, else null and starts loading -- unless that file
   *  failed: a failure is reported ONCE (onError) and get() does not ask again for retryMs (never,
   *  for a permanent failure such as a browser without DecompressionStream), so a scan calling
   *  get() at the control rate cannot cause a request storm. request(comp, band, {retry: true})
   *  is the explicit retry (a user action). error(comp, band) returns the last failure or null. */
  function createMapStore(meta, opts) {
    const files = new Map(), ready = new Map(), pending = new Map(), failed = new Map();
    const retryMs = opts.retryMs === undefined ? 30000 : opts.retryMs;
    const now = opts.now || (() => Date.now());
    const keyOf = (e) => e.component + '|' + (e.band == null ? '-' : e.band);
    /** The failure record of e's file if it still blocks automatic loading, else null. */
    function blocking(e) {
      const f = failed.get(e.file);
      return f && (f.err.permanent || now() - f.t < retryMs) ? f : null;
    }
    function request(comp, band, ropts) {
      const e = findMap(meta, comp, band);
      if (!e) return Promise.reject(new Error('no value map for ' + comp + ' at ' + band + ' GHz'));
      const k = keyOf(e);
      if (ready.has(k)) return Promise.resolve(ready.get(k));
      if (pending.has(k)) return pending.get(k);
      const f = blocking(e);
      if (f && !(ropts && ropts.retry)) return Promise.reject(f.err);
      let fp = files.get(e.file);
      if (!fp) {
        failed.delete(e.file);
        fp = Promise.resolve(opts.fetch(opts.base + e.file)).then((r) => {
          if (!r.ok) throw new Error(e.file + ': HTTP ' + r.status);
          return r.arrayBuffer();
        }).then((ab) => decodePNGGray(new Uint8Array(ab), opts.inflate)).then((dec) => {
          const vm = meta.value_maps || {};
          checkValueLayout(vm);
          if (dec.width !== vm.width || dec.height !== vm.height) {
            throw new Error(e.file + ': size ' + dec.width + 'x' + dec.height + ' differs from sky_img.json');
          }
          return dec;
        });
        files.set(e.file, fp);
        fp.catch((err) => {                         // remember the failure; report it once
          files.delete(e.file); failed.set(e.file, { err, t: now() });
          if (opts.onError) opts.onError(err, e);
        });
      }
      const p = fp.then((dec) => {
        const m = makeValueMap(e, dec, meta.value_maps);
        ready.set(k, m); pending.delete(k);
        if (opts.onLoad) opts.onLoad(m);
        return m;
      }, (err) => { pending.delete(k); throw err; });
      pending.set(k, p);
      return p;
    }
    function get(comp, band) {
      const e = findMap(meta, comp, band); if (!e) return null;
      const m = ready.get(keyOf(e));
      if (!m && !blocking(e)) request(comp, band).catch(() => { /* reported once, through onError */ });
      return m || null;
    }
    function error(comp, band) {
      const e = findMap(meta, comp, band), f = e && !ready.has(keyOf(e)) ? failed.get(e.file) : null;
      return f ? f.err : null;
    }
    return { request, get, error, isReady: (comp, band) => { const e = findMap(meta, comp, band); return !!(e && ready.has(keyOf(e))); } };
  }

  /** Mean and std over the sphere of a decoded map (equal-area pixels: plain averages over the
   *  pixels; to check against sky_img.json mean_uK and sigma_uK). */
  function mapStats(map) {
    let s1 = 0, s2 = 0;
    for (let k = 0; k < map.npix; k++) { const v = map.vmin + map.step * map.u16[k]; s1 += v; s2 += v * v; }
    const mean = s1 / map.npix;
    return { mean, sigma: Math.sqrt(Math.max(0, s2 / map.npix - mean * mean)) };
  }

  // ======================================================================================
  // Sky geometry
  // ======================================================================================
  function imgFracToSky(fx, fy) { return { theta: fy * Math.PI, phi: wrapPhi(fx * TWO_PI) }; }
  function skyToImgFrac(theta, phi) { return { fx: wrapPhi(phi) / TWO_PI, fy: theta / Math.PI }; }

  /** three.js r128 SphereGeometry convention (texture top row = theta 0 at +y). */
  function skyToVec(theta, phi, r) {
    if (r === undefined) r = 1;
    const st = Math.sin(theta);
    return [-r * Math.cos(phi) * st, r * Math.cos(theta), r * Math.sin(phi) * st];
  }
  /** Inverse of skyToVec for any non-zero vector (in the sphere's LOCAL frame). */
  function vecToSky(x, y, z) {
    const r = Math.hypot(x, y, z);
    if (!(r > 0)) return { theta: 0, phi: 0, r: 0 };
    return { theta: Math.acos(Math.max(-1, Math.min(1, y / r))), phi: wrapPhi(Math.atan2(z, -x)), r };
  }
  /** Mesh uv (three.js, flipY textures) -> sky. Texture.transformUv maps uv.y -> image row 1 - uv.y. */
  function uvToSky(u, v) { return { theta: (1 - v) * Math.PI, phi: wrapPhi(u * TWO_PI) }; }
  function skyToUV(theta, phi) { return { u: wrapPhi(phi) / TWO_PI, v: 1 - theta / Math.PI }; }

  function unit(theta, phi) { return skyToVec(theta, phi, 1); }
  /** Great-circle distance [rad], robust at all separations (atan2 of |a x b| and a.b). */
  function angDist(t1, p1, t2, p2) {
    const a = unit(t1, p1), b = unit(t2, p2);
    const cx = a[1] * b[2] - a[2] * b[1], cy = a[2] * b[0] - a[0] * b[2], cz = a[0] * b[1] - a[1] * b[0];
    return Math.atan2(Math.hypot(cx, cy, cz), a[0] * b[0] + a[1] * b[1] + a[2] * b[2]);
  }
  /** Point a fraction t along the great circle from a to b ({theta, phi} each). */
  function slerpSky(a, b, t) {
    const va = unit(a.theta, a.phi), vb = unit(b.theta, b.phi);
    const dot = Math.max(-1, Math.min(1, va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2]));
    const om = Math.acos(dot);
    if (om < 1e-12) return { theta: a.theta, phi: a.phi };
    let ka, kb;
    if (Math.PI - om < 1e-6) { ka = 1 - t; kb = t; }     // antipodal: any great circle; nudge linearly
    else { const so = Math.sin(om); ka = Math.sin((1 - t) * om) / so; kb = Math.sin(t * om) / so; }
    const s = vecToSky(ka * va[0] + kb * vb[0], ka * va[1] + kb * vb[1], ka * va[2] + kb * vb[2]);
    return { theta: s.theta, phi: s.phi };
  }
  /** Keyboard step on the sphere: dTheta (south positive), dPhi (east positive); crossing a pole
   *  continues on the other side (phi + pi). */
  function stepOnSphere(theta, phi, dTheta, dPhi) {
    let t = theta + dTheta, p = phi + dPhi;
    if (t < 0) { t = -t; p += Math.PI; }
    if (t > Math.PI) { t = 2 * Math.PI - t; p += Math.PI; }
    return { theta: t, phi: wrapPhi(p) };
  }

  // ======================================================================================
  // Halo catalogue helpers
  // ======================================================================================
  /** Precompute unit vectors of the halos (degrees in halos.json -> radians). */
  function haloIndex(halos) {
    const n = halos.n || halos.theta.length, vec = new Float64Array(3 * n);
    for (let i = 0; i < n; i++) {
      const v = unit(halos.theta[i] * DEG, halos.phi[i] * DEG);
      vec[3 * i] = v[0]; vec[3 * i + 1] = v[1]; vec[3 * i + 2] = v[2];
    }
    return { n, vec, halos };
  }
  /** Nearest halo by great-circle distance within maxAngle [rad]; null if none.
   *  Optional skip(i) excludes halos (e.g. hidden ones). */
  function pickHalo(index, theta, phi, maxAngle, skip) {
    const c = unit(theta, phi), cosMax = Math.cos(maxAngle), v = index.vec;
    let best = -1, bestDot = cosMax;
    for (let i = 0; i < index.n; i++) {
      const d = c[0] * v[3 * i] + c[1] * v[3 * i + 1] + c[2] * v[3 * i + 2];
      if (d >= bestDot && !(skip && skip(i))) { bestDot = d; best = i; }
    }
    if (best < 0) return null;
    const h = index.halos;
    return { index: best, dist: angDist(theta, phi, h.theta[best] * DEG, h.phi[best] * DEG) };
  }
  /** Pick radius: a fixed number of screen pixels converted with the local scale (zoom-aware). */
  function pickRadiusAngle(radiusPx, pxPerRad) { return radiusPx / Math.max(1e-9, pxPerRad); }

  /** Mass bin for marker sizes (shared by the 3D views). Edges in log10 M200c [Msun/h]. */
  const MASS_BIN_EDGES = [14.8, 14.95, 15.1];
  function massBin(logM) { let b = 0; while (b < MASS_BIN_EDGES.length && logM >= MASS_BIN_EDGES[b]) b++; return b; }

  // ======================================================================================
  // Scan path: the drag (or keyboard) path resampled at a FIXED angular spacing along great
  // circles, independent of how many pointer events arrive. The audio engine consumes one
  // sample per control tick (fixed rate), so the ear moves at a constant speed along the path.
  // ======================================================================================
  class ScanPath {
    constructor(spacingRad, maxQueue) {
      this.spacing = spacingRad; this.maxQueue = maxQueue || 60;
      this.queue = []; this.last = null; this.carry = 0; this.dropped = 0; this.inputDone = true;
    }
    setSpacing(s) { if (s > 0) this.spacing = s; }
    /** Begin a new path at (theta, phi); the start point is the first sample. */
    start(theta, phi) {
      this.queue.length = 0; this.dropped = 0; this.inputDone = false;
      this.last = { theta, phi }; this.carry = 0;
      this.queue.push({ theta, phi });
    }
    /** Extend the path to (theta, phi). Emits samples every `spacing` radians of path length. */
    push(theta, phi) {
      if (!this.last) { this.start(theta, phi); return; }
      const b = { theta, phi };
      const L = angDist(this.last.theta, this.last.phi, theta, phi);
      if (L <= 0) return;
      if (L > 1.0) {                                 // split long jumps so slerp stays well defined
        const mid = slerpSky(this.last, b, 0.5);
        this.push(mid.theta, mid.phi); this.push(theta, phi); return;
      }
      let d = this.spacing - this.carry;
      let lastEmit = -1;
      while (d <= L + 1e-15) {
        this.queue.push(slerpSky(this.last, b, d / L));
        lastEmit = d; d += this.spacing;
      }
      this.carry = lastEmit < 0 ? this.carry + L : L - lastEmit;
      this.last = b;
      if (this.queue.length > this.maxQueue) {       // bounded lag: the ear skips ahead
        const k = this.queue.length - this.maxQueue;
        this.queue.splice(0, k); this.dropped += k;
      }
    }
    end() { this.inputDone = true; }
    take() { return this.queue.length ? this.queue.shift() : null; }
    get pending() { return this.queue.length; }
  }

  // ======================================================================================
  // Sonification mappings (sky views)
  // ======================================================================================
  // Registers: one per component, non-overlapping, ordered by the component's power-weighted
  // mean multipole <ln l> (CMB 103 < tSZ 932 < kSZ 1032 < CIB 2488 at 143 GHz), i.e. the same
  // direction as the sonifier's l -> pitch map (larger angular scale = lower). Centres are
  // 13 semitones apart (a minor ninth: not an octave, so the voices do not fuse), each register
  // spans +-5 semitones, leaving 3-semitone gaps. T_tot shares the CMB register (the two are
  // mutually exclusive in the UI).
  const REGISTER_BASE_HZ = 196.0;                    // G3, centre of the lowest register
  const REGISTER_STEP_ST = 13;
  const HALF_RANGE_ST = 5;
  const REGISTER_SLOT = { dT_cmblens: 0, T_tot: 0, dT_tsz: 1, dT_ksz: 2, dT_cib: 3 };
  const VOICE_ORDER = ['dT_cmblens', 'T_tot', 'dT_tsz', 'dT_ksz', 'dT_cib'];   // onset order too
  const COMP_LABELS = SonifyCore.COMP_LABELS;   // one table, shared with the sonifier

  function registerCentre(comp) {
    const k = REGISTER_SLOT[comp];
    if (k === undefined) throw new Error('unknown component ' + comp);
    return REGISTER_BASE_HZ * Math.pow(2, REGISTER_STEP_ST * k / 12);
  }
  function registerRange(comp) {
    const c = registerCentre(comp), r = Math.pow(2, HALF_RANGE_ST / 12);
    return [c / r, c * r];
  }
  /** Pitch polarity: signed dT, hot = high. Semitones from the register centre (dT = 0),
   *  linear in dT: +-HALF_RANGE_ST at dT = +-pitchScale, clipped there. */
  function pitchSemitones(dT, pitchScale) {
    const s = HALF_RANGE_ST * dT / pitchScale;
    return Math.max(-HALF_RANGE_ST, Math.min(HALF_RANGE_ST, s));
  }
  function voiceFreq(comp, dT, pitchScale) {
    return registerCentre(comp) * Math.pow(2, pitchSemitones(dT, pitchScale) / 12);
  }
  /** Loudness: amplitude proportional to |dT - empty| / sigmaRef, reaching full scale at
   *  K_SIGMA * sigmaRef (so power ~ the local squared deviation). `empty` is the empty-sky level
   *  (map median: ~0 for CMB/kSZ/T_tot, the diffuse monopole for tSZ/CIB). */
  const K_SIGMA = 3;
  function voiceAmp(dT, empty, sigmaRef) {
    return Math.min(1, Math.abs(dT - empty) / (K_SIGMA * sigmaRef));
  }

  /** Fixed timbre per component (harmonic amplitudes, partial 1 = fundamental). Each voice is
   *  RMS-normalized to a unit sine (timbreRmsScale), so equal data loudness = equal RMS. */
  const TIMBRES = {
    dT_cmblens: { name: 'soft (flute-like)', harm: [1, 0.35, 0.12, 0.05] },
    T_tot:      { name: 'bright (5 harmonics)', harm: [1, 0.5, 0.33, 0.25, 0.2] },
    dT_tsz:     { name: 'hollow (odd harmonics)', harm: [1, 0, 0.42, 0, 0.22, 0, 0.1] },
    dT_ksz:     { name: 'reedy', harm: [1, 0.6, 0.4, 0.25, 0.15, 0.1] },
    dT_cib:     { name: 'pure (sine)', harm: [1] },
  };
  function timbreRmsScale(harm) {
    let s = 0; for (const a of harm) s += a * a;
    return 1 / Math.sqrt(s);
  }

  // ---------------------------------- scale modes ----------------------------------
  // How a value dT [muK] becomes pitch and loudness. Every mode: pitch = linear in the signed
  // deviation dT - centre (hot = high; +-HALF_RANGE_ST at +-pitchScale), loudness amplitude =
  // min(1, |dT - empty| / (K_SIGMA sigmaRef)), empty = the map median (the empty-sky level).
  //  'map' (DEFAULT, labelled 'equalized per map'): centre = that map's median; pitchScale = that
  //     map's max |v - median| over its stored range [vmin, vmax]; sigmaRef = that map's sigma_uK.
  //     Every component in every band uses its full register and its own sigma, so a weak band
  //     (CIB at 93-145 GHz, tSZ near its 217 GHz null) is still audible. The tSZ sign stays
  //     audible: clusters sound below (decrement) or above (increment) the empty-sky pitch. Levels
  //     are NOT comparable across bands or components in this mode (stated in the UI).
  //  'component' ('physical per component'): centre = 0 muK; pitchScale and sigmaRef = the
  //     largest over the component's bands, so the band dependence within a component is physical
  //     (tSZ quiet near 217 GHz, CIB quiet at low frequency) and each component is equalized to its
  //     loudest band.
  //  'common' ('common muK, physical'): centre = 0 muK; one pitchScale and one sigmaRef for every
  //     map (the largest), so weak components are quiet and nearly flat, as they are in muK.
  const SCALE_MODES = ['map', 'component', 'common'];
  const DEFAULT_SCALE_MODE = 'map';
  const SCALE_LABELS = { map: 'equalized per map', component: 'physical per component', common: 'common µK (physical)' };
  const SIGMA_FROM = { map: 'this map', component: 'the component’s loudest band', common: 'the loudest map' };

  /** Per-component scales of the two cross-band modes ('component', 'common'); centre 0 muK.
   *  mode 'component': pitchScale = the largest |vmin|,|vmax| over the component's maps (all
   *    bands); sigmaRef = the largest sigma_uK over its bands.
   *  mode 'common': one pitchScale and one sigmaRef for every map (the largest). */
  function componentScales(meta, mode) {
    const out = {};
    let gP = 0, gS = 0;
    for (const m of meta.maps) {
      const p = Math.max(Math.abs(m.vmin), Math.abs(m.vmax));
      const o = out[m.component] || (out[m.component] = { pitchScale: 0, sigmaRef: 0 });
      o.pitchScale = Math.max(o.pitchScale, p); o.sigmaRef = Math.max(o.sigmaRef, m.sigma_uK);
      gP = Math.max(gP, p); gS = Math.max(gS, m.sigma_uK);
    }
    if (mode === 'common') for (const k in out) { out[k].pitchScale = gP; out[k].sigmaRef = gS; }
    for (const k in out) out[k].centre = 0;
    return out;
  }
  /** {centre, pitchScale, sigmaRef, mode} of one voice (component comp in band) for a scale mode
   *  (see SCALE_MODES above; unknown modes fall back to the default 'map'). */
  function voiceScales(meta, comp, band, mode) {
    if (mode === 'component' || mode === 'common') {
      const s = componentScales(meta, mode)[comp];
      if (!s) throw new Error('no value maps for ' + comp);
      return { centre: 0, pitchScale: s.pitchScale, sigmaRef: s.sigmaRef, mode };
    }
    const e = findMap(meta, comp, band);
    if (!e) throw new Error('no value map for ' + comp + ' at ' + band + ' GHz');
    const c = e.median_uK;
    return { centre: c, pitchScale: Math.max(1e-12, e.vmax - c, c - e.vmin), sigmaRef: e.sigma_uK, mode: 'map' };
  }
  /** voiceScales for every component that has a map in this band: {comp: scales}. */
  function scaleTable(meta, band, mode) {
    const out = {};
    for (const comp of meta.components || []) if (findMap(meta, comp, band)) out[comp] = voiceScales(meta, comp, band, mode);
    return out;
  }
  /** The sample the audio engine (sky_audio.js) consumes for one voice. uK: the sky value [muK]
   *  (null while its map loads); entry: its sky_img.json entry; sc: voiceScales. The engine sees
   *  value = uK - centre (the signed deviation it sonifies: 0 = the register centre) and
   *  empty = median - centre (the empty-sky level in the same frame); uK and step (the value
   *  quantization, for the readout precision) are for display. */
  function voiceSample(comp, uK, entry, sc) {
    const ok = uK !== null && uK !== undefined && isFinite(uK);
    return { comp, uK: ok ? uK : null, value: ok ? uK - sc.centre : null, empty: entry.median_uK - sc.centre,
      pitchScale: sc.pitchScale, sigmaRef: sc.sigmaRef, step: valueStep(entry) };
  }
  /** Value quantization [muK] of a map: the 16-bit step, or for a PROVISIONAL map (upcast from the
   *  8-bit v1 maps) the 8-bit level spacing over the stored range (approximate). */
  function valueStep(entry) {
    return (entry.vmax - entry.vmin) / (entry.provisional ? 255 : 65535);
  }

  function isFreqIndep(meta, comp) { return (meta.freq_indep || []).indexOf(comp) >= 0; }
  /** The sky_img.json entry for a component in a band (band ignored for CMB and kSZ). */
  function findMap(meta, comp, band) {
    const fi = isFreqIndep(meta, comp);
    for (const m of meta.maps) {
      if (m.component !== comp) continue;
      if (fi ? m.band == null : String(m.band) === String(band)) return m;
    }
    return null;
  }
  function bandList(meta) { return (meta.bands || []).map(Number).sort((a, b) => a - b); }
  /** Experiment grouping for the band buttons (labels only; the band list itself comes from JSON).
   *  One table, shared with the sonifier: SonifyCore.BAND_GROUPS. */
  function bandGroup(b) { return SonifyCore.BAND_GROUPS[b] || 'other'; }

  /** tSZ sign at a band from sky_img.json tsz_g (g(x) < 0: decrement, > 0: increment). */
  function tszPolarity(meta, band) {
    const g = meta.tsz_g ? meta.tsz_g[String(band)] : undefined;
    if (g === undefined) return 'unknown';
    if (Math.abs(g) < 0.02) return 'null';
    return g < 0 ? 'decrement' : 'increment';
  }

  /** The Total's parts from sky_img.json T_tot_parts (CMB + tSZ + CIB when absent: older files). */
  function totalParts(meta) { return SonifyCore.totalParts(meta); }
  /** Component toggling with the T_tot rule: T_tot is mutually exclusive with its parts (totalParts(meta));
   *  a non-part may accompany either. At least one component stays on. */
  function toggleComponent(active, comp, meta) {
    const s = new Set(active), parts = totalParts(meta);
    if (s.has(comp)) { if (s.size > 1) s.delete(comp); return Array.from(s); }
    s.add(comp);
    if (comp === 'T_tot') for (const p of parts) s.delete(p);
    else if (parts.indexOf(comp) >= 0) s.delete('T_tot');
    return Array.from(s);
  }
  /** Tooltip of the Total button, from the parts in the data. */
  function totalTitle(meta) {
    const parts = totalParts(meta), out = SonifyCore.VOICED.filter((c) => parts.indexOf(c) < 0);
    return 'Total = ' + SonifyCore.totalPartsLabel(meta) + ' in the selected band (excludes them' +
      out.map((c) => '; ' + COMP_LABELS[c] + ' not included').join('') + ')';
  }

  // ---------------------------------- equal loudness ----------------------------------
  // ISO 226:2003 equal-loudness contours: the table and iso226SPL(f, phon) (SPL [dB] of a pure
  // tone on the `phon` contour, linear in log f between the table frequencies, held beyond
  // 20 Hz - 12.5 kHz) are sonify_core.js's, shared with the sonifier (one copy of the table).
  const ISO226 = SonifyCore.ISO226;
  const iso226SPL = SonifyCore.iso226SPL;
  /** Equal-loudness gain at f relative to refHz on the 60-phon contour (applied to the
   *  fundamental): tones the ear hears more easily are attenuated, so the gain is <= 1 for
   *  refHz = the lowest frequency in use. Clamped to [-capDb, +capDb]. */
  const EQ_PHON = 60, EQ_REF_HZ = registerRange('dT_cmblens')[0], EQ_CAP_DB = 30;
  function equalLoudnessGain(f, refHz, phon, capDb) {
    if (refHz === undefined) refHz = EQ_REF_HZ;
    if (phon === undefined) phon = EQ_PHON;
    if (capDb === undefined) capDb = EQ_CAP_DB;
    const db = Math.max(-capDb, Math.min(capDb, iso226SPL(f, phon) - iso226SPL(refHz, phon)));
    return Math.pow(10, db / 20);
  }

  // ---------------------------------- halo sounds ----------------------------------
  // Mass -> pitch (size metaphor: a bigger object sounds lower). Linear in log M:
  // -3 semitones per 0.1 dex, 880 Hz at log10 M200c = 14.7 [Msun/h] (the anchor). The catalogue
  // (halos.json: log10 M200c = 14.703-15.411) maps to 875-257 Hz; the formula gives 880-257 Hz over
  // 14.70-15.41 (the Sound key quotes 880 Hz at 10^14.7 to 262 Hz = C4 at 10^15.4).
  const HALO_PITCH = { anchorLogM: 14.7, anchorHz: 880, stPerDex: -30, topLogM: 15.4 };
  function massToFreq(logM) {
    return HALO_PITCH.anchorHz * Math.pow(2, HALO_PITCH.stPerDex * (logM - HALO_PITCH.anchorLogM) / 12);
  }
  /** Equal-loudness gain of a halo sound at its fundamental f (sky_audio.js applies it when equal
   *  loudness is ON): the voices' ISO 226 60-phon gain (equalLoudnessGain), referenced to the pitch of
   *  the top of the mass range, HALO_EQ_REF_HZ = massToFreq(15.4) = 261.6 Hz (C4), so the heaviest
   *  clusters keep their level and lighter (higher) ones are attenuated by the contour difference
   *  (-7.18 dB at the catalogue's 875 Hz; the most, -7.23 dB, at 800 Hz, where the 60-phon contour
   *  has a shallow minimum): at the same distance every mass sounds equally loud, and mass no
   *  longer leaks into the distance (level) cue. Haloes above 10^15.4 (up to 15.41: 257 Hz) get +0.18 dB. */
  const HALO_EQ_REF_HZ = massToFreq(HALO_PITCH.topLogM);
  function haloLoudnessGain(f) { return equalLoudnessGain(f, HALO_EQ_REF_HZ); }
  // Distance (comoving chi [Mpc/h]) -> level ~ 1/chi beyond chiRef (inverse-distance law, as the
  // Web Audio 'inverse' model) and a low-pass whose cutoff falls with chi (duller = farther). The
  // reverb send is constant, so the direct-to-reverberant ratio also falls as 1/chi.
  const DIST_CUE = { chiRef: 500, fcRef: 9000, fcMin: 700, slope: 0.75, reverbSend: 0.25 };
  function distanceCue(chi) {
    const c = Math.max(chi, DIST_CUE.chiRef);
    return {
      gain: DIST_CUE.chiRef / c,
      cutoffHz: Math.max(DIST_CUE.fcMin, DIST_CUE.fcRef * Math.pow(DIST_CUE.chiRef / c, DIST_CUE.slope)),
      reverbSend: DIST_CUE.reverbSend,
    };
  }
  /** Bell partials of the data halo sound, a parameterized auditory icon (free-free bar ratios), amplitudes and decay times [s]; the name EARCON predates the term. */
  const EARCON = { ratios: [1, 2.756, 5.404], amps: [1, 0.45, 0.2], decay: [0.22, 0.11, 0.06], attack: 0.004 };

  // ---------------------------------- cosmology ----------------------------------
  const C_OVER_H0 = 2997.92458;                      // Mpc/h
  const HALFDOME = { h: 0.6774, Om: 0.3089, Ob: 0.0486, T_cmb_K: 2.7255, N_eff: 3.046 };
  function omegaRadiation(cosmo) {
    const T = cosmo.T_cmb_K || 2.7255, Neff = cosmo.N_eff === undefined ? 3.046 : cosmo.N_eff;
    const ogh2 = 2.4728e-5 * Math.pow(T / 2.7255, 4);                 // photons, Omega_gamma h^2
    return ogh2 * (1 + 0.22710731766 * Neff) / (cosmo.h * cosmo.h);
  }
  /** Comoving distance [Mpc/h] in flat LCDM (optionally with radiation). Simpson's rule in
   *  s = sqrt(a), where the integrand 2 s / sqrt(Om s^2 + Or + OL s^8) is smooth. */
  function comovingDistance(z, cosmo, radiation, n) {
    cosmo = cosmo || HALFDOME; n = n || 2048;
    const Or = radiation ? omegaRadiation(cosmo) : 0, Om = cosmo.Om, OL = 1 - Om - Or;
    const s0 = Math.sqrt(1 / (1 + z)), s1 = 1, hh = (s1 - s0) / n;
    const g = (s) => 2 * s / Math.sqrt(Om * s * s + Or + OL * Math.pow(s, 8));
    let sum = g(s0) + g(s1);
    for (let k = 1; k < n; k++) sum += (k % 2 ? 4 : 2) * g(s0 + k * hh);
    return C_OVER_H0 * sum * hh / 3;
  }

  // ---------------------------------- misc ----------------------------------
  /** Deterministic PRNG (mulberry32), shared with the sonifier (sonify_core.js). */
  const mulberry32 = SonifyCore.mulberry32;
  /** Seeded stereo reverb impulse response: decaying noise with T60 `t60` seconds. */
  function reverbImpulse(sampleRate, seconds, t60, seed) {
    const n = Math.max(1, Math.round(sampleRate * seconds)), rnd = mulberry32(seed || 1);
    const k = Math.log(1000) / (t60 * sampleRate), chans = [new Float32Array(n), new Float32Array(n)];
    for (let i = 0; i < n; i++) {
      const env = Math.exp(-k * i);
      chans[0][i] = (2 * rnd() - 1) * env; chans[1][i] = (2 * rnd() - 1) * env;
    }
    for (const c of chans) {                          // unit energy per channel
      let e = 0; for (let i = 0; i < n; i++) e += c[i] * c[i];
      const norm = 1 / Math.sqrt(e);
      for (let i = 0; i < n; i++) c[i] *= norm;
    }
    return chans;
  }
  /** Gain that brings a user clip to targetRms (RMS over samples above a -50 dBFS gate), capped
   *  so that the gain is <= maxGain and gain * peak <= peakCeil (artistic halo sounds). */
  function clipNormGain(channels, targetRms, maxGain, peakCeil) {
    targetRms = targetRms || 0.1; maxGain = maxGain || 10; peakCeil = peakCeil || 0.8;
    let s = 0, n = 0, peak = 0;
    const gate = Math.pow(10, -50 / 20);
    for (const c of channels) for (let i = 0; i < c.length; i++) {
      const a = Math.abs(c[i]); if (a > peak) peak = a;
      if (a > gate) { s += c[i] * c[i]; n++; }
    }
    if (!n || peak <= 0) return 0;
    const rms = Math.sqrt(s / n);
    return Math.min(maxGain, targetRms / rms, peakCeil / peak);
  }

  function signed(v, dp) { return (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(dp); }
  /** muK with a precision that suits the magnitude and, when given, the value quantization `step`
   *  (valueStep: no digit finer than one decade below the step, so a provisional 8-bit map is not
   *  printed with 16-bit precision). */
  function formatMicroK(v, step) {
    const a = Math.abs(v);
    let dp = a >= 100 ? 1 : a >= 10 ? 2 : 3;
    if (step > 0) dp = Math.min(dp, Math.max(0, Math.ceil(-Math.log10(step))));
    return signed(v, dp) + ' µK';
  }
  function formatSkyCoords(theta, phi) {
    return 'θ = ' + (theta / DEG).toFixed(2) + '°, φ = ' + (wrapPhi(phi) / DEG).toFixed(2) + '°';
  }

  // ======================================================================================
  // UI text shared by the sky views (pure string builders; the pages insert them as HTML)
  // ======================================================================================
  function fmtHz(f) { return f >= 1000 ? (f / 1000).toFixed(2) + ' kHz' : Math.round(f) + ' Hz'; }
  function unsignedMicroK(v) { return formatMicroK(Math.abs(v)).slice(1); }
  const CSS_VAR = { dT_cmblens: 'cmb', dT_tsz: 'tsz', dT_cib: 'cib', dT_ksz: 'ksz', T_tot: 'tot' };

  function esc(t) { return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  /** Provisional entries among the active voices whose values are only APPROXIMATE (e.g. the
   *  provisional CIB bands: one 143 GHz pattern rescaled, identical structure in every band). */
  function approximateEntries(meta, comps, band) {
    if (!meta.provisional) return [];
    return VOICE_ORDER.filter((c) => comps.indexOf(c) >= 0).map((c) => findMap(meta, c, band))
      .filter((e) => e && /^APPROXIMATE/i.test(e.provisional_method || ''));
  }

  /** One-line statement of the audio mapping, the scale mode and the tSZ polarity at the current
   *  band. s = {meta, band, comps, scaleMode}. */
  function noteHTML(s) {
    const mode = SCALE_MODES.indexOf(s.scaleMode) >= 0 ? s.scaleMode : DEFAULT_SCALE_MODE;
    const parts = ['<b>Audio:</b> pitch = signed ΔT (hot = high) ' +
      (mode === 'map' ? 'relative to the empty sky' : 'relative to 0 µK') + ', each component in its own register; ' +
      'loudness = |ΔT − empty sky| / σ'];
    if (s.scaleMode) {
      parts.push(mode === 'map'
        ? 'scale: <b>equalized per map</b> (each component and band uses its full register and its own σ: ' +
          'levels are not comparable across bands; use a physical scale for that)'
        : mode === 'component'
          ? 'scale: <b>physical per component</b> (one µK scale per component, set by its loudest band: weak bands are quiet and nearly flat)'
          : 'scale: <b>common µK</b> (physical: weak components are quiet and nearly flat)');
    }
    const tsz = s.comps.indexOf('dT_tsz') >= 0, tot = s.comps.indexOf('T_tot') >= 0 && totalParts(s.meta).indexOf('dT_tsz') >= 0;
    if (tsz || tot) {
      const pol = tszPolarity(s.meta, s.band);
      const said = pol === 'decrement' ? 'a <b>decrement</b>: clusters sound <b>lower</b>'
        : pol === 'increment' ? 'an <b>increment</b>: clusters sound <b>higher</b>'
          : pol === 'null' ? 'near its <b>null</b>: clusters nearly silent' : 'of unknown sign';
      parts.push('tSZ at ' + s.band + ' GHz is ' + said + (mode === 'map' ? ' than the empty sky' : '') +
        (tsz ? ' (the tSZ image shows |ΔT|, brighter = stronger)' : ''));
    }
    if (s.meta.provisional) {
      const approx = approximateEntries(s.meta, s.comps, s.band);
      parts.push('<span class="warn">sky values are PROVISIONAL (from the 8-bit 21′ v1 maps; readouts rounded to their ' +
        'level spacing)' + approx.map((e) => '; ' + COMP_LABELS[e.component] + ' at ' + e.band + ' GHz is APPROXIMATE: ' +
        'another band’s spatial pattern rescaled, so its structure is identical in every band by construction').join('') +
        '</span>');
    }
    return parts.join(' &middot; ');
  }

  /** The 'Sound key' panel. s = {meta, band, comps, scales (scaleTable), scaleMode, ref, eq,
   *  artistic, pickPx, pickMode: 'angle' | 'screen', scanPx, controlRate, stagger, maxLagS,
   *  view: 'map' | 'globe' | 'lightcone'}. */
  function keyHTML(s) {
    const mode = SCALE_MODES.indexOf(s.scaleMode) >= 0 ? s.scaleMode : DEFAULT_SCALE_MODE;
    const comps = VOICE_ORDER.filter((c) => s.comps.indexOf(c) >= 0);
    const rows = comps.map((c) => {
      const e = findMap(s.meta, c, s.band), sc = s.scales[c], r = registerRange(c);
      return '<tr><td><b style="color:var(--' + CSS_VAR[c] + ')">' + COMP_LABELS[c] + '</b>' +
        (e && e.band != null ? ' ' + e.band : '') + '</td>' +
        '<td>' + fmtHz(r[0]) + '–' + fmtHz(r[1]) + '<br>' + TIMBRES[c].name + '</td>' +
        '<td>1 semitone = ' + unsignedMicroK(sc.pitchScale / HALF_RANGE_ST) + '<br>centre = ' +
        (sc.centre ? formatMicroK(sc.centre) + ' (empty sky)' : '0 µK') + '</td>' +
        '<td>empty ' + (e ? formatMicroK(e.median_uK) : '?') + '<br>full at ' + unsignedMicroK(K_SIGMA * sc.sigmaRef) +
        ' = ' + K_SIGMA + 'σ<br>σ = ' + unsignedMicroK(sc.sigmaRef) + ' (' + SIGMA_FROM[mode] + ')</td></tr>';
    }).join('');
    const pitchRef = mode === 'map' ? 'that map’s largest |ΔT − empty| (its stored 0.05–99.95 percentile range)'
      : mode === 'component' ? 'the largest |ΔT| of that component over all bands' : 'the largest |ΔT| of any map';
    let h = '<h2>Sound key</h2>' +
      '<p>Scale: <b>' + SCALE_LABELS[mode] + '</b>. ' +
      (mode === 'map' ? 'Each component and band is normalized by its own map, so every voice uses its full register and ' +
        'is audible, but levels and pitch steps are not comparable across bands or components. '
        : mode === 'component' ? 'Within a component, bands share one µK scale (the band dependence is physical); each ' +
          'component is normalized to its loudest band. '
          : 'One µK scale for every map: physical, so weak components are quiet and nearly flat. ') + '</p>' +
      '<table><tr><th>voice</th><th>register &middot; timbre</th><th>pitch (signed ΔT − centre)</th>' +
      '<th>loudness (|ΔT − empty|)</th></tr>' + rows + '</table>' +
      '<p>Registers are ordered by each component’s typical angular scale (CMB lowest, CIB highest) and do not ' +
      'overlap. Pitch is linear in ΔT − centre (hot = high): ±' + HALF_RANGE_ST + ' semitones at ± ' + pitchRef +
      '; the centre is ' + (mode === 'map' ? 'the empty-sky level (map median)' : '0 µK') + '. Loudness (amplitude) grows ' +
      'linearly with |ΔT − empty|, full at ' + K_SIGMA + 'σ, with σ the rms of ' + SIGMA_FROM[mode] +
      ' (value-map σ over ℓ ≤ the map’s ℓ<sub>max</sub>); "empty" is the map median (the diffuse level). ' +
      'Click notes start ' + Math.round(s.stagger * 1000) + ' ms apart in register order.' +
      (s.ref ? ' The reference tone (a pure sine at the register centre, i.e. ' +
        (mode === 'map' ? 'the empty-sky level' : '0 µK') + ') plays just before each note.' : '') +
      (s.eq ? ' Equal-loudness weighting (ISO 226, 60 phon, on the fundamental) is ON, for the voices and the ' +
        'cluster sounds: approximate, listener and device dependent.' : ' Equal-loudness weighting is OFF.') + '</p>';
    const lo = massToFreq(HALO_PITCH.topLogM), hi = massToFreq(HALO_PITCH.anchorLogM);
    const screenPick = s.pickMode === 'screen' || s.view === 'globe' || s.view === 'lightcone';
    const pickText = screenPick
      ? 'A click picks the visible cluster marker nearest to the click on screen, within ' + s.pickPx + ' CSS pixels'
      : 'A click picks the nearest cluster within ' + s.pickPx + ' screen pixels (great-circle distance, converted with the map’s scale)';
    h += '<h3>Clusters</h3><p>' + (s.artistic ? '<b>Artistic</b> sound (decorative; pitch still follows mass). ' : '') +
      'Mass → pitch: heavier = lower, −3 semitones per 0.1 dex (' + fmtHz(hi) + ' at 10<sup>14.7</sup> to ' +
      fmtHz(lo) + ' at 10<sup>' + HALO_PITCH.topLogM + '</sup> M⊙/h, M₂₀₀c). Distance → level ∝ 1/χ beyond ' +
      DIST_CUE.chiRef + ' Mpc/h, duller (low-pass) and relatively more reverberant when farther. ' +
      (s.eq && !s.artistic ? 'With equal loudness ON, lighter (higher) clusters are attenuated by the 60-phon contour ' +
        '(up to ' + Math.abs(20 * Math.log10(haloLoudnessGain(hi))).toFixed(1) + ' dB at ' + fmtHz(hi) + ', none at ' +
        fmtHz(lo) + '), so every mass sounds equally loud at the same distance and pitch does not change the ' +
        'distance (level) cue. ' : '');
    if (s.view === 'lightcone') {
      h += 'Here the 1/distance level comes from your actual distance to the cluster (HRTF panner, inverse model), ' +
        'so it changes as you fly. ' + pickText + '; hidden clusters are silent.</p>';
    } else {
      h += pickText + (s.view === 'globe' ? '; hidden clusters are silent; sounds come from the clicked direction (HRTF).' : '.') +
        (s.scanPx ? ' While scanning, the ear rings each cluster it passes (within the same radius around the ear).' : '') + '</p>';
    }
    if (s.scanPx) {
      h += '<h3>Scan</h3><p>The ear moves along your drag (or arrow-key) path at ' + s.scanPx * s.controlRate +
        ' screen px/s: the path is sampled every ' + s.scanPx + ' px (a fixed angle at this zoom) and one sample ' +
        'sounds every ' + Math.round(1000 / s.controlRate) + ' ms as a continuous glide. If you drag faster it lags ' +
        'up to ' + s.maxLagS.toFixed(1) + ' s and then skips ahead.</p>';
    }
    const cmb = findMap(s.meta, 'dT_cmblens', null) || {};
    h += '<h3>Coordinates and data</h3><p>Simulation HEALPix (θ, φ), not Galactic. ' +
      (s.view === 'map' ? 'θ = 0 at the top, φ increases to the right (the mirror of the astronomical ' +
        'longitude-left convention). '
        : s.view === 'globe' ? 'θ = 0 (north) is up (+y); seen from outside, φ increases to the right. '
          : 'Seen from inside, the sky is the mirror image of the globe view, as the real sky is. ') +
      'Values come from 16-bit equal-area HEALPix maps (NSIDE ' + s.meta.value_maps.nside + ', ' +
      (healpixResolution(s.meta.value_maps.nside) / DEG * 60).toFixed(1) + '′ pixels, ℓ ≤ ' + cmb.ell_max +
      ', no smoothing), decoded in the browser: a point takes the value of the pixel that contains it, the mean ΔT ' +
      'over that pixel (no interpolation), so equal skies sound alike at every latitude' +
      (s.meta.provisional ? ' once the full render replaces the provisional maps.' : '.');
    if (s.meta.provisional) {
      h += ' <span class="warn">PROVISIONAL maps (the 8-bit 21′ v1 maps averaged onto these pixels, so no detail ' +
        'finer than 21′; the v1 cells narrow towards the poles, so the polar sky still keeps more small-scale ' +
        'variance, the CIB most; readouts are rounded to their level spacing):</span></p><ul>' + comps.map((c) => {
        const e = findMap(s.meta, c, s.band); if (!e) return '';
        return '<li>' + COMP_LABELS[c] + (e.band != null ? ' ' + e.band + ' GHz' : '') + ': ' + esc(e.provisional_method || 'provisional') +
          ' (level spacing ≈ ' + unsignedMicroK(valueStep(e)) + ')</li>';
      }).join('') + '</ul>';
    } else h += '</p>';
    return h;
  }

  return {
    VERSION, DEG, TWO_PI,
    // PNG / value maps (HEALPix RING)
    parsePNG, unfilter, paeth, decodePNGGray, inflateStream, u16ToMicroK, microKToU16, makeValueMap,
    sampleMap, mapStats, createMapStore, checkValueLayout, valueMapResolution,
    ang2pixRing, loc2pixRing, pix2angRing, healpixResolution,
    // geometry
    wrapPhi, imgFracToSky, skyToImgFrac, skyToVec, vecToSky, uvToSky, skyToUV, angDist, slerpSky, stepOnSphere,
    // halos
    haloIndex, pickHalo, pickRadiusAngle, MASS_BIN_EDGES, massBin,
    // scan
    ScanPath,
    // mappings
    REGISTER_BASE_HZ, REGISTER_STEP_ST, HALF_RANGE_ST, REGISTER_SLOT, VOICE_ORDER, COMP_LABELS, K_SIGMA,
    registerCentre, registerRange, pitchSemitones, voiceFreq, voiceAmp, TIMBRES, timbreRmsScale,
    SCALE_MODES, DEFAULT_SCALE_MODE, SCALE_LABELS, componentScales, voiceScales, scaleTable, voiceSample, valueStep,
    isFreqIndep, findMap, bandList, bandGroup, tszPolarity, totalParts, toggleComponent, totalTitle,
    ISO226, iso226SPL, equalLoudnessGain, EQ_PHON, EQ_REF_HZ, EQ_CAP_DB,
    HALO_PITCH, massToFreq, HALO_EQ_REF_HZ, haloLoudnessGain, DIST_CUE, distanceCue, EARCON,
    // cosmology
    C_OVER_H0, HALFDOME, omegaRadiation, comovingDistance,
    // misc
    mulberry32, reverbImpulse, clipNormGain, formatMicroK, formatSkyCoords,
    // UI text
    fmtHz, CSS_VAR, noteHTML, keyHTML, approximateEntries,
  };
});
