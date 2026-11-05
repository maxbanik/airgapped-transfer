/* QR transfer protocol v2 — shared by sender.html and receiver.html.
 *
 * Frame bytes (big endian), then base45 (RFC 9285) so the QR can use
 * alphanumeric mode (~97% efficient vs ~50% for the v1 latin1/UTF-8/base64 path):
 *   0      ver/type   0x21 data, 0x22 repair, 0x23 meta
 *   1..4   session    random per transfer
 *   5..8   total      length of the transmitted byte stream (gzip or raw)
 *   9..10  chunk      bytes per block
 *   11..14 id         data: block index; repair: seed; meta: 0
 *   15..   payload    data/repair: exactly `chunk` bytes (last block zero padded)
 *                     meta: UTF-8 JSON {n:name, s:size, c:crc32(original), z:gzip?1:0}
 *
 * Repair frames are XORs of a pseudo-random half of all blocks (seeded), i.e. a
 * systematic random linear fountain code over GF(2): a receiver that missed m
 * blocks needs ~m+2 repair frames, regardless of which ones it missed.
 */
var QRT = (function () {
  "use strict";
  var VER = 0x20, T_DATA = 1, T_REPAIR = 2, T_META = 3, HDR = 15;

  // ---------- base45 ----------
  var A45 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";
  var R45 = new Int8Array(128).fill(-1);
  for (var i = 0; i < 45; i++) R45[A45.charCodeAt(i)] = i;

  function b45enc(b) {
    var out = [], n = b.length, i = 0;
    for (; i + 1 < n; i += 2) {
      var x = b[i] * 256 + b[i + 1];
      out.push(A45[x % 45], A45[((x / 45) | 0) % 45], A45[(x / 2025) | 0]);
    }
    if (i < n) { out.push(A45[b[i] % 45], A45[(b[i] / 45) | 0]); }
    return out.join("");
  }
  function b45dec(s) {
    var n = s.length;
    if (n % 3 === 1) throw new Error("b45 length");
    var out = new Uint8Array(Math.floor(n / 3) * 2 + (n % 3 === 2 ? 1 : 0)), o = 0;
    for (var i = 0; i < n; i += 3) {
      var c0 = s.charCodeAt(i), c1 = s.charCodeAt(i + 1);
      var a = c0 < 128 ? R45[c0] : -1, b = c1 < 128 ? R45[c1] : -1;
      if (a < 0 || b < 0) throw new Error("b45 char");
      if (i + 2 < n) {
        var c2 = s.charCodeAt(i + 2), c = c2 < 128 ? R45[c2] : -1;
        if (c < 0) throw new Error("b45 char");
        var x = a + b * 45 + c * 2025;
        if (x > 65535) throw new Error("b45 range");
        out[o++] = x >> 8; out[o++] = x & 255;
      } else {
        var y = a + b * 45;
        if (y > 255) throw new Error("b45 range");
        out[o++] = y;
      }
    }
    return out;
  }

  // ---------- CRC32 ----------
  var CRC = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(b) {
    var c = 0xffffffff;
    for (var i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  // ---------- repair masks ----------
  // Bitset (Uint32Array, LSB = lowest block) of the blocks XORed into repair `seed`.
  function repairMask(seed, K) {
    var W = (K + 31) >>> 5, m = new Uint32Array(W);
    // mulberry32: must be non-linear over GF(2) (xorshift is linear and would
    // confine all masks to a 32-dimensional subspace).
    var s = (Math.imul(seed >>> 0, 0x9e3779b1) ^ Math.imul(K, 0x85ebca6b)) >>> 0;
    function next() {
      s = (s + 0x6d2b79f5) >>> 0;
      var t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return (t ^ (t >>> 14)) >>> 0;
    }
    var w;
    for (w = 0; w < W; w++) m[w] = next();
    var rem = K & 31;
    if (rem) m[W - 1] &= (1 << rem) - 1;
    var any = 0; for (w = 0; w < W; w++) any |= m[w];
    if (!any) m[(seed % K) >>> 5] |= 1 << ((seed % K) & 31);
    return m;
  }

  function xorInto(dst, src) { for (var i = 0; i < dst.length; i++) dst[i] ^= src[i]; }

  // ---------- frames ----------
  function header(type, session, total, chunk, id, payloadLen) {
    var f = new Uint8Array(HDR + payloadLen), v = new DataView(f.buffer);
    f[0] = VER | type; v.setUint32(1, session); v.setUint32(5, total); v.setUint16(9, chunk); v.setUint32(11, id >>> 0);
    return f;
  }
  function parse(text) {
    var b = b45dec(text);
    if (b.length < HDR || (b[0] & 0xf0) !== VER) throw new Error("not a v2 frame");
    var v = new DataView(b.buffer), type = b[0] & 15;
    var f = { type: type, session: v.getUint32(1), total: v.getUint32(5), chunk: v.getUint16(9), id: v.getUint32(11), payload: b.subarray(HDR) };
    if (!f.chunk || type < 1 || type > 3) throw new Error("bad header");
    if (type !== T_META && f.payload.length !== f.chunk) throw new Error("bad payload length");
    if (type === T_DATA && f.id >= Math.ceil(f.total / f.chunk)) throw new Error("bad index");
    if (type === T_META) f.meta = JSON.parse(new TextDecoder().decode(f.payload));
    return f;
  }

  // Sender side: holds the stream, produces frame texts.
  function Encoder(stream, chunk, meta) {
    this.stream = stream; this.chunk = chunk; this.total = stream.length;
    this.K = Math.max(1, Math.ceil(stream.length / chunk));
    this.session = (crypto.getRandomValues(new Uint32Array(1))[0]) >>> 0;
    this.meta = meta;
    this.blocks = [];
    for (var i = 0; i < this.K; i++) {
      var blk = new Uint8Array(chunk);
      blk.set(stream.subarray(i * chunk, (i + 1) * chunk));
      this.blocks.push(blk);
    }
  }
  Encoder.prototype.metaFrame = function () {
    var p = new TextEncoder().encode(JSON.stringify(this.meta));
    var f = header(T_META, this.session, this.total, this.chunk, 0, p.length);
    f.set(p, HDR); return b45enc(f);
  };
  Encoder.prototype.dataFrame = function (i) {
    var f = header(T_DATA, this.session, this.total, this.chunk, i, this.chunk);
    f.set(this.blocks[i], HDR); return b45enc(f);
  };
  Encoder.prototype.repairFrame = function (seed) {
    var f = header(T_REPAIR, this.session, this.total, this.chunk, seed, this.chunk);
    var p = f.subarray(HDR), m = repairMask(seed, this.K);
    for (var w = 0; w < m.length; w++) {
      var x = m[w];
      while (x) { var t = x & -x, b = (w << 5) + (31 - Math.clz32(t)); xorInto(p, this.blocks[b]); x ^= t; }
    }
    return b45enc(f);
  };

  // Receiver side: incremental GF(2) elimination over the still-unknown blocks.
  function Decoder(session, total, chunk) {
    this.session = session; this.total = total; this.chunk = chunk;
    this.K = Math.max(1, Math.ceil(total / chunk)); this.W = (this.K + 31) >>> 5;
    this.blocks = new Array(this.K);              // Uint8Array once known
    this.state = new Uint8Array(this.K);          // 0 unknown, 1 received, 2 recovered
    this.known = 0; this.rows = new Map();        // pivot -> {m, d}
    this.maxIndex = -1; this.repairs = 0; this.meta = null;
  }
  Decoder.prototype.done = function () { return this.known === this.K; };
  Decoder.prototype.needed = function () { return Math.max(0, this.K - this.known - this.rows.size); };
  Decoder.prototype._learn = function (i, data, how) {
    if (this.state[i]) return false;
    this.blocks[i] = data; this.state[i] = how; this.known++;
    var r = this.rows.get(i);                      // an equation pivoted on i is now redundant info: re-reduce it
    if (r) { this.rows.delete(i); r.m[i >>> 5] &= ~(1 << (i & 31)); xorInto(r.d, data); this._insert(r.m, r.d); }
    return true;
  };
  // Reduce an equation (mask m, data d) against known blocks and stored rows; store it or solve.
  Decoder.prototype._insert = function (m, d) {
    for (var w = 0; w < this.W; w++) {
      var x;
      while ((x = m[w])) {
        var t = x & -x, b = (w << 5) + (31 - Math.clz32(t));
        if (this.state[b]) { xorInto(d, this.blocks[b]); m[w] ^= t; continue; }
        var r = this.rows.get(b);
        if (r) { for (var k = w; k < this.W; k++) m[k] ^= r.m[k]; xorInto(d, r.d); continue; }
        // new pivot b: if it's the only remaining bit, solved directly
        var single = (m[w] ^ t) === 0;
        for (var k2 = w + 1; single && k2 < this.W; k2++) if (m[k2]) single = false;
        if (single) this._learn(b, d, 2); else this.rows.set(b, { m: m, d: d });
        return;
      }
    }
  };
  Decoder.prototype._solve = function () {
    if (this.done() || this.rows.size !== this.K - this.known) return;
    var pivots = Array.from(this.rows.keys()).sort(function (a, b) { return b - a; });
    for (var j = 0; j < pivots.length; j++) {
      var p = pivots[j], r = this.rows.get(p);
      if (!r) continue;
      this.rows.delete(p);
      r.m[p >>> 5] &= ~(1 << (p & 31));
      for (var w = 0; w < this.W; w++) {
        var x = r.m[w];
        while (x) { var t = x & -x, b = (w << 5) + (31 - Math.clz32(t)); xorInto(r.d, this.blocks[b]); x ^= t; }
      }
      this._learn(p, r.d, 2);
    }
  };
  // Returns true if the frame added information.
  Decoder.prototype.add = function (f) {
    if (f.type === T_META) { var had = !!this.meta; this.meta = f.meta; return !had; }
    if (f.type === T_DATA) {
      if (f.id > this.maxIndex) this.maxIndex = f.id;
      var added = this._learn(f.id, new Uint8Array(f.payload), 1);
      if (added) this._solve();
      return added;
    }
    this.repairs++;
    if (this.done()) return false;
    var before = this.known + this.rows.size;
    this._insert(repairMask(f.id, this.K), new Uint8Array(f.payload));
    this._solve();
    return this.known + this.rows.size > before;
  };
  Decoder.prototype.assemble = function () {
    var out = new Uint8Array(this.K * this.chunk);
    for (var i = 0; i < this.K; i++) out.set(this.blocks[i], i * this.chunk);
    return out.subarray(0, this.total);
  };
  Decoder.prototype.missing = function (all) {
    var lim = all ? this.K - 1 : this.maxIndex, out = [];
    for (var i = 0; i <= lim; i++) if (!this.state[i]) out.push(i);
    return out;
  };

  // ---------- "12,45-48,97" ranges ----------
  function formatRanges(list) {
    var out = [], i = 0;
    while (i < list.length) {
      var a = list[i], b = a;
      while (i + 1 < list.length && list[i + 1] === b + 1) b = list[++i];
      out.push(a === b ? String(a) : a + "-" + b); i++;
    }
    return out.join(",");
  }
  function parseRanges(s, K) {
    var set = new Set();
    String(s).split(/[\s,;]+/).forEach(function (p) {
      if (!p) return;
      var m = /^(\d+)(?:-(\d+))?$/.exec(p);
      if (!m) throw new Error("can't parse '" + p + "'");
      var a = +m[1], b = m[2] === undefined ? a : +m[2];
      if (a > b) { var t = a; a = b; b = t; }
      for (var i = a; i <= b && i < K; i++) set.add(i);
    });
    return Array.from(set).sort(function (x, y) { return x - y; });
  }

  return {
    HDR: HDR, T_DATA: T_DATA, T_REPAIR: T_REPAIR, T_META: T_META,
    b45enc: b45enc, b45dec: b45dec, crc32: crc32, repairMask: repairMask,
    parse: parse, Encoder: Encoder, Decoder: Decoder,
    formatRanges: formatRanges, parseRanges: parseRanges
  };
})();
if (typeof module !== "undefined") module.exports = QRT;
