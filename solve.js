// Anchored fast diff for makefun-diff 1.0.0-shaped inputs.
// Lines are interned to integer ids; unique lines whose LIS chain survives a windowed
// crossing filter, a strict +-10 identical-diagonal-window test, and a phase-pinning test
// (at least 4 other lines in the window unique in both texts) become anchors, and an exact
// typed-array Myers search (deletion-preferred tie-break, as in the reference) runs only on
// the segments between anchors. Anchors near the trimmed region's edge are never used.
const FORMAT = 'makefun-diff/1';
const CONTEXT = 3;
const KEEP = 0, DELETE = 1, INSERT = 2;
const NEG = -1e9;

export function run(input) {
  if (input === null || typeof input !== 'object' || typeof input.old !== 'string' || typeof input.new !== 'string') {
    throw new TypeError('makefun-diff: the input is { old, new }, two strings');
  }
  const oldText = input.old, newText = input.new;
  const partsA = oldText.split('\n');
  const partsB = newText.split('\n');
  const aEndsNL = partsA[partsA.length - 1] === '';
  const bEndsNL = partsB[partsB.length - 1] === '';
  const n = aEndsNL ? partsA.length - 1 : partsA.length;
  const m = bEndsNL ? partsB.length - 1 : partsB.length;
  // Edge: empty text "".split -> [''], aEndsNL true, n=0 correct. Text with no lines only when empty.
  const idsA = new Int32Array(n);
  const idsB = new Int32Array(m);
  const map = new Map();
  let nextId = 0;
  for (let i = 0; i < n; i++) {
    const c = partsA[i];
    let b = map.get(c);
    if (b === undefined) { b = nextId++; map.set(c, b); }
    const hasNL = i < n - 1 || aEndsNL;
    idsA[i] = hasNL ? b * 2 + 1 : b * 2;
  }
  for (let i = 0; i < m; i++) {
    const c = partsB[i];
    let b = map.get(c);
    if (b === undefined) { b = nextId++; map.set(c, b); }
    const hasNL = i < m - 1 || bEndsNL;
    idsB[i] = hasNL ? b * 2 + 1 : b * 2;
  }

  let prefix = 0;
  const pn = n < m ? n : m;
  while (prefix < pn && idsA[prefix] === idsB[prefix]) prefix++;
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix && idsA[n - 1 - suffix] === idsB[m - 1 - suffix]) suffix++;

  const a0 = prefix, a1 = n - suffix;
  const b0 = prefix, b1 = m - suffix;
  const N = a1 - a0, M = b1 - b0;

  // Middle edit runs: split at unique-line LIS anchors, exact Myers per segment.
  const midRuns = [];
  if (N === 0 && M === 0) {
  } else if (N === 0) {
    midRuns.push([INSERT, M]);
  } else if (M === 0) {
    midRuns.push([DELETE, N]);
  } else {
    const anchors = lisAnchors(idsA, a0, N, idsB, b0, M, nextId);
    let pa = 0, pb = 0;
    const segRuns = (sa, sb, ea, eb) => {
      const sn = ea - sa, sm = eb - sb;
      if (sn === 0 && sm === 0) return;
      if (sn === 0) { midRuns.push([INSERT, sm]); return; }
      if (sm === 0) { midRuns.push([DELETE, sn]); return; }
      const runs = myers(idsA, a0 + sa, sn, idsB, b0 + sb, sm);
      for (const r of runs) midRuns.push(r);
    };
    for (const [ai, bi] of anchors) {
      segRuns(pa, pb, ai, bi);
      midRuns.push([KEEP, 1]);
      pa = ai + 1; pb = bi + 1;
    }
    segRuns(pa, pb, N, M);
    // merge adjacent same-kind runs in midRuns
    for (let i = midRuns.length - 1; i > 0; i--) {
      if (midRuns[i][0] === midRuns[i - 1][0]) { midRuns[i - 1][1] += midRuns[i][1]; midRuns.splice(i, 1); }
    }
  }

  // Full runs merged
  const runs = [];
  const pushRun = (kind, count) => {
    if (count <= 0) return;
    const last = runs[runs.length - 1];
    if (last && last[0] === kind) last[1] += count; else runs.push([kind, count]);
  };
  if (prefix > 0) pushRun(KEEP, prefix);
  for (const [k, c] of midRuns) pushRun(k, c);
  if (suffix > 0) pushRun(KEEP, suffix);

  // Change runs
  const changes = [];
  let o = 0, p = 0, deleted = 0, inserted = 0;
  for (const [kind, count] of runs) {
    if (kind === KEEP) { o += count; p += count; continue; }
    let c = changes[changes.length - 1];
    if (c === undefined || c.o + c.dels !== o || c.p + c.ins !== p) { c = { o, p, dels: 0, ins: 0 }; changes.push(c); }
    if (kind === DELETE) { c.dels += count; o += count; deleted += count; }
    else { c.ins += count; p += count; inserted += count; }
  }
  const hunks = [];
  for (const c of changes) {
    const h = hunks[hunks.length - 1];
    const prev = h ? h[h.length - 1] : undefined;
    if (prev !== undefined && c.o - (prev.o + prev.dels) <= 2 * CONTEXT) h.push(c);
    else hunks.push([c]);
  }
  const out = [`${FORMAT} old=${n} new=${m} hunks=${hunks.length} deleted=${deleted} inserted=${inserted}\n`];
  const written = (op, isA, idx) => {
    const parts = isA ? partsA : partsB;
    const cnt = isA ? n : m;
    const endsNL = isA ? aEndsNL : bEndsNL;
    const hasNL = idx < cnt - 1 || endsNL;
    const content = parts[idx];
    return hasNL ? op + content + '\n' : op + content + '\n%\n';
  };
  for (const h of hunks) {
    const first = h[0];
    const last = h[h.length - 1];
    const oldStart = Math.max(0, first.o - CONTEXT);
    const newStart = first.p - (first.o - oldStart);
    const after = Math.min(CONTEXT, n - (last.o + last.dels));
    const oldEnd = last.o + last.dels + after;
    const newEnd = last.p + last.ins + after;
    out.push(`@ ${oldStart + 1} ${oldEnd - oldStart} ${newStart + 1} ${newEnd - newStart}\n`);
    let at = oldStart;
    for (const c of h) {
      for (; at < c.o; at++) out.push(written('=', true, at));
      for (let i = 0; i < c.dels; i++) out.push(written('-', true, c.o + i));
      for (let i = 0; i < c.ins; i++) out.push(written('+', false, c.p + i));
      at = c.o + c.dels;
    }
    for (; at < oldEnd; at++) out.push(written('=', true, at));
  }
  return out.join('');
}

