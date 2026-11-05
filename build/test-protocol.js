const Q = require(require('path').join(__dirname, 'protocol.js')); const crypto = require('crypto'); const assert = require('assert');
// base45 RFC vectors
assert.equal(Q.b45enc(Buffer.from('AB')), 'BB8'); assert.equal(Q.b45enc(Buffer.from('Hello!!')), '%69 VD92EX0');
assert.equal(Buffer.from(Q.b45dec('QED8WEX0')).toString(), 'ietf!');
for (let n = 0; n < 50; n++) { const b = crypto.randomBytes(n); assert.deepEqual(Buffer.from(Q.b45dec(Q.b45enc(b))), b); }
assert.throws(() => Q.b45dec('GGW')); // 65535+ overflow
assert.equal(Q.crc32(Buffer.from('123456789')), 0xcbf43926);
assert.equal(Q.formatRanges([1,2,3,5,7,8]), '1-3,5,7-8'); assert.deepEqual(Q.parseRanges('1-3, 5 ,8-7', 100), [1,2,3,5,7,8]);
function run(size, chunk, lossP, burst) {
  const data = crypto.randomBytes(size), enc = new Q.Encoder(data, chunk, { n: 'x', s: size, c: Q.crc32(data), z: 0 });
  let dec = null; const feed = t => { const f = Q.parse(t); if (!dec) dec = new Q.Decoder(f.session, f.total, f.chunk); return dec.add(f); };
  feed(enc.metaFrame()); let dropped = 0;
  for (let i = 0; i < enc.K; i++) { const lost = Math.random() < lossP || (burst && i >= burst[0] && i < burst[1]); if (lost) { dropped++; continue; } feed(enc.dataFrame(i)); }
  const missing = dec.K - dec.known; let reps = 0;
  while (!dec.done()) { reps++; feed(enc.repairFrame(reps)); if (reps > missing + 60) throw new Error('no converge'); }
  assert.deepEqual(Buffer.from(dec.assemble()), data);
  return { K: enc.K, missing, reps, extra: reps - missing };
}
const res = [];
for (const [s, c, p, b] of [[1, 400, 0], [10, 400, 1], [400, 400, 0.5], [800, 400, 1], [40000, 400, 0.1], [40000, 400, 0.4], [400000, 400, 0.05], [400000, 400, 0.01, [300, 340]], [400000, 400, 1]]) {
  const t0 = Date.now(); const r = run(s, c, p, b); r.ms = Date.now() - t0; res.push(Object.assign({ size: s, loss: p }, r));
}
console.table(res);
// overhead statistics
let ex = []; for (let k = 0; k < 200; k++) ex.push(run(20000, 200, 0.1).extra);
ex.sort((a, b) => a - b); console.log('extra repair frames over 200 runs: median', ex[100], 'p95', ex[190], 'max', ex[199]);
console.log('ALL OK');
