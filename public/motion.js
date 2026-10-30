/**
 * BAメーカー 動き始め（歩き始め）自動検出エンジン
 * 動画冒頭を軽量スキャンし、手ブレや明るさ変化を除外して人物が動き出す瞬間（秒）を検出します。
 */
(() => {
  "use strict";

  const GW = 48, GH = 84;          // 解析用キャンバス解像度（9:16）
  const BX = 6, BY = 7;            // 6×7 = 42ブロック分割
  const BW = GW / BX, BH = GH / BY; // 1ブロック 8×12 px
  const STEP_SEC = 0.1;            // 0.1秒刻み
  const MAX_SCAN_SEC = 8.0;        // 冒頭最大8秒までスキャン

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

  /**
   * 輝度フレーム列から動き始めの開始秒数（trimStart）を算出する純粋関数
   * @param {Float32Array[]} frames 各フレームの輝度配列 (長さ GW*GH)
   * @param {number[]} times 各フレームの秒数
   * @returns {number} 推奨開始秒数（0.1秒単位）
   */
  function analyzeFrames(frames, times) {
    const M = frames.length;
    if (M < 8) return 0;

    // 1. オート露出（全体輝度変化）をキャンセルするため各フレームの平均輝度を差し引く
    const norm = frames.map((raw) => {
      let sum = 0;
      for (let i = 0; i < raw.length; i++) sum += raw[i];
      const mean = sum / raw.length;
      const out = new Float32Array(raw.length);
      for (let i = 0; i < raw.length; i++) out[i] = raw[i] - mean;
      return out;
    });

    // 2. 隣接フレーム間のブロック別差分を計算し、外周手ブレフロアを差し引いた中央動作スコアを求める
    const rawScore = new Float32Array(M);
    const bDiff = new Float32Array(BX * BY);

    for (let f = 1; f < M; f++) {
      const prev = norm[f - 1], cur = norm[f];
      bDiff.fill(0);
      for (let y = 0; y < GH; y++) {
        const by = Math.min(BY - 1, (y / BH) | 0);
        const rowOff = y * GW;
        for (let x = 0; x < GW; x++) {
          const bx = Math.min(BX - 1, (x / BW) | 0);
          bDiff[by * BX + bx] += Math.abs(cur[rowOff + x] - prev[rowOff + x]);
        }
      }
      const pixPerBlock = BW * BH;
      const outer = OUTER_BLOCKS.map(i => bDiff[i] / pixPerBlock).sort((a, b) => a - b);
      const inner = INNER_BLOCKS.map(i => bDiff[i] / pixPerBlock).sort((a, b) => b - a);

      // 外周の中央値＝手ブレ・背景ノイズ量
      const bgFloor = outer[(outer.length / 2) | 0] || 0;
      // 中央の上位25%（6ブロック）平均＝身体・脚の動き量
      const topN = Math.max(1, (inner.length * 0.25) | 0);
      let fgSum = 0;
      for (let i = 0; i < topN; i++) fgSum += inner[i];
      const fgPeak = fgSum / topN;

      let sc = Math.max(0, fgPeak - bgFloor * 1.15);
      if (times[f] <= 0.15) sc *= 0.5; // 録画開始直後のカメラ安定待ち
      rawScore[f] = sc;
    }

    // 3. 3点重み付き平滑化
    const smooth = new Float32Array(M);
    for (let f = 1; f < M; f++) {
      const prev = f > 1 ? rawScore[f - 1] : rawScore[f];
      const next = f + 1 < M ? rawScore[f + 1] : rawScore[f];
      smooth[f] = prev * 0.25 + rawScore[f] * 0.5 + next * 0.25;
    }

    // 4. 静止ベースラインと動作ピークの統計判定
    const vals = Array.from(smooth.slice(1)).sort((a, b) => a - b);
    const base = vals[Math.floor(vals.length * 0.25)] || 0;
    const peak = vals[Math.floor(vals.length * 0.85)] || 0;

    // 全体的にほぼ静止している動画は0秒
    if (peak < 2.0 || (peak - base) < 1.5) return 0;

    // 最初からすでに歩いている動画（静止区間がない、または冒頭0.4秒がすでに高スコア）は0秒
    if (base > peak * 0.55) return 0;
    let earlySum = 0, earlyCnt = 0;
    for (let f = 1; f < M && times[f] <= 0.41; f++) {
      earlySum += smooth[f];
      earlyCnt++;
    }
    const th = Math.max(1.8, base + (peak - base) * 0.26);
    if (earlyCnt > 0 && (earlySum / earlyCnt) >= base + (peak - base) * 0.45) return 0;

    // 5. しきい値を超えて継続的に動き始めた最初の瞬間を特定
    for (let f = 1; f < M; f++) {
      if (smooth[f] >= th) {
        const s1 = f + 1 < M ? smooth[f + 1] : smooth[f];
        const s2 = f + 2 < M ? smooth[f + 2] : s1;
        if ((s1 + s2) / 2 >= th * 0.82) {
          // 一歩目の予備動作が自然に見えるよう0.15秒手前を開始位置にする
          const tStart = Math.max(0, Math.round((times[f] - 0.15) * 10) / 10);
          return tStart < 0.2 ? 0 : tStart;
        }
      }
    }
    return 0;
  }

  // iPadのハードウェアデコーダ競合を避けるためスキャンを直列実行するキュー
  let queue = Promise.resolve();

  function seekOnce(v, sec, timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        v.removeEventListener("seeked", finish);
        resolve();
      };
      if (Math.abs(v.currentTime - sec) < 0.005 && !v.seeking && v.readyState >= 2) {
        resolve();
        return;
      }
      v.addEventListener("seeked", finish);
      try { v.currentTime = sec; } catch (e) { finish(); return; }
      setTimeout(finish, timeoutMs || 350);
    });
  }

  function runScan(url, knownDuration, isCancelled) {
    return new Promise((resolve) => {
      const v = document.createElement("video");
      v.muted = true;
      v.playsInline = true;
      v.preload = "auto";
      v.style.cssText = "position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:0;pointer-events:none";
      document.body.appendChild(v);

      const cv = document.createElement("canvas");
      cv.width = GW;
      cv.height = GH;
      const ctx = cv.getContext("2d", { willReadFrequently: true });

      let cleaned = false;
      const cleanup = (result) => {
        if (cleaned) return;
        cleaned = true;
        try {
          v.pause();
          v.removeAttribute("src");
          v.load();
          v.remove();
        } catch (e) {}
        resolve(result || 0);
      };

      const hardTimer = setTimeout(() => cleanup(0), 5000);

      v.onerror = () => { clearTimeout(hardTimer); cleanup(0); };
      v.onloadeddata = async () => {
        try {
          if (isCancelled && isCancelled()) { clearTimeout(hardTimer); cleanup(0); return; }
          const dur = isFinite(v.duration) && v.duration > 0 ? v.duration : (knownDuration || 0);
          if (!isFinite(dur) || dur < 1.3) { clearTimeout(hardTimer); cleanup(0); return; }

          // iPad Safariでデコーダを確実に起こす
          try { await v.play(); v.pause(); } catch (e) {}

          const maxT = Math.min(MAX_SCAN_SEC, dur * 0.65);
          const frames = [];
          const times = [];

          for (let t = 0; t <= maxT + 0.001; t = Math.round((t + STEP_SEC) * 100) / 100) {
            if (isCancelled && isCancelled()) { clearTimeout(hardTimer); cleanup(0); return; }
            await seekOnce(v, t, 320);
            ctx.drawImage(v, 0, 0, GW, GH);
            const img = ctx.getImageData(0, 0, GW, GH).data;
            const luma = new Float32Array(GW * GH);
            let totalLuma = 0;
            for (let i = 0, p = 0; i < img.length; i += 4, p++) {
              const y = img[i] * 0.299 + img[i + 1] * 0.587 + img[i + 2] * 0.114;
              luma[p] = y;
              totalLuma += y;
            }
            // 未デコードの真っ黒フレームは除外
            if (totalLuma > GW * GH * 1.5) {
              frames.push(luma);
              times.push(t);
            }
          }

          clearTimeout(hardTimer);
          const detected = analyzeFrames(frames, times);
          const safeTrim = Math.min(detected, Math.max(0, Math.round((dur - 0.6) * 10) / 10));
          cleanup(safeTrim);
        } catch (e) {
          clearTimeout(hardTimer);
          cleanup(0);
        }
      };

      v.src = url;
    });
  }

  function detectStart(url, knownDuration, isCancelled) {
    const job = queue.then(() => runScan(url, knownDuration, isCancelled));
    queue = job.catch(() => 0);
    return job;
  }

  window.BAM_MOTION = { analyzeFrames, detectStart };
})();