function lisAnchors(A, a0, N, B, b0, M, nextId) {
  const maxId = nextId * 2;
  const cntA = new Int32Array(maxId);
  const cntB = new Int32Array(maxId);
  for (let i = 0; i < N; i++) cntA[A[a0 + i]]++;
  for (let i = 0; i < M; i++) cntB[B[b0 + i]]++;
  const posB = new Int32Array(maxId).fill(-1);
  for (let i = 0; i < M; i++) { const id = B[b0 + i]; if (cntB[id] === 1) posB[id] = i; }
  // pairs in A order
  const pairA = [];
  const pairB = [];
  for (let i = 0; i < N; i++) {
    const id = A[a0 + i];
    if (cntA[id] === 1 && cntB[id] === 1) { pairA.push(i); pairB.push(posB[id]); }
  }
  const nPairs = pairB.length;
  if (nPairs === 0) return [];
  // LIS (strictly increasing) on pairB, smallest-tail patience with parent reconstruction
  const tails = []; // indices into pairs
  const parent = new Int32Array(nPairs).fill(-1);
  for (let i = 0; i < nPairs; i++) {
    const v = pairB[i];
    let lo = 0, hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (pairB[tails[mid]] < v) lo = mid + 1; else hi = mid; }
    if (lo > 0) parent[i] = tails[lo - 1];
    if (lo === tails.length) tails.push(i); else tails[lo] = i;
  }
  const lisIdx = [];
  let cur = tails[tails.length - 1];
  while (cur !== -1) { lisIdx.push(cur); cur = parent[cur]; }
  lisIdx.reverse();
  // Crossing filter (windowed): drop an anchor crossed by a unique pair within A-distance W.
  // Pairs farther away are independent edit coincidences, not local ambiguity.
  const W = 3000;
  const anchors = [];
  // left window maxima of pairB over pairA in [i-W, i)
  const leftMax = new Map();
  {
    const dq = []; // pair indices, decreasing pairB
    let addPtr = 0;
    for (const t of lisIdx) {
      const i = pairA[t];
      while (addPtr < t) {
        const pb = pairB[addPtr];
        while (dq.length && pairB[dq[dq.length - 1]] <= pb) dq.pop();
        dq.push(addPtr);
        addPtr++;
      }
      while (dq.length && pairA[dq[0]] < i - W) dq.shift();
      leftMax.set(t, dq.length ? pairB[dq[0]] : -1);
    }
  }
  const rightMin = new Map();
  {
    const dq = [];
    let addPtr = nPairs - 1;
    for (let ai = lisIdx.length - 1; ai >= 0; ai--) {
      const t = lisIdx[ai];
      const i = pairA[t];
      while (addPtr > t) {
        const pb = pairB[addPtr];
        while (dq.length && pairB[dq[dq.length - 1]] >= pb) dq.pop();
        dq.push(addPtr);
        addPtr--;
      }
      while (dq.length && pairA[dq[0]] > i + W) dq.shift();
      rightMin.set(t, dq.length ? pairB[dq[0]] : Infinity);
    }
  }
  for (const t of lisIdx) {
    if (leftMax.get(t) > pairB[t] || rightMin.get(t) < pairB[t]) continue;
    // Identical-window filter: the full +-10 window around the anchor must lie inside the
    // trimmed region and match on its diagonal. Anchors near the region edge are rejected
    // outright (no clamping): the segment Myers search covers those parts exactly instead.
    const i = pairA[t], j = pairB[t];
    if (i - 10 < 0 || i + 10 >= N || j - 10 < 0 || j + 10 >= M) continue;
    let okWin = true;
    for (let s = -10; s <= 10; s++) {
      if (A[a0 + i + s] !== B[b0 + j + s]) { okWin = false; break; }
    }
    if (!okWin) continue;
    // Phase pinning: the window must contain at least 4 other lines that are unique in both
    // texts. A window made only of repeated lines (e.g. pass/return/} cycles) can be matched
    // at a shifted phase, so it does not pin the anchor to the reference's alignment.
    let pins = 0;
    for (let s = -10; s <= 10; s++) {
      if (s === 0) continue;
      const id = A[a0 + i + s];
      if (cntA[id] === 1 && cntB[id] === 1) pins++;
    }
    if (pins < 4) continue;
    anchors.push([i, j]);
  }
  return anchors;
}

