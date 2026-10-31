/**
 * BAメーカー 顔ぼかし＆自動追従エンジン（ブラウザ内完結・サーバー送信なし）
 *
 * 1. AI自動顔検出（MediaPipe Tasks Vision BlazeFace）による動画・画像の自動顔追従
 * 2. 正面顔が映らない横顔・後ろ姿・オフライン環境向けの自動フォールバック：
 *    - シルエット頭部推定 ＋ RGB/輝度テンプレートパッチ追従（前方・後方双方向）
 *    - プレビュー上で丸を合わせた位置からの「指定位置からの頭自動追従」
 *    - 動かない姿勢写真・動画向けの「手動位置固定」＋ドラッグ微調整＆サイズ変更
 * 3. iOS Safari を含む全ブラウザで 0.1ms 以下で動作する多段バイリニア平滑ガウシアン風楕円ぼかし描画
 */
(() => {
  "use strict";

  const VISION_ESM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";
  const VISION_WASM_DIR = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
  const FACE_MODEL_URL = "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite";

  const SCAN_W = 96;
  const SCAN_H = 170;
  const PATCH_R = 5; // 11x11 パッチ（96x170空間）
  const SEARCH_RX = 18;
  const SEARCH_RY = 20;
  const STEP_SEC = 0.25;
  const MAX_TRACK_SEC = 35;

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const yieldStep = () => new Promise((r) => setTimeout(r, 0));

  // ---------- MediaPipe BlazeFace 遅延ローダー ----------
  let detectorPromise = null;
  let detectorUnavailable = false;

  async function getFaceDetector() {
    if (detectorUnavailable) return null;
    if (detectorPromise) return detectorPromise;
    detectorPromise = (async () => {
      try {
        const mod = await Promise.race([
          import(VISION_ESM_URL),
          new Promise((_, rej) => setTimeout(() => rej(new Error("vision_timeout")), 5500))
        ]);
        const FilesetResolver = mod.FilesetResolver;
        const FaceDetector = mod.FaceDetector;
        if (!FilesetResolver || !FaceDetector) throw new Error("vision_api_missing");
        const vision = await Promise.race([
          FilesetResolver.forVisionTasks(VISION_WASM_DIR),
          new Promise((_, rej) => setTimeout(() => rej(new Error("wasm_timeout")), 5500))
        ]);
        try {
          return await FaceDetector.createFromOptions(vision, {
            baseOptions: { modelAssetPath: FACE_MODEL_URL, delegate: "GPU" },
            runningMode: "IMAGE",
            minDetectionConfidence: 0.42
          });
        } catch (gpuErr) {
          return await FaceDetector.createFromOptions(vision, {
            baseOptions: { modelAssetPath: FACE_MODEL_URL, delegate: "CPU" },
            runningMode: "IMAGE",
            minDetectionConfidence: 0.42
          });
        }
      } catch (e) {
        detectorUnavailable = true;
        return null;
      }
    })();
    return detectorPromise;
  }

  // ---------- 解析用オフスクリーンキャンバス ----------
  let aiCanvas = null, aiCtx = null;
  let patchCanvas = null, patchCtx = null;

  function ensureScanCanvases() {
    if (!aiCanvas) {
      aiCanvas = document.createElement("canvas");
      aiCtx = aiCanvas.getContext("2d", { willReadFrequently: true });
    }
    if (!patchCanvas) {
      patchCanvas = document.createElement("canvas");
      patchCanvas.width = SCAN_W;
      patchCanvas.height = SCAN_H;
      patchCtx = patchCanvas.getContext("2d", { willReadFrequently: true });
    }
  }

  function detectFaceOnSource(detector, sourceEl, srcW, srcH) {
    if (!detector || !srcW || !srcH) return null;
    ensureScanCanvases();
    const scale = Math.min(1, 320 / Math.max(srcW, srcH));
    const dw = Math.max(32, Math.round(srcW * scale));
    const dh = Math.max(32, Math.round(srcH * scale));
    if (aiCanvas.width !== dw || aiCanvas.height !== dh) {
      aiCanvas.width = dw;
      aiCanvas.height = dh;
    }
    try {
      aiCtx.drawImage(sourceEl, 0, 0, dw, dh);
      const res = detector.detect(aiCanvas);
      const list = (res && res.detections) ? res.detections : [];
      if (!list.length) return null;

      // 複数人映り込み時は「画面上部〜中央寄り＆面積が大きい人物」を優先選択
      let best = null, bestScore = -1;
      for (let i = 0; i < list.length; i++) {
        const d = list[i];
        const bb = d.boundingBox;
        if (!bb || bb.width <= 0 || bb.height <= 0) continue;
        const cx = (bb.originX + bb.width / 2) / dw;
        const cy = (bb.originY + bb.height / 2) / dh;
        const nr = Math.max(bb.width, bb.height) / Math.min(dw, dh) * 0.62;
        const conf = (d.categories && d.categories[0] && d.categories[0].score) || 0.5;
        const centerBias = 1 - Math.abs(cx - 0.5) * 0.45;
        const upperBias = cy < 0.72 ? 1.15 : 0.7;
        const areaBias = clamp(nr * 4.5, 0.35, 1.4);
        const score = conf * centerBias * upperBias * areaBias;
        if (score > bestScore) {
          bestScore = score;
          // 額・顎までしっかり隠れるよう中心をわずかに上へ補正し半径に余裕を持たせる
          best = {
            mx: clamp(cx, 0.04, 0.96),
            my: clamp(cy - (bb.height / dh) * 0.06, 0.04, 0.96),
            mr: clamp(nr * 1.12, 0.045, 0.34),
            conf
          };
        }
      }
      return best;
    } catch (e) {
      return null;
    }
  }

  // ---------- パッチ特徴抽出＆シルエット頭部推定（正面顔がない横顔・後ろ姿対応） ----------
  function grabScanBuffer(sourceEl) {
    ensureScanCanvases();
    try {
      patchCtx.drawImage(sourceEl, 0, 0, SCAN_W, SCAN_H);
      const data = patchCtx.getImageData(0, 0, SCAN_W, SCAN_H).data;
      const n = SCAN_W * SCAN_H;
      // 3チャンネル軽量特徴: [Luma, R-G, B-Luma]
      const feat = new Float32Array(n * 3);
      for (let i = 0, p = 0; i < n; i++, p += 4) {
        const r = data[p], g = data[p + 1], b = data[p + 2];
        const y = 0.299 * r + 0.587 * g + 0.114 * b;
        feat[i * 3] = y;
        feat[i * 3 + 1] = r - g;
        feat[i * 3 + 2] = b - y;
      }
      return feat;
    } catch (e) {
      return null;
    }
  }

  /**
   * 背景壁（左右端の平均色）との色差・エッジから人物の上部（頭部）を推定する。
   * 正面顔が検出できない後ろ姿・横向き姿勢の初期配置に使用。
   */
  function estimateHeadFromBuffer(feat) {
    if (!feat) return { mx: 0.5, my: 0.20, mr: 0.105 };
    let bgY = 0, bgRG = 0, bgBY = 0, bgCnt = 0;
    const yMaxBg = Math.floor(SCAN_H * 0.55);
    for (let y = 4; y < yMaxBg; y += 2) {
      for (const x of [2, 5, SCAN_W - 6, SCAN_W - 3]) {
        const idx = (y * SCAN_W + x) * 3;
        bgY += feat[idx];
        bgRG += feat[idx + 1];
        bgBY += feat[idx + 2];
        bgCnt++;
      }
    }
    if (!bgCnt) return { mx: 0.5, my: 0.20, mr: 0.105 };
    bgY /= bgCnt; bgRG /= bgCnt; bgBY /= bgCnt;

    const xMin = Math.floor(SCAN_W * 0.16);
    const xMax = Math.ceil(SCAN_W * 0.84);
    const yMin = Math.floor(SCAN_H * 0.05);
    const yMax = Math.floor(SCAN_H * 0.46);

    const rowMass = new Float32Array(SCAN_H);
    const rowCenter = new Float32Array(SCAN_H);

    for (let y = yMin; y <= yMax; y++) {
      let mass = 0, wx = 0;
      for (let x = xMin; x <= xMax; x++) {
        const idx = (y * SCAN_W + x) * 3;
        const dy = Math.abs(feat[idx] - bgY);
        const drg = Math.abs(feat[idx + 1] - bgRG);
        const dby = Math.abs(feat[idx + 2] - bgBY);
        const diff = dy + drg * 0.8 + dby * 0.6;
        if (diff > 24) {
          const w = diff - 24;
          mass += w;
          wx += x * w;
        }
      }
      rowMass[y] = mass;
      rowCenter[y] = mass > 0 ? wx / mass : SCAN_W / 2;
    }

    let peakMass = 0;
    for (let y = yMin; y <= yMax; y++) {
      if (rowMass[y] > peakMass) peakMass = rowMass[y];
    }
    if (peakMass < 160) {
      return { mx: 0.5, my: 0.20, mr: 0.105 };
    }

    const th = peakMass * 0.26;
    let topY = -1;
    for (let y = yMin; y <= yMax - 4; y++) {
      if (rowMass[y] >= th && rowMass[y + 1] >= th && rowMass[y + 2] >= th) {
        topY = y;
        break;
      }
    }
    if (topY < 0) return { mx: 0.5, my: 0.20, mr: 0.105 };

    // 頭頂(topY)から約0.075H下が頭部中心
    const headH = Math.round(SCAN_H * 0.075);
    const cy = clamp(topY + headH, yMin + 4, yMax);
    let sumW = 0, sumX = 0;
    for (let y = topY; y <= Math.min(yMax, topY + headH * 2); y++) {
      const w = rowMass[y] + 1;
      sumW += w;
      sumX += rowCenter[y] * w;
    }
    const cx = sumW > 0 ? sumX / sumW : SCAN_W / 2;
    return {
      mx: clamp(cx / SCAN_W, 0.12, 0.88),
      my: clamp(cy / SCAN_H, 0.08, 0.48),
      mr: 0.105
    };
  }

  function extractPatch(feat, mx, my) {
    const cx = clamp(Math.round(mx * SCAN_W), PATCH_R + 1, SCAN_W - PATCH_R - 2);
    const cy = clamp(Math.round(my * SCAN_H), PATCH_R + 1, SCAN_H - PATCH_R - 2);
    const side = PATCH_R * 2 + 1;
    const tpl = new Float32Array(side * side * 3);
    let k = 0, meanY = 0;
    for (let dy = -PATCH_R; dy <= PATCH_R; dy++) {
      for (let dx = -PATCH_R; dx <= PATCH_R; dx++) {
        const idx = ((cy + dy) * SCAN_W + (cx + dx)) * 3;
        tpl[k] = feat[idx];
        tpl[k + 1] = feat[idx + 1];
        tpl[k + 2] = feat[idx + 2];
        meanY += feat[idx];
        k += 3;
      }
    }
    meanY /= (side * side);
    return { tpl, meanY, cx, cy };
  }

  function matchPatch(feat, patch, prevMx, prevMy, anchorMx, anchorMy) {
    const side = PATCH_R * 2 + 1;
    const count = side * side;
    const pcx = clamp(Math.round(prevMx * SCAN_W), PATCH_R + 1, SCAN_W - PATCH_R - 2);
    const pcy = clamp(Math.round(prevMy * SCAN_H), PATCH_R + 1, SCAN_H - PATCH_R - 2);
    const acx = anchorMx * SCAN_W;
    const acy = anchorMy * SCAN_H;

    const x0 = Math.max(PATCH_R + 1, pcx - SEARCH_RX);
    const x1 = Math.min(SCAN_W - PATCH_R - 2, pcx + SEARCH_RX);
    const y0 = Math.max(PATCH_R + 1, pcy - SEARCH_RY);
    const y1 = Math.min(SCAN_H - PATCH_R - 2, pcy + SEARCH_RY);

    let bestCost = Infinity;
    let bestX = pcx, bestY = pcy;

    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        // 候補領域の平均輝度を求めて照明変化を吸収
        let candMeanY = 0;
        for (let dy = -PATCH_R; dy <= PATCH_R; dy += 2) {
          const rowOff = (cy + dy) * SCAN_W;
          for (let dx = -PATCH_R; dx <= PATCH_R; dx += 2) {
            candMeanY += feat[(rowOff + cx + dx) * 3];
          }
        }
        const subCnt = Math.ceil(side / 2) * Math.ceil(side / 2);
        const lumShift = candMeanY / subCnt - patch.meanY;

        let sad = 0, k = 0;
        for (let dy = -PATCH_R; dy <= PATCH_R; dy++) {
          const rowOff = (cy + dy) * SCAN_W;
          for (let dx = -PATCH_R; dx <= PATCH_R; dx++) {
            const idx = (rowOff + cx + dx) * 3;
            sad += Math.abs((feat[idx] - lumShift) - patch.tpl[k])
                 + Math.abs(feat[idx + 1] - patch.tpl[k + 1]) * 0.85
                 + Math.abs(feat[idx + 2] - patch.tpl[k + 2]) * 0.65;
            k += 3;
          }
        }
        // 急激な背景ジャンプを防ぐための微小な連続性正則化
        const stepDist = Math.hypot(cx - pcx, cy - pcy);
        const anchorYDrift = Math.abs(cy - acy);
        const cost = (sad / count) + stepDist * 0.42 + anchorYDrift * 0.14;
        if (cost < bestCost) {
          bestCost = cost;
          bestX = cx;
          bestY = cy;
        }
      }
    }

    return {
      mx: clamp(bestX / SCAN_W, 0.04, 0.96),
      my: clamp(bestY / SCAN_H, 0.04, 0.96),
      cost: bestCost
    };
  }

  function smoothKeyframes(frames) {
    if (!frames || frames.length <= 2) return frames || [];
    const out = frames.map((f) => ({ ...f }));
    for (let i = 1; i < out.length - 1; i++) {
      out[i].mx = out[i - 1].mx * 0.22 + out[i].mx * 0.56 + out[i + 1].mx * 0.22;
      out[i].my = out[i - 1].my * 0.22 + out[i].my * 0.56 + out[i + 1].my * 0.22;
      out[i].mr = out[i - 1].mr * 0.25 + out[i].mr * 0.50 + out[i + 1].mr * 0.25;
    }
    return out;
  }

  // ---------- 使い捨て 2x2 video シークヘルパー（本番再生用 <video> を一切ブロックしない） ----------
  function seekOnce(v, t, timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        v.removeEventListener("seeked", finish);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs || 260);
      v.addEventListener("seeked", finish);
      try {
        if (Math.abs(v.currentTime - t) < 0.008 && !v.seeking && v.readyState >= 2) {
          finish();
          return;
        }
        v.currentTime = t;
      } catch (e) {
        finish();
      }
    });
  }

  function withTempVideo(url, knownDuration, workFn) {
    return new Promise((resolve) => {
      const v = document.createElement("video");
      v.muted = true;
      v.playsInline = true;
      v.preload = "auto";
      v.width = 2;
      v.height = 2;
      v.setAttribute("playsinline", "");
      v.setAttribute("webkit-playsinline", "");
      v.style.cssText = "position:fixed;right:2px;bottom:2px;width:2px;height:2px;opacity:0.004;pointer-events:none;z-index:9;contain:strict";
      document.body.appendChild(v);

      let cleaned = false;
      const cleanup = (val) => {
        if (cleaned) return;
        cleaned = true;
        clearTimeout(hardTimer);
        try {
          v.onloadeddata = null;
          v.onerror = null;
          v.pause();
          v.removeAttribute("src");
          v.load();
          v.remove();
        } catch (e) {}
        resolve(val);
      };

      const hardTimer = setTimeout(() => cleanup(null), 9000);
      v.onerror = () => cleanup(null);
      v.onloadeddata = async () => {
        try {
          const dur = (isFinite(v.duration) && v.duration > 0) ? v.duration : (knownDuration || 0);
          const res = await workFn(v, dur);
          cleanup(res);
        } catch (e) {
          cleanup(null);
        }
      };
      v.src = url;
    });
  }

  // ---------- 静止画の顔検出＋フォールバック ----------
  async function trackImage(imgEl, isCancelled) {
    if (!imgEl || !imgEl.naturalWidth || !imgEl.naturalHeight) {
      return { status: "fallback", mx: 0.5, my: 0.22, mr: 0.11, keyframes: [] };
    }
    const detector = await getFaceDetector();
    if (isCancelled && isCancelled()) return null;
    const hit = detectFaceOnSource(detector, imgEl, imgEl.naturalWidth, imgEl.naturalHeight);
    if (hit) {
      return {
        status: "ai_ok",
        mx: hit.mx,
        my: hit.my,
        mr: hit.mr,
        keyframes: [{ t: 0, mx: hit.mx, my: hit.my, mr: hit.mr }]
      };
    }
    const feat = grabScanBuffer(imgEl);
    const est = estimateHeadFromBuffer(feat);
    return {
      status: "fallback",
      mx: est.mx,
      my: est.my,
      mr: est.mr,
      keyframes: [{ t: 0, mx: est.mx, my: est.my, mr: est.mr }]
    };
  }

  // ---------- 動画のAI自動顔追従＋欠損区間パッチ補間＋シルエットフォールバック ----------
  async function trackVideoAuto(url, knownDuration, isCancelled) {
    const detector = await getFaceDetector();
    if (isCancelled && isCancelled()) return null;

    return await withTempVideo(url, knownDuration, async (v, dur) => {
      if (!dur || dur <= 0) return null;
      const vw = v.videoWidth || 360, vh = v.videoHeight || 640;
      const maxT = Math.min(MAX_TRACK_SEC, dur);
      const times = [];
      for (let t = 0; t <= maxT - 0.02; t = Math.round((t + STEP_SEC) * 100) / 100) {
        times.push(t);
      }
      if (!times.length || times[times.length - 1] < maxT - 0.1) {
        times.push(Math.max(0, Math.round((maxT - 0.05) * 100) / 100));
      }

      const feats = [];
      const aiHits = [];
      let aiHitCount = 0;

      for (let i = 0; i < times.length; i++) {
        if (isCancelled && isCancelled()) return null;
        await seekOnce(v, times[i], 240);
        const hit = detector ? detectFaceOnSource(detector, v, vw, vh) : null;
        const feat = grabScanBuffer(v);
        aiHits.push(hit);
        feats.push(feat);
        if (hit) aiHitCount++;
        await yieldStep();
      }

      const frames = new Array(times.length);

      if (aiHitCount > 0) {
        // AI検出できたフレームを確定し、横を向いた等の未検出フレームは直近のAI顔パッチから前後双方向で追跡補間
        let firstIdx = -1;
        for (let i = 0; i < times.length; i++) {
          if (aiHits[i]) {
            frames[i] = { t: times[i], mx: aiHits[i].mx, my: aiHits[i].my, mr: aiHits[i].mr };
            if (firstIdx < 0) firstIdx = i;
          }
        }
        // 前方補間
        let refPatch = feats[firstIdx] ? extractPatch(feats[firstIdx], frames[firstIdx].mx, frames[firstIdx].my) : null;
        let anchor = frames[firstIdx];
        for (let i = firstIdx + 1; i < times.length; i++) {
          if (frames[i]) {
            if (feats[i]) refPatch = extractPatch(feats[i], frames[i].mx, frames[i].my);
            anchor = frames[i];
          } else if (refPatch && feats[i]) {
            const m = matchPatch(feats[i], refPatch, frames[i - 1].mx, frames[i - 1].my, anchor.mx, anchor.my);
            frames[i] = { t: times[i], mx: m.mx, my: m.my, mr: frames[i - 1].mr };
          } else {
            frames[i] = { t: times[i], mx: frames[i - 1].mx, my: frames[i - 1].my, mr: frames[i - 1].mr };
          }
        }
        // 後方補間（動画冒頭で下や横を向いていた場合）
        refPatch = feats[firstIdx] ? extractPatch(feats[firstIdx], frames[firstIdx].mx, frames[firstIdx].my) : null;
        anchor = frames[firstIdx];
        for (let i = firstIdx - 1; i >= 0; i--) {
          if (refPatch && feats[i]) {
            const m = matchPatch(feats[i], refPatch, frames[i + 1].mx, frames[i + 1].my, anchor.mx, anchor.my);
            frames[i] = { t: times[i], mx: m.mx, my: m.my, mr: frames[i + 1].mr };
          } else {
            frames[i] = { t: times[i], mx: frames[i + 1].mx, my: frames[i + 1].my, mr: frames[i + 1].mr };
          }
        }
        const smoothed = smoothKeyframes(frames);
        return {
          status: "ai_ok",
          mx: smoothed[0].mx,
          my: smoothed[0].my,
          mr: smoothed[0].mr,
          keyframes: smoothed
        };
      }

      // 正面顔が1フレームも検出されなかった場合（後ろ姿・真横の歩行動画など）：
      // 先頭フレームの人物シルエット頭頂からパッチ自動追従を生成し、手動再追従・固定への案内も出す
      const est = estimateHeadFromBuffer(feats[0]);
      frames[0] = { t: times[0], mx: est.mx, my: est.my, mr: est.mr };
      const refPatch = feats[0] ? extractPatch(feats[0], est.mx, est.my) : null;
      for (let i = 1; i < times.length; i++) {
        if (refPatch && feats[i]) {
          const m = matchPatch(feats[i], refPatch, frames[i - 1].mx, frames[i - 1].my, est.mx, est.my);
          frames[i] = { t: times[i], mx: m.mx, my: m.my, mr: est.mr };
        } else {
          frames[i] = { t: times[i], mx: frames[i - 1].mx, my: frames[i - 1].my, mr: est.mr };
        }
      }
      const smoothed = smoothKeyframes(frames);
      return {
        status: "fallback",
        mx: smoothed[0].mx,
        my: smoothed[0].my,
        mr: smoothed[0].mr,
        keyframes: smoothed
      };
    });
  }

  // ---------- ユーザーが頭に合わせて指定した位置からの双方向パッチ自動追従（横顔・後ろ姿の決定版対処法） ----------
  async function trackVideoFromAnchor(url, knownDuration, anchor, isCancelled) {
    const aTime = Math.max(0, Number(anchor && anchor.t) || 0);
    const aMx = clamp(Number(anchor && anchor.mx) || 0.5, 0.04, 0.96);
    const aMy = clamp(Number(anchor && anchor.my) || 0.22, 0.04, 0.96);
    const aMr = clamp(Number(anchor && anchor.mr) || 0.11, 0.04, 0.35);

    return await withTempVideo(url, knownDuration, async (v, dur) => {
      if (!dur || dur <= 0) return null;
      const maxT = Math.min(MAX_TRACK_SEC, dur);
      const times = [];
      for (let t = 0; t <= maxT - 0.02; t = Math.round((t + STEP_SEC) * 100) / 100) {
        times.push(t);
      }
      if (!times.length) times.push(0);

      let anchorIdx = 0, minDiff = Infinity;
      for (let i = 0; i < times.length; i++) {
        const d = Math.abs(times[i] - aTime);
        if (d < minDiff) { minDiff = d; anchorIdx = i; }
      }

      const feats = new Array(times.length);
      for (let i = 0; i < times.length; i++) {
        if (isCancelled && isCancelled()) return null;
        await seekOnce(v, times[i], 240);
        feats[i] = grabScanBuffer(v);
        await yieldStep();
      }

      const frames = new Array(times.length);
      frames[anchorIdx] = { t: times[anchorIdx], mx: aMx, my: aMy, mr: aMr };
      const refPatch = feats[anchorIdx] ? extractPatch(feats[anchorIdx], aMx, aMy) : null;

      for (let i = anchorIdx + 1; i < times.length; i++) {
        if (refPatch && feats[i]) {
          const m = matchPatch(feats[i], refPatch, frames[i - 1].mx, frames[i - 1].my, aMx, aMy);
          frames[i] = { t: times[i], mx: m.mx, my: m.my, mr: aMr };
        } else {
          frames[i] = { t: times[i], mx: frames[i - 1].mx, my: frames[i - 1].my, mr: aMr };
        }
      }
      for (let i = anchorIdx - 1; i >= 0; i--) {
        if (refPatch && feats[i]) {
          const m = matchPatch(feats[i], refPatch, frames[i + 1].mx, frames[i + 1].my, aMx, aMy);
          frames[i] = { t: times[i], mx: m.mx, my: m.my, mr: aMr };
        } else {
          frames[i] = { t: times[i], mx: frames[i + 1].mx, my: frames[i + 1].my, mr: aMr };
        }
      }

      const smoothed = smoothKeyframes(frames);
      return {
        status: "patch_ok",
        mx: aMx,
        my: aMy,
        mr: aMr,
        keyframes: smoothed
      };
    });
  }

  // ---------- 再生時刻 currentTime における補間サンプリング（O(log N)・0.001ms以下） ----------
  function sampleAtTime(blur, currentTime) {
    if (!blur) return { mx: 0.5, my: 0.22, mr: 0.11 };
    if (blur.mode === "fixed") {
      return {
        mx: clamp(blur.fixedX, 0.02, 0.98),
        my: clamp(blur.fixedY, 0.02, 0.98),
        mr: clamp(blur.baseR || 0.11, 0.04, 0.36)
      };
    }
    const kf = blur.keyframes;
    let mx = blur.fixedX, my = blur.fixedY, mr = blur.baseR || 0.11;
    if (kf && kf.length > 0) {
      const t = Math.max(0, Number(currentTime) || 0);
      if (kf.length === 1 || t <= kf[0].t) {
        mx = kf[0].mx; my = kf[0].my; mr = kf[0].mr;
      } else if (t >= kf[kf.length - 1].t) {
        const last = kf[kf.length - 1];
        mx = last.mx; my = last.my; mr = last.mr;
      } else {
        let lo = 0, hi = kf.length - 1;
        while (lo + 1 < hi) {
          const mid = (lo + hi) >> 1;
          if (kf[mid].t <= t) lo = mid;
          else hi = mid;
        }
        const a = kf[lo], b = kf[hi];
        const span = Math.max(0.0001, b.t - a.t);
        const u = clamp((t - a.t) / span, 0, 1);
        mx = a.mx + (b.mx - a.mx) * u;
        my = a.my + (b.my - a.my) * u;
        mr = a.mr + (b.mr - a.mr) * u;
      }
    }
    return {
      mx: clamp(mx + (blur.offsetX || 0), 0.02, 0.98),
      my: clamp(my + (blur.offsetY || 0), 0.02, 0.98),
      mr: clamp(mr, 0.04, 0.36)
    };
  }

  // ---------- 高速・高品質ガウシアン風楕円ぼかし描画（全Safari/Chrome GPU対応） ----------
  const s1Canvas = document.createElement("canvas");
  s1Canvas.width = 40; s1Canvas.height = 40;
  const s1Ctx = s1Canvas.getContext("2d");

  const s2Canvas = document.createElement("canvas");
  s2Canvas.width = 9; s2Canvas.height = 9;
  const s2Ctx = s2Canvas.getContext("2d");

  /**
   * 論理座標系(LW x LH)のパネル領域 panelRect 内に描画済みの映像に対し、
   * 楕円フェザーぼかしを描画する。
   */
  function drawSmoothOvalBlur(ctx, W, H, LW, LH, panelRect, centerLogical, radiiLogical) {
    const sxScale = W / LW, syScale = H / LH;
    const cx = centerLogical.x, cy = centerLogical.y;
    const rx = Math.max(14, radiiLogical.rx);
    const ry = Math.max(16, radiiLogical.ry);

    // パネル外にはみ出さないかをチェック
    if (cx + rx < panelRect.x || cx - rx > panelRect.x + panelRect.w ||
        cy + ry < panelRect.y || cy - ry > panelRect.y + panelRect.h) {
      return;
    }

    const padX = rx * 1.18, padY = ry * 1.18;
    const srcX = clamp(Math.floor((cx - padX) * sxScale), 0, W - 2);
    const srcY = clamp(Math.floor((cy - padY) * syScale), 0, H - 2);
    const srcR = clamp(Math.ceil((cx + padX) * sxScale), srcX + 2, W);
    const srcB = clamp(Math.ceil((cy + padY) * syScale), srcY + 2, H);
    const srcW = srcR - srcX, srcH = srcB - srcY;
    if (srcW < 4 || srcH < 4) return;

    // 2往復のピラミッド縮小・拡大で角のない滑らかな強ぼかしテクスチャをGPU生成
    s1Ctx.imageSmoothingEnabled = true;
    s2Ctx.imageSmoothingEnabled = true;
    s1Ctx.clearRect(0, 0, 40, 40);
    s1Ctx.drawImage(ctx.canvas, srcX, srcY, srcW, srcH, 0, 0, 40, 40);
    s2Ctx.clearRect(0, 0, 9, 9);
    s2Ctx.drawImage(s1Canvas, 0, 0, 40, 40, 0, 0, 9, 9);
    s1Ctx.drawImage(s2Canvas, 0, 0, 9, 9, 0, 0, 28, 28);
    s2Ctx.drawImage(s1Canvas, 0, 0, 28, 28, 0, 0, 8, 8);

    const dstLx = srcX / sxScale;
    const dstLy = srcY / syScale;
    const dstLw = srcW / sxScale;
    const dstLh = srcH / syScale;

    ctx.save();
    ctx.setTransform(sxScale, 0, 0, syScale, 0, 0);
    // パネル境界でクリップ（隣のパネルや上下文字帯へぼかしが漏れないようにする）
    ctx.beginPath();
    ctx.rect(panelRect.x, panelRect.y, panelRect.w, panelRect.h);
    ctx.clip();

    ctx.imageSmoothingEnabled = true;
    if ("imageSmoothingQuality" in ctx) ctx.imageSmoothingQuality = "high";

    // 3段階の同心楕円で境界を自然にフェザー合成
    const layers = [
      { scale: 1.04, alpha: 0.42 },
      { scale: 0.90, alpha: 0.78 },
      { scale: 0.76, alpha: 1.00 }
    ];
    for (let i = 0; i < layers.length; i++) {
      ctx.save();
      ctx.globalAlpha = layers[i].alpha;
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx * layers[i].scale, ry * layers[i].scale, 0, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(s2Canvas, 0, 0, 8, 8, dstLx, dstLy, dstLw, dstLh);
      ctx.restore();
    }
    ctx.restore();
  }

  function drawPreviewRing(ctx, W, H, LW, LH, panelRect, centerLogical, radiiLogical, active) {
    ctx.save();
    ctx.setTransform(W / LW, 0, 0, H / LH, 0, 0);
    ctx.beginPath();
    ctx.rect(panelRect.x, panelRect.y, panelRect.w, panelRect.h);
    ctx.clip();
    ctx.beginPath();
    ctx.ellipse(centerLogical.x, centerLogical.y, radiiLogical.rx, radiiLogical.ry, 0, 0, Math.PI * 2);
    ctx.strokeStyle = active ? "rgba(53,194,138,0.92)" : "rgba(255,255,255,0.55)";
    ctx.lineWidth = active ? 4 : 2.5;
    ctx.setLineDash([10, 8]);
    ctx.stroke();
    ctx.restore();
  }

  window.BAM_FACE = {
    trackImage,
    trackVideoAuto,
    trackVideoFromAnchor,
    sampleAtTime,
    drawSmoothOvalBlur,
    drawPreviewRing
  };
})();
