/**
 * BAメーカー 動き始め（歩き始め）自動検出エンジン（高速・省デコーダ版）
 * 既存の <video> 要素を再利用して粗スキャン（0.25秒刻み＋早期終了）＋局所精密スキャンを行い、
 * iPadのハードウェアデコーダ負荷を最小限に抑えながら歩き始めの瞬間（0.1秒単位）を特定します。
 */
(() => {
  "use strict";

  const GW = 48, GH = 84;           // 解析用キャンバス解像度（9:16）
  const BX = 6, BY = 7;             // 6×7 = 42ブロック分割
  const BW = GW / BX, BH = GH / BY; // 1ブロック 8×12 px
  const COARSE_STEP = 0.25;         // 粗スキャン間隔（秒）
  const MAX_SCAN_SEC = 6.5;         // 冒頭最大スキャン秒数
  const PREROLL_SEC = 0.15;         // 一歩目の予備動作を残す秒数

  // 外周（背景・手ブレ計測）と中央（人物動作）のブロックインデックスを事前計算
  const OUTER_BLOCKS = [];
  const INNER_BLOCKS = [];
  for (let by = 0; by < BY; by++) {
    for (let bx = 0; bx < BX; bx++) {
      const idx = by * BX + bx;
      if (bx === 0 || bx === BX - 1 || by === 0) OUTER_BLOCKS.push(idx);
      else INNER_BLOCKS.push(idx);
    }
  }

  function normalizeFrame(raw) {
    let sum = 0;
    for (let i = 0; i < raw.length; i++) sum += raw[i];
    const mean = sum / raw.length;
    const out = new Float32Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw[i] - mean;
    return out;
  }

  const bDiffScratch = new Float32Array(BX * BY);

  function pairMotionScore(prevNorm, curNorm, timeSec) {
    bDiffScratch.fill(0);
    for (let y = 0; y < GH; y++) {
      const by = Math.min(BY - 1, (y / BH) | 0);
      const rowOff = y * GW;
      for (let x = 0; x < GW; x++) {
        const bx = Math.min(BX - 1, (x / BW) | 0);
        bDiffScratch[by * BX + bx] += Math.abs(curNorm[rowOff + x] - prevNorm[rowOff + x]);
      }
    }
    const pixPerBlock = BW * BH;
    const outer = OUTER_BLOCKS.map(i => bDiffScratch[i] / pixPerBlock).sort((a, b) => a - b);
    const inner = INNER_BLOCKS.map(i => bDiffScratch[i] / pixPerBlock).sort((a, b) => b - a);

    const bgFloor = outer[(outer.length / 2) | 0] || 0;
    const topN = Math.max(1, (inner.length * 0.25) | 0);
    let fgSum = 0;
    for (let i = 0; i < topN; i++) fgSum += inner[i];
    const fgPeak = fgSum / topN;

    let sc = Math.max(0, fgPeak - bgFloor * 1.15);
    if (timeSec <= 0.16) sc *= 0.5;
    return sc;
  }

  /**
   * 輝度フレーム列から動き始めの詳細情報を算出する純粋関数
   */
  function analyzeDetail(frames, times, preNormalized) {
    const M = frames.length;
    if (M < 6) return { trimStart: 0, onsetIdx: -1, base: 0, peak: 0, th: 0, norm: [] };

    const norm = preNormalized ? frames : frames.map(normalizeFrame);
    const rawScore = new Float32Array(M);
    for (let f = 1; f < M; f++) {
      rawScore[f] = pairMotionScore(norm[f - 1], norm[f], times[f]);
    }

    const smooth = new Float32Array(M);
    for (let f = 1; f < M; f++) {
      const prev = f > 1 ? rawScore[f - 1] : rawScore[f];
      const next = f + 1 < M ? rawScore[f + 1] : rawScore[f];
      smooth[f] = prev * 0.25 + rawScore[f] * 0.5 + next * 0.25;
    }

    const vals = Array.from(smooth.slice(1)).sort((a, b) => a - b);
    const base = vals[Math.floor(vals.length * 0.25)] || 0;
    const peak = vals[Math.floor(vals.length * 0.85)] || 0;

    if (peak < 2.0 || (peak - base) < 1.5) {
      return { trimStart: 0, onsetIdx: -1, base, peak, th: 0, norm };
    }
    if (base > peak * 0.55) {
      return { trimStart: 0, onsetIdx: -1, base, peak, th: 0, norm };
    }

    const step = times.length > 1 ? Math.max(0.05, times[1] - times[0]) : 0.1;
    const earlyLim = Math.max(0.41, step * 2.05);
    let earlySum = 0, earlyCnt = 0;
    for (let f = 1; f < M && times[f] <= earlyLim; f++) {
      earlySum += smooth[f];
      earlyCnt++;
    }
    const th = Math.max(1.8, base + (peak - base) * 0.26);
    if (earlyCnt > 0 && (earlySum / earlyCnt) >= base + (peak - base) * 0.45) {
      return { trimStart: 0, onsetIdx: -1, base, peak, th, norm };
    }

    for (let f = 1; f < M; f++) {
      if (smooth[f] >= th) {
        const s1 = f + 1 < M ? smooth[f + 1] : smooth[f];
        const s2 = f + 2 < M ? smooth[f + 2] : s1;
        if ((s1 + s2) / 2 >= th * 0.82) {
          const tStart = Math.max(0, Math.round((times[f] - PREROLL_SEC) * 10) / 10);
          return {
            trimStart: tStart < 0.2 ? 0 : tStart,
            onsetIdx: f,
            base,
            peak,
            th,
            norm
          };
        }
      }
    }
    return { trimStart: 0, onsetIdx: -1, base, peak, th, norm };
  }

  function analyzeFrames(frames, times) {
    return analyzeDetail(frames, times, false).trimStart;
  }

  // スキャンを直列実行するキュー（デコーダ競合防止）
  let queue = Promise.resolve();

  function seekOnce(v, sec, timeoutMs) {
    return new Promise((resolve) => {
      const target = Math.max(0, sec || 0);
      if (Math.abs(v.currentTime - target) < 0.005 && !v.seeking && v.readyState >= 2) {
        resolve();
        return;
      }
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        v.removeEventListener("seeked", finish);
        resolve();
      };
      v.addEventListener("seeked", finish);
      try { v.currentTime = target; } catch (e) { finish(); return; }
      setTimeout(finish, timeoutMs || 260);
    });
  }

  function grabNormalizedLuma(ctx, v) {
    ctx.drawImage(v, 0, 0, GW, GH);
    const img = ctx.getImageData(0, 0, GW, GH).data;
    const luma = new Float32Array(GW * GH);
    let totalLuma = 0;
    for (let i = 0, p = 0; i < img.length; i += 4, p++) {
      const y = img[i] * 0.299 + img[i + 1] * 0.587 + img[i + 2] * 0.114;
      luma[p] = y;
      totalLuma += y;
    }
    if (totalLuma <= GW * GH * 1.5) return null;
    return normalizeFrame(luma);
  }

  let sharedScanCtx = null;
  function getScanCtx() {
    if (!sharedScanCtx) {
      const cv = document.createElement("canvas");
      cv.width = GW;
      cv.height = GH;
      sharedScanCtx = cv.getContext("2d", { willReadFrequently: true });
    }
    return sharedScanCtx;
  }
  const yieldStep = () => new Promise((r) => setTimeout(r, 0));

  function runScan(videoOrUrl, knownDuration, isCancelled) {
    return new Promise((resolve) => {
      const reuseVideo = !!(videoOrUrl && typeof videoOrUrl === "object" && videoOrUrl.tagName === "VIDEO");
      const v = reuseVideo ? videoOrUrl : document.createElement("video");
      if (!reuseVideo) {
        v.muted = true;
        v.playsInline = true;
        v.preload = "auto";
        v.width = 2;
        v.height = 2;
        v.setAttribute("playsinline", "");
        v.setAttribute("webkit-playsinline", "");
        v.style.cssText = "position:fixed;right:2px;bottom:2px;width:2px;height:2px;opacity:0.004;pointer-events:none;z-index:9;contain:strict";
        document.body.appendChild(v);
      } else {
        try { v.pause(); } catch (e) {}
      }

      const ctx = getScanCtx();

      let cleaned = false;
      const cleanup = (result) => {
        if (cleaned) return;
        cleaned = true;
        if (!reuseVideo) {
          try {
            v.onloadeddata = null;
            v.onerror = null;
            v.pause();
            v.removeAttribute("src");
            v.load();
            v.remove();
          } catch (e) {}
        }
        resolve(result || 0);
      };

      const hardTimer = setTimeout(() => cleanup(0), 3200);

      const executeScan = async () => {
        try {
          if (isCancelled && isCancelled()) { clearTimeout(hardTimer); cleanup(0); return; }
          const dur = isFinite(v.duration) && v.duration > 0 ? v.duration : (knownDuration || 0);
          if (!isFinite(dur) || dur < 1.3) { clearTimeout(hardTimer); cleanup(0); return; }

          const maxT = Math.min(MAX_SCAN_SEC, dur * 0.65);
          const normFrames = [];
          const times = [];
          const pairScores = [];

          // 1. 0.25秒刻みの高速粗スキャン（毎ステップでメインスレッドへ制御を返しUI凍結を防止）
          for (let t = 0; t <= maxT + 0.001; t = Math.round((t + COARSE_STEP) * 100) / 100) {
            if (isCancelled && isCancelled()) { clearTimeout(hardTimer); cleanup(0); return; }
            await seekOnce(v, t, 240);
            const nf = grabNormalizedLuma(ctx, v);
            await yieldStep();
            if (!nf) continue;
            if (normFrames.length > 0) {
              pairScores.push(pairMotionScore(normFrames[normFrames.length - 1], nf, t));
            }
            normFrames.push(nf);
            times.push(t);

            // 早期終了判定：静止区間（低スコア3点以上）の後に高スコア歩行が4区間（1.0秒）連続したら以降のシークを省略
            if (pairScores.length >= 8) {
              let quietSum = 0, quietCnt = 0;
              for (let i = 0; i < pairScores.length - 4; i++) {
                if (pairScores[i] < 2.6) { quietSum += pairScores[i]; quietCnt++; }
              }
              if (quietCnt >= 3) {
                const qAvg = quietSum / quietCnt;
                const activeTh = Math.max(4.2, qAvg * 3.2);
                const n = pairScores.length;
                if (
                  pairScores[n - 1] >= activeTh &&
                  pairScores[n - 2] >= activeTh &&
                  pairScores[n - 3] >= activeTh &&
                  pairScores[n - 4] >= activeTh
                ) {
                  break;
                }
              }
            }
          }

          const res = analyzeDetail(normFrames, times, true);
          let detected = res.trimStart;

          // 2. 粗スキャンで開始区間が見つかった場合のみ、直前0.3秒間を最大2回だけ精密チェック（0.1秒精度）
          if (res.onsetIdx >= 1 && !(isCancelled && isCancelled())) {
            const refIdx = Math.max(0, res.onsetIdx - 2);
            const refNorm = normFrames[refIdx];
            const tLow = times[Math.max(0, res.onsetIdx - 1)];
            const tHigh = times[res.onsetIdx];
            const fineTh = Math.max(1.8, res.base + (res.peak - res.base) * 0.24);
            let refinedOnset = tHigh;

            for (const frac of [0.33, 0.67]) {
              if (isCancelled && isCancelled()) break;
              const tf = Math.round((tLow + (tHigh - tLow) * frac) * 100) / 100;
              await seekOnce(v, tf, 200);
              const nf = grabNormalizedLuma(ctx, v);
              await yieldStep();
              if (nf && pairMotionScore(refNorm, nf, tf) >= fineTh) {
                refinedOnset = tf;
                break;
              }
            }
            const tStart = Math.max(0, Math.round((refinedOnset - PREROLL_SEC) * 10) / 10);
            detected = tStart < 0.2 ? 0 : tStart;
          }

          if (reuseVideo && v.seeking) {
            await new Promise((r) => {
              let d = false;
              const f = () => { if (!d) { d = true; v.removeEventListener("seeked", f); r(); } };
              v.addEventListener("seeked", f);
              setTimeout(f, 300);
            });
          }
          clearTimeout(hardTimer);
          const safeTrim = Math.min(detected, Math.max(0, Math.round((dur - 0.6) * 10) / 10));
          cleanup(safeTrim);
        } catch (e) {
          clearTimeout(hardTimer);
          cleanup(0);
        }
      };

      if (reuseVideo && v.readyState >= 2) {
        executeScan();
      } else {
        v.onerror = () => { clearTimeout(hardTimer); cleanup(0); };
        v.onloadeddata = executeScan;
        if (!reuseVideo) v.src = videoOrUrl;
      }
    });
  }

  function detectStart(videoOrUrl, knownDuration, isCancelled) {
    const job = queue.then(() => runScan(videoOrUrl, knownDuration, isCancelled));
    queue = job.catch(() => 0);
    return job;
  }

  window.BAM_MOTION = { analyzeFrames, analyzeDetail, detectStart };
})();