function myers(A, a0, N, B, b0, M) {
  const maxD = N + M;
  const offset = maxD;
  const V = new Int32Array(2 * maxD + 1);
  V.fill(NEG);
  const trace = [];
  const kf = N - M;
  let foundD = -1;
  // d = 0
  {
    let x = 0;
    while (x < N && x < M && A[a0 + x] === B[b0 + x]) x++;
    V[offset] = x;
    trace.push(V.slice(offset, offset + 1));
    if (kf === 0 && x >= N) foundD = 0;
  }
  for (let d = 1; foundD < 0 && d <= maxD; d++) {
    for (let k = -d; k <= d; k += 2) {
      const idx = offset + k;
      let byDel = NEG, byIns = NEG;
      if (k !== -d) {
        const xp = V[idx - 1];
        if (xp >= 0 && xp < N) byDel = xp + 1;
      }
      if (k !== d) {
        const xp = V[idx + 1];
        if (xp >= 0 && xp - (k + 1) < M) byIns = xp;
      }
      let x = byDel >= byIns ? byDel : byIns;
      if (x < 0) { V[idx] = NEG; continue; }
      let y = x - k;
      while (x < N && y < M && A[a0 + x] === B[b0 + y]) { x++; y++; }
      V[idx] = x;
      if (k === kf && x >= N) { foundD = d; break; }
    }
    trace.push(V.slice(offset - d, offset + d + 1));
  }
  if (foundD < 0) throw new Error('makefun-diff: the search ended without reaching both ends');
  const D = foundD;
  // Backtrack
  const segKind = [];
  const segCount = [];
  let x = N, y = M;
  for (let d = D; d >= 1; d--) {
    const k = x - y;
    const prev = trace[d - 1];
    const base = d - 1; // index = k' + base
    let byDel = NEG, byIns = NEG;
    if (k !== -d) {
      const xp = prev[k - 1 + base];
      if (xp >= 0 && xp < N) byDel = xp + 1;
    }
    if (k !== d) {
      const xp = prev[k + 1 + base];
      if (xp >= 0 && xp - (k + 1) < M) byIns = xp;
    }
    const chooseDel = byDel >= byIns;
    const prevK = chooseDel ? k - 1 : k + 1;
    const prevX = prev[prevK + base];
    const prevY = prevX - prevK;
    const xMove = chooseDel ? prevX + 1 : prevX;
    const snake = x - xMove;
    if (snake > 0) { segKind.push(KEEP); segCount.push(snake); }
    segKind.push(chooseDel ? DELETE : INSERT); segCount.push(1);
    x = prevX; y = prevY;
  }
  if (x > 0) { segKind.push(KEEP); segCount.push(x); }
  // Reverse and merge
  const runs = [];
  for (let i = segKind.length - 1; i >= 0; i--) {
    const kind = segKind[i], count = segCount[i];
    const last = runs[runs.length - 1];
    if (last && last[0] === kind) last[1] += count; else runs.push([kind, count]);
  }
  return runs;
}
