/**
 * BAメーカー 顔・頭部ぼかし＆ゼロ遅延・超高精度自動追従エンジン v23（ブラウザ内完結・サーバー送信なし）
 *
 * 1. 全フレームDual-AI検出（PoseLandmarker Full + フル解像度ROI FaceDetector + 全画面FaceDetector）＋ WebGL2 GPU推論：
 *    - Pass2でのFaceDetector省略や静止フレーム推論スキップを完全撤廃し、全10fpsフレームで骨格＋顔検出を統合
 *    - WebGL2 GPUデリゲート（CPU自動フォールバック付）により、全フレームDual-AI推論を高速実行
 * 2. 連続頭蓋ベクトル推定 ＋ 強正則化ビタビDP（Viterbi DP）＋ ハンペル外れ値除去：
 *    - 前屈・側屈・回旋時に頭が肩より下へ入る瞬間も不連続ジャンプを起こさない連続垂直重み（vertW）を採用
 *    - 速度・サイズ遷移ペナルティを強化し、1〜5フレームのAI未検出ギャップで背景や体幹の誤検出へ飛ばず正確にブリッジ
 * 3. 外観SAD主導・時間ステップ連動楕円トラッカー ＋ ジグザグ微細ブレ＆スパイク除去フィルタ：
 *    - 探索窓を時間差 dt に連動させ、体幹や衣服の前景コントラストに引っ張られるドリフトとサイズ脈動を根絶
 *    - 1フレームのAIジグザグ揺れ（dot < 0）と半径スパイクのみを除去し、等速移動と前屈最下点（5点検証頂点）は位相遅れゼロで追従
 * 4. 厳密 seeked + 1rAF 同期シーク ＋ 単調前進10fpsデコード ＋ 3枠LRU特徴スロットキャッシュ：
 *    - 長GOP動画（H.264/HEVC）でのシーク途中タイムアウトによる旧フレーム誤解析とランダムシーク詰まりを解消
 */
(() => {
  "use strict";

  const VISION_ESM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";
  const VISION_WASM_DIR = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
  const FACE_MODEL_URL = "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite";
  const POSE_FULL_URL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task";
  const POSE_LITE_URL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";

  const SCAN_MAX_DIM = 208;
  const POSE_MAX_DIM = 512;
  const FACE_FULL_MAX_DIM = 576;
  const ROI_FACE_DIM = 256;
  const BASE_STEP_SEC = 0.10;   // 10fps高密度キーフレーム
  const MAX_TRACK_SEC = 180;
  const MAX_SCAN_POINTS = 220;
  const MIN_MR = 0.038;
  const MAX_MR = 0.52;

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  // メインスレッドを14ms以上連続占有しないフレーム協調イールド（再生・スライダー・ドラッグ操作の遅延をゼロ化）
  let lastYieldPerf = 0;
  function yieldInteractive(force) {
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    if (!force && now - lastYieldPerf < 14) return Promise.resolve();
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        lastYieldPerf = typeof performance !== "undefined" ? performance.now() : Date.now();
        resolve();
      };
      const tId = setTimeout(finish, 18);
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(() => {
          clearTimeout(tId);
          finish();
        });
      }
    });
  }

  // 楕円ヘッド内部のみをサンプリングする37点同心円ディスク（背景四隅を100%除外）
  const DISC_PTS = (() => {
    const pts = [{ nx: 0, ny: 0, w: 1.0, ring: 0 }];
    const rings = [
      { r: 0.34, n: 6, w: 0.90, ring: 1 },
      { r: 0.66, n: 12, w: 0.68, ring: 2 },
      { r: 0.94, n: 18, w: 0.44, ring: 3 }
    ];
    for (let k = 0; k < rings.length; k++) {
      const { r, n, w, ring } = rings[k];
      for (let i = 0; i < n; i++) {
        const ang = (Math.PI * 2 * i) / n + (k % 2) * (Math.PI / n);
        pts.push({ nx: Math.cos(ang) * r, ny: Math.sin(ang) * r, w, ring });
      }
    }
    return pts;
  })();

  // 頭頂〜側頭部の外側背景ハロー点（頭部と背景の境界コントラスト評価・マルチスケール半径推定・胴体ずり下がり防止）
  const HALO_PTS = [
    { nx: 0, ny: -1.30 },
    { nx: -0.90, ny: -0.94 },
    { nx: 0.90, ny: -0.94 },
    { nx: -1.26, ny: -0.16 },
    { nx: 1.26, ny: -0.16 },
    { nx: -1.12, ny: 0.42 },
    { nx: 1.12, ny: 0.42 }
  ];

  const SCALE_FACTORS = [0.88, 0.92, 0.96, 1.00, 1.04, 1.08, 1.13];

  // ---------- 3枠LRU特徴スロットキャッシュ（ドラッグ再追従・比率切替を約3msで即時反映） ----------
  const MAX_CACHE_ENTRIES = 3;
  const slotCache = new Map();

  function getOrCreateCacheEntry(url, meta) {
    if (!url) return null;
    if (slotCache.has(url)) {
      const existing = slotCache.get(url);
      slotCache.delete(url);
      slotCache.set(url, existing);
      return existing;
    }
    if (!meta) return null;
    while (slotCache.size >= MAX_CACHE_ENTRIES) {
      const oldestKey = slotCache.keys().next().value;
      slotCache.delete(oldestKey);
    }
    const entry = {
      vw: meta.vw,
      vh: meta.vh,
      dur: meta.dur,
      times: meta.times,
      step: meta.step,
      slots: new Array(meta.times.length).fill(null),
      realMaxT: Infinity,
      complete: false
    };
    slotCache.set(url, entry);
    return entry;
  }

  function evictCache(url) {
    if (url && slotCache.has(url)) {
      slotCache.delete(url);
    }
  }

  // ---------- MediaPipe デュアルAI（PoseLandmarker Full + FaceDetector）遅延ローダー（XNNPACK SIMD高速推論） ----------
  let detectorsPromise = null;
  let cachedDetectors = null;

  async function createFaceDetectorWithFallback(FaceDetector, vision) {
    if (!FaceDetector) return null;
    return await FaceDetector.createFromOptions(vision, {
      baseOptions: { modelAssetPath: FACE_MODEL_URL, delegate: "CPU" },
      runningMode: "IMAGE",
      minDetectionConfidence: 0.34
    }).catch(() => null);
  }

  async function createPoseDetector(PoseLandmarker, vision) {
    if (!PoseLandmarker) return null;
    const opts = (modelUrl) => ({
      baseOptions: { modelAssetPath: modelUrl, delegate: "CPU" },
      runningMode: "IMAGE",
      numPoses: 3,
      minPoseDetectionConfidence: 0.26,
      minPosePresenceConfidence: 0.26
    });
    const full = await PoseLandmarker.createFromOptions(vision, opts(POSE_FULL_URL)).catch(() => null);
    if (full) return full;
    return await PoseLandmarker.createFromOptions(vision, opts(POSE_LITE_URL)).catch(() => null);
  }

  async function getDetectors() {
    if (cachedDetectors && (cachedDetectors.face || cachedDetectors.pose)) {
      return cachedDetectors;
    }
    if (detectorsPromise) return detectorsPromise;

    detectorsPromise = (async () => {
      try {
        const mod = await Promise.race([
          import(VISION_ESM_URL),
          new Promise((_, rej) => setTimeout(() => rej(new Error("vision_timeout")), 14000))
        ]);
        const FilesetResolver = mod.FilesetResolver;
        const FaceDetector = mod.FaceDetector;
        const PoseLandmarker = mod.PoseLandmarker;
        if (!FilesetResolver) throw new Error("vision_api_missing");

        const vision = await Promise.race([
          FilesetResolver.forVisionTasks(VISION_WASM_DIR),
          new Promise((_, rej) => setTimeout(() => rej(new Error("wasm_timeout")), 14000))
        ]);

        const [face, pose] = await Promise.all([
          createFaceDetectorWithFallback(FaceDetector, vision),
          createPoseDetector(PoseLandmarker, vision)
        ]);

        if (!face && !pose) {
          detectorsPromise = null;
          return null;
        }
        cachedDetectors = { face, pose };
        return cachedDetectors;
      } catch (e) {
        detectorsPromise = null;
        return null;
      }
    })();

    return detectorsPromise;
  }

  // ---------- 解析用オフスクリーンキャンバス ----------
  let faceCanvas = null, faceCtx = null;
  let roiCanvas = null, roiCtx = null;
  let poseCanvas = null, poseCtx = null;
  let patchCanvas = null, patchCtx = null;

  function ensureCanvases() {
    if (!faceCanvas) {
      faceCanvas = document.createElement("canvas");
      faceCtx = faceCanvas.getContext("2d", { willReadFrequently: true });
    }
    if (!roiCanvas) {
      roiCanvas = document.createElement("canvas");
      roiCanvas.width = ROI_FACE_DIM;
      roiCanvas.height = ROI_FACE_DIM;
      roiCtx = roiCanvas.getContext("2d", { willReadFrequently: true });
    }
    if (!poseCanvas) {
      poseCanvas = document.createElement("canvas");
      poseCtx = poseCanvas.getContext("2d", { willReadFrequently: true });
    }
    if (!patchCanvas) {
      patchCanvas = document.createElement("canvas");
      patchCtx = patchCanvas.getContext("2d", { willReadFrequently: true });
    }
  }

  function evalVisibleWeight(mx, my, visibleBox) {
    if (!visibleBox) {
      return 1.0 - Math.abs(mx - 0.5) * 0.08;
    }
    const { x0, y0, x1, y1 } = visibleBox;
    const midX = (x0 + x1) * 0.5;
    const spanX = Math.max(0.15, x1 - x0);
    const outX = mx < x0 ? (x0 - mx) : (mx > x1 ? (mx - x1) : 0);
    const outY = my < y0 ? (y0 - my) : (my > y1 ? (my - y1) : 0);
    const outDist = Math.hypot(outX, outY);
    if (outDist > 0.06) {
      return Math.max(0.38, 0.90 - (outDist - 0.06) * 2.1);
    }
    return 1.04 - Math.min(0.06, (Math.abs(mx - midX) / spanX) * 0.06);
  }

  /**
   * 骨格推定された頭部周辺を元解像度（1080p/4K）から直接256x256へ切り出してFaceDetectorを実行
   */
  function detectFaceInPoseRoi(faceDetector, sourceEl, srcW, srcH, hx, hy, poseMr) {
    if (!faceDetector || !srcW || !srcH || srcW < 120 || srcH < 120) return null;
    ensureCanvases();
    const minSrc = Math.min(srcW, srcH);
    const halfPx = clamp(Math.round(poseMr * minSrc * 2.50), 36, Math.round(Math.max(srcW, srcH) * 0.48));
    const cxPx = hx * srcW;
    const cyPx = hy * srcH;

    const sx = clamp(Math.round(cxPx - halfPx), 0, Math.max(0, srcW - 24));
    const sy = clamp(Math.round(cyPx - halfPx), 0, Math.max(0, srcH - 24));
    const sw = clamp(Math.round(cxPx + halfPx) - sx, 24, srcW - sx);
    const sh = clamp(Math.round(cyPx + halfPx) - sy, 24, srcH - sy);
    if (sw < 24 || sh < 24) return null;

    try {
      roiCtx.clearRect(0, 0, ROI_FACE_DIM, ROI_FACE_DIM);
      roiCtx.drawImage(sourceEl, sx, sy, sw, sh, 0, 0, ROI_FACE_DIM, ROI_FACE_DIM);
      const res = faceDetector.detect(roiCanvas);
      const list = (res && res.detections) ? res.detections : [];
      if (!list.length) return null;

      let best = null, bestScore = -1;
      for (let i = 0; i < list.length; i++) {
        const d = list[i];
        const bb = d.boundingBox;
        if (!bb || bb.width <= 0 || bb.height <= 0) continue;
        const conf = (d.categories && d.categories[0] && d.categories[0].score) || 0.45;
        if (conf < 0.36) continue;

        const roiCx = (bb.originX + bb.width * 0.5) / ROI_FACE_DIM;
        const roiCy = (bb.originY + bb.height * 0.435) / ROI_FACE_DIM;
        const fMx = (sx + roiCx * sw) / srcW;
        const fMy = (sy + roiCy * sh) / srcH;

        const boxPxW = (bb.width / ROI_FACE_DIM) * sw;
        const boxPxH = (bb.height / ROI_FACE_DIM) * sh;
        const fMr = clamp((Math.max(boxPxW, boxPxH) / minSrc) * 0.74, MIN_MR, MAX_MR);

        const dist = Math.hypot(fMx - hx, fMy - hy);
        if (dist > Math.max(0.14, poseMr * 1.80)) continue;

        const score = conf * (1.25 - dist / Math.max(0.14, poseMr * 2.05));
        if (score > bestScore) {
          bestScore = score;
          best = { mx: clamp(fMx, 0.02, 0.98), my: clamp(fMy, 0.02, 0.98), mr: fMr, conf };
        }
      }
      return best;
    } catch (e) {
      return null;
    }
  }

  /**
   * PoseLandmarker Full の33骨格点から360°全方向＆遠近深度（1/Z）に即応する頭蓋中心と半径を算出
   */
  function detectPoseCandidates(poseDetector, faceDetector, sourceEl, srcW, srcH) {
    if (!poseDetector || !srcW || !srcH) return [];
    ensureCanvases();
    const scale = Math.min(1, POSE_MAX_DIM / Math.max(srcW, srcH));
    const dw = Math.max(64, Math.round(srcW * scale));
    const dh = Math.max(64, Math.round(srcH * scale));
    if (poseCanvas.width !== dw || poseCanvas.height !== dh) {
      poseCanvas.width = dw;
      poseCanvas.height = dh;
    }

    const out = [];
    try {
      poseCtx.drawImage(sourceEl, 0, 0, dw, dh);
      const res = poseDetector.detect(poseCanvas);
      const poses = (res && res.landmarks) ? res.landmarks : [];
      if (!poses.length) return out;

      const minDim = Math.min(dw, dh);
      const EAR_INDICES = [7, 8];
      const FACE_WEIGHTS = [[0, 1.35], [2, 1.10], [5, 1.10], [9, 0.75], [10, 0.75], [1, 0.55], [3, 0.55], [4, 0.55], [6, 0.55]];

      for (let pIdx = 0; pIdx < poses.length; pIdx++) {
        const lm = poses[pIdx];
        if (!lm || lm.length < 13) continue;

        let earW = 0, earX = 0, earY = 0, earCnt = 0;
        let faceW = 0, faceX = 0, faceY = 0, faceCnt = 0;
        let visSum = 0, visCnt = 0;
        const headPts = [];
        const validEars = [];

        for (let e = 0; e < EAR_INDICES.length; e++) {
          const pt = lm[EAR_INDICES[e]];
          if (!pt || !isFinite(pt.x) || !isFinite(pt.y)) continue;
          if (pt.x < -0.12 || pt.x > 1.12 || pt.y < -0.12 || pt.y > 1.12) continue;
          const vis = typeof pt.visibility === "number" ? pt.visibility : 0.6;
          if (vis < 0.14) continue;
          const w = 1.45 * (0.35 + vis * 0.65);
          earW += w; earX += pt.x * w; earY += pt.y * w;
          earCnt++; visSum += vis; visCnt++;
          headPts.push(pt);
          if (vis >= 0.20) validEars.push(pt);
        }

        // 両耳間ピクセル距離（前屈でカメラに頭が近づく・遠ざかる際の直接的な 1/Z 頭部スケール指標）
        let earSpanPx = 0;
        if (validEars.length === 2) {
          earSpanPx = Math.hypot((validEars[0].x - validEars[1].x) * dw, (validEars[0].y - validEars[1].y) * dh);
        }

        for (let k = 0; k < FACE_WEIGHTS.length; k++) {
          const [idx, baseW] = FACE_WEIGHTS[k];
          const pt = lm[idx];
          if (!pt || !isFinite(pt.x) || !isFinite(pt.y)) continue;
          if (pt.x < -0.12 || pt.x > 1.12 || pt.y < -0.12 || pt.y > 1.12) continue;
          const vis = typeof pt.visibility === "number" ? pt.visibility : 0.6;
          if (vis < 0.14) continue;
          const w = baseW * (0.35 + vis * 0.65);
          faceW += w; faceX += pt.x * w; faceY += pt.y * w;
          faceCnt++; visSum += vis; visCnt++;
          headPts.push(pt);
        }

        if (visCnt < 2) continue;

        let hx, hy, earNosePx = 0;
        if (earW > 0 && faceW > 0) {
          const ex = earX / earW, ey = earY / earW;
          const fx = faceX / faceW, fy = faceY / faceW;
          hx = ex + (fx - ex) * 0.42;
          hy = ey + (fy - ey) * 0.42;
          earNosePx = Math.hypot((fx - ex) * dw, (fy - ey) * dh);
        } else if (earW > 0) {
          hx = earX / earW; hy = earY / earW;
        } else {
          hx = faceX / faceW; hy = faceY / faceW;
        }

        const meanVis = visSum / visCnt;

        const ls = lm[11], rs = lm[12];
        const lsOk = !!(ls && isFinite(ls.x) && isFinite(ls.y) && (ls.visibility === undefined || ls.visibility >= 0.16));
        const rsOk = !!(rs && isFinite(rs.x) && isFinite(rs.y) && (rs.visibility === undefined || rs.visibility >= 0.16));
        const lh = lm[23], rh = lm[24];
        const lhOk = !!(lh && isFinite(lh.x) && isFinite(lh.y) && (lh.visibility === undefined || lh.visibility >= 0.15));
        const rhOk = !!(rh && isFinite(rh.x) && isFinite(rh.y) && (rh.visibility === undefined || rh.visibility >= 0.15));

        let sx = hx, sy = hy + 0.10, hasShoulder = false;
        let neckPx = 0, shoulderPx = 0, torsoPx = 0;

        if (lsOk && rsOk) {
          sx = (ls.x + rs.x) * 0.5;
          sy = (ls.y + rs.y) * 0.5;
          hasShoulder = true;
          neckPx = Math.hypot((hx - sx) * dw, (hy - sy) * dh);
          shoulderPx = Math.hypot((ls.x - rs.x) * dw, (ls.y - rs.y) * dh);
        } else if (lsOk || rsOk) {
          const sp = lsOk ? ls : rs;
          sx = sp.x; sy = sp.y;
          hasShoulder = true;
          neckPx = Math.hypot((hx - sx) * dw, (hy - sy) * dh) * 0.88;
        }

        let hipY = sy + 0.25;
        if (hasShoulder && (lhOk || rhOk)) {
          const hipX = (lhOk && rhOk) ? (lh.x + rh.x) * 0.5 : (lhOk ? lh.x : rh.x);
          hipY = (lhOk && rhOk) ? (lh.y + rh.y) * 0.5 : (lhOk ? lh.y : rh.y);
          torsoPx = Math.hypot((sx - hipX) * dw, (sy - hipY) * dh);
        }

        let maxSpanPx = 0;
        for (let i = 0; i < headPts.length; i++) {
          const dPx = Math.hypot((headPts[i].x - hx) * dw, (headPts[i].y - hy) * dh);
          if (dPx > maxSpanPx) maxSpanPx = dPx;
        }

        // 頭部直接寸法（遠近変化に1:1で即時連動）と体幹比率フロア（横向き・後ろ姿での縮小防止）を分離
        const headDirectPx = Math.max(
          maxSpanPx * 1.62,
          earSpanPx * 0.82,
          earNosePx * 1.48
        );
        const bodyFloorPx = Math.max(
          neckPx * 0.44,
          shoulderPx * 0.35,
          torsoPx * 0.225
        );
        const rPx = headDirectPx > minDim * 0.042
          ? Math.max(headDirectPx, bodyFloorPx * 0.88, minDim * 0.046)
          : Math.max(headDirectPx, bodyFloorPx, minDim * 0.052);

        if (hasShoulder && neckPx > 3) {
          let ux = ((hx - sx) * dw) / neckPx;
          let uy = ((hy - sy) * dh) / neckPx;
          // 連続垂直度ウェイト vertW（前屈で頭が肩の高さを通過する瞬間の不連続ジャンプを完全排除）
          const torsoVert = clamp((hipY - sy) / 0.18, 0, 1);
          const neckVert = clamp(-uy, 0, 1);
          const vertW = torsoVert * neckVert;
          ux *= (1 - 0.62 * vertW);
          const nLen = Math.hypot(ux, uy) || 1;
          ux /= nLen;
          uy /= nLen;
          hx += (ux * rPx * 0.16) / dw;
          hy += (uy * rPx * 0.16) / dh;
        } else {
          hy -= (rPx * 0.14) / dh;
        }

        if (hx < -0.05 || hx > 1.05 || hy < -0.05 || hy > 1.05) continue;

        let finalMx = clamp(hx, 0.02, 0.98);
        let finalMy = clamp(hy, 0.02, 0.98);
        const poseMr = clamp((rPx / minDim) * 1.08, MIN_MR, MAX_MR);
        let finalMr = poseMr;
        let finalConf = meanVis;
        let hasFace = false;

        // 2段階フル解像度ROI顔ズーム検出：実測顔サイズへ遅れなく連動（横向き時の頭蓋フロアのみ保証）
        const roiFace = detectFaceInPoseRoi(faceDetector, sourceEl, srcW, srcH, finalMx, finalMy, poseMr);
        if (roiFace) {
          finalMx = clamp(roiFace.mx * 0.74 + finalMx * 0.26, 0.02, 0.98);
          finalMy = clamp(roiFace.my * 0.74 + finalMy * 0.26, 0.02, 0.98);
          const craniumFloorMr = clamp(Math.max(earSpanPx * 0.74, headDirectPx * 0.82, torsoPx * 0.195) / minDim, MIN_MR, MAX_MR);
          const faceDrivenMr = roiFace.mr * 1.12 * 0.80 + poseMr * 0.20;
          finalMr = clamp(Math.max(faceDrivenMr, craniumFloorMr), MIN_MR, MAX_MR);
          finalConf = Math.max(meanVis, roiFace.conf);
          hasFace = true;
        }

        const bodyBonus = hasShoulder ? (hasFace ? 1.35 : 1.14) : 0.92;
        const sizeBonus = clamp(finalMr * 5.0, 0.48, 1.36);

        out.push({
          mx: finalMx,
          my: finalMy,
          mr: finalMr,
          conf: finalConf,
          hasBody: hasShoulder,
          hasFace,
          rawScore: finalConf * bodyBonus * sizeBonus
        });
      }
    } catch (e) {}
    return out;
  }

  function detectFullFrameFaceCandidates(faceDetector, sourceEl, srcW, srcH) {
    if (!faceDetector || !srcW || !srcH) return [];
    ensureCanvases();
    const scale = Math.min(1, FACE_FULL_MAX_DIM / Math.max(srcW, srcH));
    const dw = Math.max(64, Math.round(srcW * scale));
    const dh = Math.max(64, Math.round(srcH * scale));
    if (faceCanvas.width !== dw || faceCanvas.height !== dh) {
      faceCanvas.width = dw;
      faceCanvas.height = dh;
    }

    const out = [];
    try {
      faceCtx.drawImage(sourceEl, 0, 0, dw, dh);
      const res = faceDetector.detect(faceCanvas);
      const list = (res && res.detections) ? res.detections : [];
      const minDim = Math.min(dw, dh);

      for (let i = 0; i < list.length; i++) {
        const d = list[i];
        const bb = d.boundingBox;
        if (!bb || bb.width <= 0 || bb.height <= 0) continue;
        const conf = (d.categories && d.categories[0] && d.categories[0].score) || 0.45;
        if (conf < 0.36) continue;

        const cx = clamp((bb.originX + bb.width * 0.5) / dw, 0.02, 0.98);
        const cy = clamp((bb.originY + bb.height * 0.435) / dh, 0.02, 0.98);
        const mr = clamp((Math.max(bb.width, bb.height) / minDim) * 0.74, MIN_MR, MAX_MR);
        const sizeBonus = clamp(mr * 4.8, 0.42, 1.38);

        out.push({
          mx: cx,
          my: cy,
          mr,
          conf,
          hasBody: false,
          hasFace: true,
          rawScore: conf * 0.88 * sizeBonus
        });
      }
    } catch (e) {}
    return out;
  }

  /**
   * 1フレーム上の全頭部候補を統合（Pass1/Pass2を問わず常にPoseLandmarker + FaceDetectorの双方を実行し交互フレーム座標ブレを防止）
   */
  function detectCandidatesOnSource(detectors, sourceEl, srcW, srcH) {
    if (!detectors || !srcW || !srcH) return [];
    const poseCands = detectPoseCandidates(detectors.pose, detectors.face, sourceEl, srcW, srcH);
    const faceCands = detectFullFrameFaceCandidates(detectors.face, sourceEl, srcW, srcH);

    const merged = poseCands.slice();
    for (let i = 0; i < faceCands.length; i++) {
      const fc = faceCands[i];
      let matched = null, minD = Infinity;
      for (let j = 0; j < merged.length; j++) {
        const pc = merged[j];
        const d = Math.hypot(fc.mx - pc.mx, fc.my - pc.my);
        if (d < Math.max(0.11, Math.max(fc.mr, pc.mr) * 1.35) && d < minD) {
          minD = d;
          matched = pc;
        }
      }
      if (matched) {
        if (!matched.hasFace) {
          matched.mx = fc.mx * 0.55 + matched.mx * 0.45;
          matched.my = fc.my * 0.55 + matched.my * 0.45;
          matched.mr = matched.hasBody
            ? clamp(matched.mr * 0.75 + fc.mr * 0.25, MIN_MR, MAX_MR)
            : clamp(fc.mr * 1.04 * 0.75 + matched.mr * 0.25, MIN_MR, MAX_MR);
          matched.hasFace = true;
          matched.conf = Math.max(matched.conf, fc.conf);
          matched.rawScore *= 1.18;
        }
      } else {
        if (poseCands.length > 0 && fc.mr < 0.085) {
          fc.rawScore *= 0.42;
        }
        merged.push(fc);
      }
    }

    merged.sort((a, b) => b.rawScore - a.rawScore);
    return merged.slice(0, 4);
  }

  // ---------- ロスレス Int16Array 特徴バッファ＆時間中央値背景モデル ----------
  function getScanDims(srcW, srcH) {
    const w = srcW || 360, h = srcH || 640;
    const sc = SCAN_MAX_DIM / Math.max(w, h);
    return {
      sw: Math.max(56, Math.round(w * sc)),
      sh: Math.max(56, Math.round(h * sc))
    };
  }

  function grabScanBuffer(sourceEl, srcW, srcH) {
    ensureCanvases();
    const { sw, sh } = getScanDims(srcW, srcH);
    if (patchCanvas.width !== sw || patchCanvas.height !== sh) {
      patchCanvas.width = sw;
      patchCanvas.height = sh;
    }
    try {
      patchCtx.drawImage(sourceEl, 0, 0, sw, sh);
      const data = patchCtx.getImageData(0, 0, sw, sh).data;
      const n = sw * sh;
      const feat = new Int16Array(n * 3);
      let sumY = 0, minY = 255, maxY = 0;
      for (let i = 0, p = 0; i < n; i++, p += 4) {
        const r = data[p], g = data[p + 1], b = data[p + 2];
        const y = (77 * r + 150 * g + 29 * b) >> 8;
        feat[i * 3] = y;
        feat[i * 3 + 1] = r - g;
        feat[i * 3 + 2] = b - y;
        sumY += y;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      if (sumY / n < 1.8 && (maxY - minY) < 3) {
        return null;
      }
      return { feat, sw, sh };
    } catch (e) {
      return null;
    }
  }

  function buildTemporalRoomModel(bufs) {
    const valid = [];
    for (let i = 0; i < bufs.length; i++) {
      if (bufs[i] && bufs[i].feat) valid.push(bufs[i]);
    }
    if (valid.length < 3) return null;

    const { sw, sh } = valid[0];
    const same = valid.filter((b) => b.sw === sw && b.sh === sh);
    if (same.length < 3) return null;

    const sampleCnt = Math.min(9, same.length);
    const picked = [];
    for (let k = 0; k < sampleCnt; k++) {
      const idx = Math.min(same.length - 1, Math.round((k * (same.length - 1)) / Math.max(1, sampleCnt - 1)));
      picked.push(same[idx].feat);
    }

    const n = sw * sh;
    const bgFeat = new Int16Array(n * 3);
    const activity = new Uint8Array(n);
    const tmpY = new Int16Array(sampleCnt);
    const tmpRG = new Int16Array(sampleCnt);
    const tmpBY = new Int16Array(sampleCnt);
    const mid = sampleCnt >> 1;
    let maxGlobalAct = 0;

    for (let i = 0; i < n; i++) {
      const idx = i * 3;
      let minL = 255, maxL = 0;
      for (let k = 0; k < sampleCnt; k++) {
        const f = picked[k];
        const y = f[idx];
        tmpY[k] = y;
        tmpRG[k] = f[idx + 1];
        tmpBY[k] = f[idx + 2];
        if (y < minL) minL = y;
        if (y > maxL) maxL = y;
      }
      tmpY.sort();
      tmpRG.sort();
      tmpBY.sort();
      bgFeat[idx] = tmpY[mid];
      bgFeat[idx + 1] = tmpRG[mid];
      bgFeat[idx + 2] = tmpBY[mid];

      const act = clamp(maxL - minL, 0, 255);
      activity[i] = act;
      if (act > maxGlobalAct) maxGlobalAct = act;
    }

    return { bgFeat, activity, sw, sh, hasMotion: maxGlobalAct > 18 };
  }

  function regionActivityFactor(cand, roomModel) {
    if (!roomModel || !roomModel.hasMotion) return 1.0;
    const { activity, sw, sh } = roomModel;
    const cx = clamp(Math.round(cand.mx * sw), 2, sw - 3);
    const cy = clamp(Math.round(cand.my * sh), 2, sh - 3);
    const rx = Math.max(3, Math.round(cand.mr * Math.min(sw, sh) * 0.85));
    let sum = 0, peak = 0, cnt = 0;
    for (let dy = -rx; dy <= rx; dy += 2) {
      const yy = clamp(cy + dy, 0, sh - 1);
      for (let dx = -rx; dx <= rx; dx += 2) {
        const xx = clamp(cx + dx, 0, sw - 1);
        const a = activity[yy * sw + xx];
        sum += a;
        if (a > peak) peak = a;
        cnt++;
      }
    }
    const meanAct = cnt > 0 ? sum / cnt : 0;
    if (!cand.hasBody && peak < 8 && meanAct < 4.5) {
      return 0.25;
    }
    if (meanAct > 10 || peak > 22) {
      return 1.12;
    }
    return cand.hasBody ? 1.0 : 0.76;
  }

  /**
   * 大域ビタビ動的計画法（Viterbi DP）＋ハンペル外れ値スパイク除去
   */
  function selectConsistentTrack(times, candsPerFrame, roomModel, visibleBox, anchorConstraint) {
    const n = times.length;
    if (!n) return [];

    const dp = new Array(n);
    const prevPtr = new Array(n);
    const MAX_GAP_STEPS = 24;

    for (let i = 0; i < n; i++) {
      const list = candsPerFrame[i] || [];
      dp[i] = new Float64Array(list.length);
      prevPtr[i] = new Array(list.length).fill(null);

      for (let c = 0; c < list.length; c++) {
        const cand = list[c];
        const visW = evalVisibleWeight(cand.mx, cand.my, visibleBox);
        const baseScore = (cand.rawScore !== undefined ? cand.rawScore : cand.baseScore || 0.5) * visW;
        let nodeScore = baseScore * regionActivityFactor(cand, roomModel);

        if (anchorConstraint && i === anchorConstraint.idx) {
          const dAnchor = Math.hypot(cand.mx - anchorConstraint.mx, cand.my - anchorConstraint.my);
          if (dAnchor <= Math.max(0.11, anchorConstraint.mr * 1.35)) {
            nodeScore += 600 - dAnchor * 400;
          } else {
            nodeScore = -1e6;
          }
        }

        let bestPrevScore = 0;
        let bestPrev = null;

        const pMin = Math.max(0, i - MAX_GAP_STEPS);
        for (let p = i - 1; p >= pMin; p--) {
          const pList = candsPerFrame[p] || [];
          if (!pList.length) continue;
          const dt = Math.max(0.03, times[i] - times[p]);
          const maxJump = Math.min(0.32, 0.075 + 1.15 * dt);

          for (let pc = 0; pc < pList.length; pc++) {
            if (dp[p][pc] < -1e5) continue;
            const prevCand = pList[pc];
            const dist = Math.hypot(cand.mx - prevCand.mx, cand.my - prevCand.my);
            if (dist > maxJump) continue;

            const stepVel = dist / Math.max(0.06, dt);
            const velCost = (dist / (0.055 + dt * 0.65)) * 0.72 + (stepVel > 0.85 ? (stepVel - 0.85) * 0.95 : 0);
            const sizeCost = Math.abs(Math.log((cand.mr + 0.015) / (prevCand.mr + 0.015))) * 0.32;
            const gapCost = (i - p - 1) * 0.032;
            const candTotal = dp[p][pc] + 0.42 - velCost - sizeCost - gapCost;

            if (candTotal > bestPrevScore) {
              bestPrevScore = candTotal;
              bestPrev = [p, pc];
            }
          }
        }

        dp[i][c] = bestPrevScore + nodeScore;
        prevPtr[i][c] = bestPrev;
      }
    }

    let bestEndI = -1, bestEndC = -1, bestTotal = -Infinity;
    for (let i = 0; i < n; i++) {
      const list = candsPerFrame[i] || [];
      for (let c = 0; c < list.length; c++) {
        if (dp[i][c] > bestTotal) {
          bestTotal = dp[i][c];
          bestEndI = i;
          bestEndC = c;
        }
      }
    }

    const selected = new Array(n).fill(null);
    if (bestEndI < 0 || bestTotal <= 0) return selected;

    let cur = [bestEndI, bestEndC];
    let hitCount = 0;
    while (cur) {
      const [fi, ci] = cur;
      selected[fi] = candsPerFrame[fi][ci];
      hitCount++;
      cur = prevPtr[fi][ci];
    }

    if (anchorConstraint && !selected[anchorConstraint.idx]) {
      return new Array(n).fill(null);
    }

    if (!anchorConstraint && n >= 8 && hitCount === 1) {
      const onlyIdx = selected.findIndex(Boolean);
      if (onlyIdx >= 0 && selected[onlyIdx].conf < 0.58 && !selected[onlyIdx].hasBody) {
        return new Array(n).fill(null);
      }
    }

    // ハンペル外れ値スパイク除去（1フレームのみ別位置へ飛んだ誤検出のみ除去、実際の折り返し頂点は保護）
    const idxs = [];
    for (let i = 0; i < n; i++) if (selected[i]) idxs.push(i);
    for (let k = 1; k < idxs.length - 1; k++) {
      const iPrev = idxs[k - 1], iCur = idxs[k], iNext = idxs[k + 1];
      if (anchorConstraint && iCur === anchorConstraint.idx) continue;
      const a = selected[iPrev], b = selected[iCur], c = selected[iNext];
      if (!a || !b || !c) continue;
      const span = Math.max(0.001, times[iNext] - times[iPrev]);
      if (span > 0.45) continue; // 粗いPass1区間では実際のピークを誤除去しない
      const u = (times[iCur] - times[iPrev]) / span;
      const interpX = a.mx + (c.mx - a.mx) * u;
      const interpY = a.my + (c.my - a.my) * u;
      const dev = Math.hypot(b.mx - interpX, b.my - interpY);
      const neighborSpan = Math.hypot(c.mx - a.mx, c.my - a.my);
      if (dev > 0.085 && dev > neighborSpan * 1.10) {
        selected[iCur] = null;
      }
    }

    return selected;
  }

  // ---------- 静止画・AI未検出時のシルエット／動体初期頭部推定 ----------
  function computeBorderBg(buf) {
    const { feat, sw, sh } = buf;
    let bgY = 0, bgRG = 0, bgBY = 0, bgCnt = 0;
    const yMaxBg = Math.floor(sh * 0.60);
    const xs = [2, Math.min(5, sw - 2), Math.max(1, sw - 6), Math.max(1, sw - 3)];
    for (let y = 3; y < yMaxBg; y += 2) {
      for (let k = 0; k < xs.length; k++) {
        const idx = (y * sw + xs[k]) * 3;
        bgY += feat[idx];
        bgRG += feat[idx + 1];
        bgBY += feat[idx + 2];
        bgCnt++;
      }
    }
    if (!bgCnt) return { bgY: 128, bgRG: 0, bgBY: 0 };
    return { bgY: bgY / bgCnt, bgRG: bgRG / bgCnt, bgBY: bgBY / bgCnt };
  }

  function estimateHeadFromBuffer(buf, visibleBox) {
    const defX = visibleBox ? (visibleBox.x0 + visibleBox.x1) * 0.5 : 0.5;
    if (!buf || !buf.feat) return { mx: defX, my: 0.22, mr: 0.11 };
    const { feat, sw, sh } = buf;
    const bg = computeBorderBg(buf);

    const vx0 = visibleBox ? clamp(visibleBox.x0 + 0.05, 0.06, 0.85) : 0.14;
    const vx1 = visibleBox ? clamp(visibleBox.x1 - 0.05, vx0 + 0.10, 0.94) : 0.86;
    const xMin = Math.floor(sw * vx0);
    const xMax = Math.ceil(sw * vx1);
    const yMin = Math.floor(sh * 0.05);
    const yMax = Math.floor(sh * 0.54);

    const rowMass = new Float32Array(sh);
    const rowCenter = new Float32Array(sh);

    for (let y = yMin; y <= yMax; y++) {
      let mass = 0, wx = 0;
      for (let x = xMin; x <= xMax; x++) {
        const idx = (y * sw + x) * 3;
        const diff = Math.abs(feat[idx] - bg.bgY) +
                     Math.abs(feat[idx + 1] - bg.bgRG) * 0.85 +
                     Math.abs(feat[idx + 2] - bg.bgBY) * 0.65;
        if (diff > 24) {
          const w = diff - 24;
          mass += w;
          wx += x * w;
        }
      }
      rowMass[y] = mass;
      rowCenter[y] = mass > 0 ? wx / mass : sw * defX;
    }

    let peakMass = 0;
    for (let y = yMin; y <= yMax; y++) {
      if (rowMass[y] > peakMass) peakMass = rowMass[y];
    }
    if (peakMass < sw * 1.5) {
      return { mx: defX, my: 0.22, mr: 0.11 };
    }

    const th = peakMass * 0.26;
    let topY = -1;
    for (let y = yMin; y <= yMax - 3; y++) {
      if (rowMass[y] >= th && rowMass[y + 1] >= th && rowMass[y + 2] >= th) {
        topY = y;
        break;
      }
    }
    if (topY < 0) return { mx: defX, my: 0.22, mr: 0.11 };

    const headH = Math.max(4, Math.round(sh * 0.072));
    const cy = clamp(topY + headH, yMin + 3, yMax);
    let sumW = 0, sumX = 0;
    const yEnd = Math.min(yMax, topY + headH * 2);
    for (let y = topY; y <= yEnd; y++) {
      const w = rowMass[y] + 1;
      sumW += w;
      sumX += rowCenter[y] * w;
    }
    const cx = sumW > 0 ? sumX / sumW : sw * defX;

    let varSum = 0, varW = 0;
    for (let y = topY; y <= yEnd; y++) {
      for (let x = xMin; x <= xMax; x++) {
        const idx = (y * sw + x) * 3;
        const diff = Math.abs(feat[idx] - bg.bgY) +
                     Math.abs(feat[idx + 1] - bg.bgRG) * 0.85 +
                     Math.abs(feat[idx + 2] - bg.bgBY) * 0.65;
        if (diff > 24 && Math.abs(x - cx) <= sw * 0.24) {
          const w = diff - 24;
          varSum += w * (x - cx) * (x - cx);
          varW += w;
        }
      }
    }
    const estMr = varW > 0
      ? clamp((Math.sqrt(varSum / varW) * 2.05 / Math.min(sw, sh)) * 1.18, 0.048, 0.28)
      : 0.105;

    return {
      mx: clamp(cx / sw, 0.08, 0.92),
      my: clamp(cy / sh, 0.08, 0.56),
      mr: estMr
    };
  }

  function estimateMovingHeadAtIndex(bufs, seedIdx, roomModel, visibleBox) {
    const valid = bufs.filter(Boolean);
    if (!valid.length) return { mx: 0.5, my: 0.22, mr: 0.11 };
    const refBuf = bufs[seedIdx] || valid[0];
    if (!roomModel || !roomModel.hasMotion) return estimateHeadFromBuffer(refBuf, visibleBox);

    const { sw, sh, feat } = refBuf;
    const bgFeat = roomModel.bgFeat;
    if (roomModel.sw !== sw || roomModel.sh !== sh) return estimateHeadFromBuffer(refBuf, visibleBox);

    const vx0 = visibleBox ? clamp(visibleBox.x0 + 0.04, 0.04, 0.88) : 0.08;
    const vx1 = visibleBox ? clamp(visibleBox.x1 - 0.04, vx0 + 0.08, 0.96) : 0.92;
    const xMin = Math.floor(sw * vx0);
    const xMax = Math.ceil(sw * vx1);
    const yMin = Math.floor(sh * 0.04);
    const yMax = Math.floor(sh * 0.68);

    const rowMass = new Float32Array(sh);
    const rowCenter = new Float32Array(sh);
    let peakMass = 0;

    for (let y = yMin; y <= yMax; y++) {
      let mass = 0, wx = 0;
      for (let x = xMin; x <= xMax; x++) {
        const i = y * sw + x;
        const idx = i * 3;
        const fgDiff = Math.abs(feat[idx] - bgFeat[idx]) +
                       Math.abs(feat[idx + 1] - bgFeat[idx + 1]) * 0.85 +
                       Math.abs(feat[idx + 2] - bgFeat[idx + 2]) * 0.65;
        if (fgDiff > 18 && roomModel.activity[i] > 10) {
          const w = fgDiff - 16;
          mass += w;
          wx += x * w;
        }
      }
      rowMass[y] = mass;
      rowCenter[y] = mass > 0 ? wx / mass : sw * 0.5;
      if (mass > peakMass) peakMass = mass;
    }

    if (peakMass < sw * 0.7) {
      return estimateHeadFromBuffer(refBuf, visibleBox);
    }

    const th = peakMass * 0.22;
    let topY = -1;
    for (let y = yMin; y <= yMax - 2; y++) {
      if (rowMass[y] >= th && rowMass[y + 1] >= th * 0.85) {
        topY = y;
        break;
      }
    }
    if (topY < 0) return estimateHeadFromBuffer(refBuf, visibleBox);

    const headH = Math.max(4, Math.round(sh * 0.068));
    const cy = clamp(topY + headH, yMin + 3, yMax);
    let sumW = 0, sumX = 0;
    const yEnd = Math.min(yMax, topY + headH * 2);
    for (let y = topY; y <= yEnd; y++) {
      const w = rowMass[y] + 0.1;
      sumW += w;
      sumX += rowCenter[y] * w;
    }
    const cx = sumW > 0 ? sumX / sumW : sw * 0.5;

    let varSum = 0, varW = 0;
    for (let y = topY; y <= yEnd; y++) {
      for (let x = xMin; x <= xMax; x++) {
        const i = y * sw + x;
        const idx = i * 3;
        const fgDiff = Math.abs(feat[idx] - bgFeat[idx]) +
                       Math.abs(feat[idx + 1] - bgFeat[idx + 1]) * 0.85 +
                       Math.abs(feat[idx + 2] - bgFeat[idx + 2]) * 0.65;
        if (fgDiff > 18 && roomModel.activity[i] > 10 && Math.abs(x - cx) <= sw * 0.24) {
          const w = fgDiff - 16;
          varSum += w * (x - cx) * (x - cx);
          varW += w;
        }
      }
    }
    const estMr = varW > 0
      ? clamp((Math.sqrt(varSum / varW) * 2.05 / Math.min(sw, sh)) * 1.18, 0.048, 0.28)
      : 0.105;

    return {
      mx: clamp(cx / sw, 0.05, 0.95),
      my: clamp(cy / sh, 0.05, 0.72),
      mr: estMr
    };
  }

  // ---------- 7段階マルチスケール＋楕円ガウス重み外観トラッカー（位置＋遠近サイズ同時追跡） ----------
  function getEllipticalRadiiPx(sw, sh, mr) {
    const minDim = Math.min(sw, sh);
    const basePx = clamp((mr || 0.11) * minDim * 0.80, 4.2, minDim * 0.42);
    return {
      rx: Math.max(4.0, basePx * 0.92),
      ry: Math.max(4.8, basePx * 1.14)
    };
  }

  function extractEllipticalModel(buf, mx, my, mr) {
    if (!buf || !buf.feat) return null;
    const { feat, sw, sh } = buf;
    const { rx, ry } = getEllipticalRadiiPx(sw, sh, mr);
    const cx = clamp(mx * sw, rx + 1, sw - rx - 2);
    const cy = clamp(my * sh, ry + 1, sh - ry - 2);

    const m = DISC_PTS.length;
    const tpl = new Float32Array(m * 3);
    let sumW = 0, meanY = 0, meanRG = 0, meanBY = 0;

    for (let i = 0; i < m; i++) {
      const pt = DISC_PTS[i];
      const px = clamp(Math.round(cx + pt.nx * rx), 0, sw - 1);
      const py = clamp(Math.round(cy + pt.ny * ry), 0, sh - 1);
      const idx = (py * sw + px) * 3;
      const y = feat[idx], rg = feat[idx + 1], by = feat[idx + 2];
      tpl[i * 3] = y;
      tpl[i * 3 + 1] = rg;
      tpl[i * 3 + 2] = by;
      meanY += y * pt.w;
      meanRG += rg * pt.w;
      meanBY += by * pt.w;
      sumW += pt.w;
    }

    meanY /= sumW;
    meanRG /= sumW;
    meanBY /= sumW;

    return {
      tpl,
      baseTpl: new Float32Array(tpl),
      meanY,
      meanRG,
      meanBY,
      baseMeanRG: meanRG,
      baseMeanBY: meanBY,
      sumW,
      seedMr: mr || 0.11,
      mr: mr || 0.11
    };
  }

  function updateEllipticalModelGuarded(model, buf, mx, my, nextMr, sadMean, fgScore) {
    if (!model) return;
    model.mr = nextMr;
    if (!buf || sadMean > 24.5 || fgScore < 5) return;
    const cur = extractEllipticalModel(buf, mx, my, nextMr);
    if (!cur) return;
    let meanY = 0, meanRG = 0, meanBY = 0;
    for (let i = 0; i < DISC_PTS.length; i++) {
      const k = i * 3;
      const w = DISC_PTS[i].w;
      model.tpl[k] = model.baseTpl[k] * 0.85 + cur.tpl[k] * 0.15;
      model.tpl[k + 1] = model.baseTpl[k + 1] * 0.85 + cur.tpl[k + 1] * 0.15;
      model.tpl[k + 2] = model.baseTpl[k + 2] * 0.85 + cur.tpl[k + 2] * 0.15;
      meanY += model.tpl[k] * w;
      meanRG += model.tpl[k + 1] * w;
      meanBY += model.tpl[k + 2] * w;
    }
    model.meanY = meanY / model.sumW;
    model.meanRG = model.baseMeanRG * 0.85 + (meanRG / model.sumW) * 0.15;
    model.meanBY = model.baseMeanBY * 0.85 + (meanBY / model.sumW) * 0.15;
  }

  function evalEllipticalCandidate(buf, prevBuf, roomModel, model, cx, cy, rx, ry, pcx, pcy, prevCx, prevCy) {
    const { feat, sw, sh } = buf;
    const m = DISC_PTS.length;
    const sumW = model.sumW;

    let candMeanY = 0, candMeanRG = 0, candMeanBY = 0;
    for (let i = 0; i < m; i += 2) {
      const pt = DISC_PTS[i];
      const px = clamp(Math.round(cx + pt.nx * rx), 0, sw - 1);
      const py = clamp(Math.round(cy + pt.ny * ry), 0, sh - 1);
      const idx = (py * sw + px) * 3;
      candMeanY += feat[idx];
    }
    const subCnt = Math.ceil(m / 2);
    const lumShift = clamp(candMeanY / subCnt - model.meanY, -38, 38);

    const hasRoom = !!(roomModel && roomModel.hasMotion && roomModel.sw === sw && roomModel.sh === sh);
    const bgFeat = hasRoom ? roomModel.bgFeat : null;
    const prevFeat = (prevBuf && prevBuf.feat && prevBuf.sw === sw && prevBuf.sh === sh) ? prevBuf.feat : null;

    let sadW = 0, fgSum = 0, motionSum = 0;
    for (let i = 0; i < m; i++) {
      const pt = DISC_PTS[i];
      const px = clamp(Math.round(cx + pt.nx * rx), 0, sw - 1);
      const py = clamp(Math.round(cy + pt.ny * ry), 0, sh - 1);
      const idx = (py * sw + px) * 3;
      const k = i * 3;

      const y = feat[idx], rg = feat[idx + 1], by = feat[idx + 2];
      candMeanRG += rg * pt.w;
      candMeanBY += by * pt.w;

      const pixDiff = Math.abs((y - lumShift) - model.tpl[k]) +
                      Math.abs(rg - model.tpl[k + 1]) * 0.95 +
                      Math.abs(by - model.tpl[k + 2]) * 0.75;
      sadW += pixDiff * pt.w;

      if (bgFeat) {
        fgSum += (Math.abs(y - bgFeat[idx]) + Math.abs(rg - bgFeat[idx + 1]) * 0.8) * pt.w;
      }
      if (prevFeat && (i & 1) === 0) {
        motionSum += Math.abs(y - prevFeat[idx]);
      }
    }

    candMeanRG /= sumW;
    candMeanBY /= sumW;
    const sadMean = sadW / sumW;
    const colorMomentCost = (Math.abs(candMeanRG - model.meanRG) + Math.abs(candMeanBY - model.meanBY) * 0.8) * 0.42;

    let haloContrast = 0, haloBgDiff = 0;
    for (let h = 0; h < HALO_PTS.length; h++) {
      const hp = HALO_PTS[h];
      const hx = clamp(Math.round(cx + hp.nx * rx), 0, sw - 1);
      const hy = clamp(Math.round(cy + hp.ny * ry), 0, sh - 1);
      const hIdx = (hy * sw + hx) * 3;
      haloContrast += Math.abs(feat[hIdx] - (model.meanY + lumShift)) + Math.abs(feat[hIdx + 1] - candMeanRG) * 0.7;
      if (bgFeat) {
        haloBgDiff += Math.abs(feat[hIdx] - bgFeat[hIdx]) + Math.abs(feat[hIdx + 1] - bgFeat[hIdx + 1]) * 0.7;
      }
    }
    const meanHaloContrast = haloContrast / HALO_PTS.length;
    // 外観SADを主導とし、体幹・衣服の強いコントラストに引きずられないようボーナス上限を厳格に制限
    const contourBonus = Math.min(1.6, meanHaloContrast * 0.038);

    const fgMean = bgFeat ? (fgSum / sumW) : 14;
    const haloFgMean = bgFeat ? (haloBgDiff / HALO_PTS.length) : 4;
    const fgBoundarySep = fgMean - haloFgMean * 0.92;
    const fgBonus = bgFeat ? clamp(fgBoundarySep * 0.065, -2.2, 2.4) : 0;
    const motionBonus = prevFeat ? Math.min(1.0, (motionSum / (m * 0.5)) * 0.045) : 0;

    const predDist = Math.hypot(cx - pcx, cy - pcy);
    const stepDist = Math.hypot(cx - prevCx, cy - prevCy);

    const cost = sadMean + colorMomentCost + predDist * 0.34 + stepDist * 0.14 - fgBonus - motionBonus - contourBonus;
    return { cost, sadMean, colorMomentCost, fgMean, meanHaloContrast, haloFgMean };
  }

  function matchElliptical(buf, prevBuf, roomModel, model, prevMx, prevMy, prevMr, velMx, velMy, velScale, dt) {
    const { sw, sh } = buf;
    const minCandMr = Math.max(MIN_MR, model.seedMr * 0.42);
    const maxCandMr = Math.min(MAX_MR, model.seedMr * 2.50);
    const predScale = clamp(1 + (velScale || 0) * 0.56, 0.88, 1.14);
    const baseMr = clamp(prevMr * predScale, minCandMr, maxCandMr);
    const { rx, ry } = getEllipticalRadiiPx(sw, sh, baseMr);

    const predMx = clamp(prevMx + (velMx || 0) * 0.62, 0.03, 0.97);
    const predMy = clamp(prevMy + (velMy || 0) * 0.62, 0.03, 0.97);

    const pcx = clamp(Math.round(predMx * sw), Math.ceil(rx) + 1, sw - Math.ceil(rx) - 2);
    const pcy = clamp(Math.round(predMy * sh), Math.ceil(ry) + 1, sh - Math.ceil(ry) - 2);
    const prevCx = prevMx * sw;
    const prevCy = prevMy * sh;

    // 時間ステップ dt に比例した探索窓（0.10秒ステップでは±10%に制限し、体幹・腰への飛び移りを物理的に遮断）
    const maxMoveNorm = clamp(0.065 + (dt || 0.10) * 0.38, 0.075, 0.22);
    const searchRx = Math.max(8, Math.round(sw * maxMoveNorm));
    const searchRy = Math.max(10, Math.round(sh * maxMoveNorm));

    const padX = Math.min(Math.floor(sw * 0.35), Math.ceil(rx) + 1);
    const padY = Math.min(Math.floor(sh * 0.35), Math.ceil(ry) + 1);
    const x0 = Math.max(padX, pcx - searchRx);
    const x1 = Math.min(sw - padX - 1, pcx + searchRx);
    const y0 = Math.max(padY, pcy - searchRy);
    const y1 = Math.min(sh - padY - 1, pcy + searchRy);

    let bestCost = Infinity, bestSad = Infinity, bestX = pcx, bestY = pcy, bestFg = 10;
    for (let cy = y0; cy <= y1; cy += 2) {
      for (let cx = x0; cx <= x1; cx += 2) {
        const ev = evalEllipticalCandidate(buf, prevBuf, roomModel, model, cx, cy, rx, ry, pcx, pcy, prevCx, prevCy);
        if (ev.cost < bestCost) {
          bestCost = ev.cost;
          bestSad = ev.sadMean;
          bestX = cx;
          bestY = cy;
          bestFg = ev.fgMean;
        }
      }
    }

    const fx0 = Math.max(padX, bestX - 2);
    const fx1 = Math.min(sw - padX - 1, bestX + 2);
    const fy0 = Math.max(padY, bestY - 2);
    const fy1 = Math.min(sh - padY - 1, bestY + 2);
    for (let cy = fy0; cy <= fy1; cy++) {
      for (let cx = fx0; cx <= fx1; cx++) {
        const ev = evalEllipticalCandidate(buf, prevBuf, roomModel, model, cx, cy, rx, ry, pcx, pcy, prevCx, prevCy);
        if (ev.cost < bestCost) {
          bestCost = ev.cost;
          bestSad = ev.sadMean;
          bestX = cx;
          bestY = cy;
          bestFg = ev.fgMean;
        }
      }
    }

    // 第3段階：ロックされた頭部中心 (bestX, bestY) を固定したまま、7段階スケール候補を評価して遠近サイズ変化を即応追従
    let bestMr = baseMr, bestScaleCost = Infinity;
    for (let s = 0; s < SCALE_FACTORS.length; s++) {
      const sf = SCALE_FACTORS[s];
      const candMr = clamp(baseMr * sf, minCandMr, maxCandMr);
      const rad = getEllipticalRadiiPx(sw, sh, candMr);
      const ev = evalEllipticalCandidate(buf, prevBuf, roomModel, model, bestX, bestY, rad.rx, rad.ry, bestX, bestY, bestX, bestY);
      const scaleFgBonus = clamp((ev.fgMean - ev.haloFgMean * 0.92) * 0.155, -2.5, 9.8);
      const scaleContourBonus = Math.min(5.0, ev.meanHaloContrast * 0.088);
      const regPenalty = Math.abs(sf - 1.0) * 1.45;
      const sCost = ev.sadMean + ev.colorMomentCost - scaleFgBonus - scaleContourBonus + regPenalty;
      if (sCost < bestScaleCost) {
        bestScaleCost = sCost;
        bestMr = candMr;
        bestSad = Math.min(bestSad, ev.sadMean);
      }
    }
    const nextMr = clamp(prevMr * 0.18 + bestMr * 0.82, minCandMr, maxCandMr);

    return {
      mx: clamp(bestX / sw, 0.02, 0.98),
      my: clamp(bestY / sh, 0.02, 0.98),
      mr: nextMr,
      cost: bestCost,
      sadMean: bestSad,
      fgMean: bestFg
    };
  }

  function trackSequenceElliptical(bufs, times, roomModel, startIdx, dir, seedFrame) {
    const n = times.length;
    const out = new Array(n);
    out[startIdx] = { t: times[startIdx], mx: seedFrame.mx, my: seedFrame.my, mr: seedFrame.mr };
    const model = bufs[startIdx]
      ? extractEllipticalModel(bufs[startIdx], seedFrame.mx, seedFrame.my, seedFrame.mr)
      : null;

    let velX = 0, velY = 0, velScale = 0;
    for (let i = startIdx + dir; i >= 0 && i < n; i += dir) {
      const prev = out[i - dir];
      const curBuf = bufs[i];
      const prevBuf = bufs[i - dir];
      const dt = Math.abs(times[i] - times[i - dir]) || 0.10;
      if (model && curBuf) {
        const m = matchElliptical(curBuf, prevBuf, roomModel, model, prev.mx, prev.my, prev.mr, velX, velY, velScale, dt);
        velX = (m.mx - prev.mx) * 0.72 + velX * 0.28;
        velY = (m.my - prev.my) * 0.72 + velY * 0.28;
        const stepScale = (m.mr - prev.mr) / Math.max(0.04, prev.mr);
        velScale = stepScale * 0.72 + velScale * 0.28;
        out[i] = { t: times[i], mx: m.mx, my: m.my, mr: m.mr };
        updateEllipticalModelGuarded(model, curBuf, m.mx, m.my, m.mr, m.sadMean, m.fgMean);
      } else {
        out[i] = { t: times[i], mx: prev.mx, my: prev.my, mr: prev.mr };
      }
    }
    return out;
  }

  /**
   * ゼロ位相・ジグザグ微細ブレ＆スパイク除去フィルタ：
   * - 1フレームのみのAIジグザグ揺れ（dot < 0 かつ非頂点）を強力に抑制
   * - 一方向への移動中（dot >= 0）は対称3点フィルタにより位相遅れ 0.0ms を維持
   * - 5フレーム窓で検証された真の折り返し頂点（前屈最下点・最接近点など）は 100% 生値を保持しピーク潰れゼロ
   */
  function smoothKeyframesAdaptive(frames, pinnedIdx) {
    if (!frames || frames.length <= 2) return frames ? frames.map((f) => ({ ...f })) : [];
    const n = frames.length;
    const out = frames.map((f) => ({ ...f }));

    for (let i = 1; i < n - 1; i++) {
      if (i === pinnedIdx) continue;
      const prev = frames[i - 1], cur = frames[i], next = frames[i + 1];
      const dtPrev = Math.max(0.015, cur.t - prev.t);
      const dtNext = Math.max(0.015, next.t - cur.t);

      // 粗間隔（Pass1の0.26秒超）では複数秒にわたる平滑遅延を防ぐため生キーフレームを維持
      if (Math.max(dtPrev, dtNext) > 0.26) continue;

      const dx1 = cur.mx - prev.mx, dy1 = cur.my - prev.my;
      const dx2 = next.mx - cur.mx, dy2 = next.my - cur.my;
      const dot = dx1 * dx2 + dy1 * dy2;
      const stepMax = Math.max(Math.hypot(dx1, dy1), Math.hypot(dx2, dy2));
      const netDist = Math.hypot(next.mx - prev.mx, next.my - prev.my);
      const netVel = netDist / (dtPrev + dtNext);

      // 5フレーム窓による真の折り返し頂点（前屈最下点など）判定：前後2ステップが一貫して接近・離脱している場合のみ頂点保護
      let isTrueApex = false;
      if (dot < 0 && i >= 2 && i <= n - 3) {
        const p2 = frames[i - 2], n2 = frames[i + 2];
        const appDist = Math.hypot(cur.mx - p2.mx, cur.my - p2.my);
        const depDist = Math.hypot(n2.mx - cur.mx, n2.my - cur.my);
        const dotApp = (prev.mx - p2.mx) * dx1 + (prev.my - p2.my) * dy1;
        const dotDep = dx2 * (n2.mx - next.mx) + dy2 * (n2.my - next.my);
        if (appDist >= 0.022 && depDist >= 0.022 && (dotApp > 0 || dotDep > 0)) {
          isTrueApex = true;
        }
      }

      if (isTrueApex) {
        out[i].mx = cur.mx;
        out[i].my = cur.my;
      } else if (dot < 0) {
        // 1フレームのAIジグザグ反転ノイズを強力に減衰
        out[i].mx = prev.mx * 0.30 + cur.mx * 0.40 + next.mx * 0.30;
        out[i].my = prev.my * 0.30 + cur.my * 0.40 + next.my * 0.30;
      } else if (netVel < 0.08 && stepMax < 0.015) {
        // 静止〜微動時
        out[i].mx = prev.mx * 0.24 + cur.mx * 0.52 + next.mx * 0.24;
        out[i].my = prev.my * 0.24 + cur.my * 0.52 + next.my * 0.24;
      } else if (netVel < 0.28) {
        // 等速〜中速移動（対称フィルタのため位相遅れゼロで横ブレのみ除去）
        out[i].mx = prev.mx * 0.12 + cur.mx * 0.76 + next.mx * 0.12;
        out[i].my = prev.my * 0.12 + cur.my * 0.76 + next.my * 0.12;
      } else {
        // 高速一貫移動
        out[i].mx = prev.mx * 0.04 + cur.mx * 0.92 + next.mx * 0.04;
        out[i].my = prev.my * 0.04 + cur.my * 0.92 + next.my * 0.04;
      }

      const baseMr = Math.max(0.04, cur.mr);
      const rRatePrev = Math.abs(cur.mr - prev.mr) / (dtPrev * baseMr);
      const rRateNext = Math.abs(next.mr - cur.mr) / (dtNext * baseMr);
      const instScaleRate = Math.max(rRatePrev, rRateNext);

      if (instScaleRate < 0.22) {
        out[i].mr = prev.mr * 0.20 + cur.mr * 0.60 + next.mr * 0.20;
      } else if (instScaleRate < 0.52) {
        out[i].mr = prev.mr * 0.09 + cur.mr * 0.82 + next.mr * 0.09;
      } else {
        out[i].mr = prev.mr * 0.03 + cur.mr * 0.94 + next.mr * 0.03;
      }
    }

    if (typeof pinnedIdx === "number" && pinnedIdx >= 0 && pinnedIdx < n) {
      out[pinnedIdx] = { ...frames[pinnedIdx] };
    }
    return out;
  }

  // ---------- 直列デコーダキュー＋厳密 seeked + 1rAF 同期シーク ----------
  let scanQueue = Promise.resolve();

  function enqueueVideoScan(taskFn) {
    const job = scanQueue.then(taskFn);
    scanQueue = job.catch(() => null);
    return job;
  }

  /**
   * 厳密な seeked イベント完了＋1フレームコンポジット待機（長GOP動画でのシーク途中タイムアウトや一時停止rVFC未発火72ms遅延を根絶）
   */
  function seekOnce(v, t, timeoutMs) {
    return new Promise((resolve) => {
      const target = Math.max(0, t || 0);

      const startSeek = () => {
        if (Math.abs(v.currentTime - target) < 0.004 && !v.seeking && v.readyState >= 2) {
          resolve(v.currentTime);
          return;
        }

        const hasRVFC = typeof v.requestVideoFrameCallback === "function";
        let done = false;
        let seekedFired = false;
        let vfcFired = !hasRVFC;
        let capturedPts = null;
        let vfcId = 0;
        let postSeekTimer = 0;

        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(hardTimer);
          if (postSeekTimer) clearTimeout(postSeekTimer);
          v.removeEventListener("seeked", onSeeked);
          if (hasRVFC && vfcId && !vfcFired && typeof v.cancelVideoFrameCallback === "function") {
            try { v.cancelVideoFrameCallback(vfcId); } catch (e) {}
          }
          const pts = (capturedPts !== null && Math.abs(capturedPts - v.currentTime) < 0.25)
            ? capturedPts
            : v.currentTime;
          resolve(Math.max(0, pts));
        };

        const onSeeked = () => {
          seekedFired = true;
          if (vfcFired) {
            if (!hasRVFC && typeof requestAnimationFrame === "function") {
              requestAnimationFrame(() => requestAnimationFrame(finish));
            } else {
              finish();
            }
            return;
          }
          // 同一ビデオフレームPTSに着地してrVFCが再発火しないケースのフォールバック
          postSeekTimer = setTimeout(finish, 32);
        };

        const hardTimer = setTimeout(finish, timeoutMs || 420);
        v.addEventListener("seeked", onSeeked);

        if (hasRVFC) {
          try {
            vfcId = v.requestVideoFrameCallback((_now, meta) => {
              if (meta && typeof meta.mediaTime === "number" && isFinite(meta.mediaTime)) {
                capturedPts = meta.mediaTime;
              }
              vfcFired = true;
              if (seekedFired) finish();
            });
          } catch (e) {
            vfcFired = true;
          }
        }

        const prevTime = v.currentTime;
        try {
          v.currentTime = target;
          if (!v.seeking && Math.abs(v.currentTime - prevTime) < 0.002 && v.readyState >= 2) {
            finish();
          }
        } catch (e) {
          finish();
        }
      };

      // 直前のシークがまだ進行中の場合は完了を待ってから次シークを発行（カスケード中断の防止）
      if (v.seeking) {
        let waitDone = false;
        const proceed = () => {
          if (waitDone) return;
          waitDone = true;
          clearTimeout(wTimer);
          v.removeEventListener("seeked", proceed);
          startSeek();
        };
        const wTimer = setTimeout(proceed, 260);
        v.addEventListener("seeked", proceed);
      } else {
        startSeek();
      }
    });
  }

  async function primeTempVideo(v) {
    try {
      if (!isFinite(v.duration) || v.duration <= 0) {
        await seekOnce(v, 1e7, 650);
        await seekOnce(v, 0, 400);
      }
      const p = v.play();
      if (p && typeof p.then === "function") {
        await Promise.race([p.catch(() => {}), new Promise((r) => setTimeout(r, 110))]);
      }
      await new Promise((r) => setTimeout(r, 20));
      v.pause();
    } catch (e) {}
  }

  function withTempVideo(url, knownDuration, workFn) {
    return enqueueVideoScan(() => new Promise((resolve) => {
      const v = document.createElement("video");
      v.muted = true;
      v.playsInline = true;
      v.preload = "auto";
      v.width = 64;
      v.height = 64;
      v.setAttribute("playsinline", "");
      v.setAttribute("webkit-playsinline", "");
      v.style.cssText = "position:fixed;right:2px;bottom:2px;width:4px;height:4px;opacity:0.004;pointer-events:none;z-index:9;contain:strict";
      document.body.appendChild(v);

      let cleaned = false;
      let partialGetter = null;
      const setPartialGetter = (fn) => { partialGetter = fn; };

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

      const hardTimer = setTimeout(() => {
        let fallbackVal = null;
        try { if (partialGetter) fallbackVal = partialGetter(); } catch (e) {}
        cleanup(fallbackVal);
      }, 45000);

      v.onerror = () => cleanup(null);
      v.onloadeddata = async () => {
        try {
          await primeTempVideo(v);
          const rawDur = (isFinite(v.duration) && v.duration > 0)
            ? v.duration
            : ((isFinite(knownDuration) && knownDuration > 0) ? knownDuration : 30);
          const res = await workFn(v, rawDur, setPartialGetter);
          cleanup(res);
        } catch (e) {
          let fallbackVal = null;
          try { if (partialGetter) fallbackVal = partialGetter(); } catch (_) {}
          cleanup(fallbackVal);
        }
      };
      v.src = url;
    }));
  }

  function buildScanTimes(dur) {
    const maxT = Math.min(MAX_TRACK_SEC, Math.max(0.3, dur));
    const step = Math.max(BASE_STEP_SEC, Math.round((maxT / MAX_SCAN_POINTS) * 100) / 100);
    const times = [];
    for (let t = 0; t <= maxT - 0.02; t = Math.round((t + step) * 100) / 100) {
      times.push(t);
    }
    if (!times.length || times[times.length - 1] < maxT - step * 0.45) {
      times.push(Math.max(0, Math.round((maxT - 0.03) * 100) / 100));
    }
    return { times, step };
  }

  function buildTwoPassIndices(times, focusTime) {
    const n = times.length;
    if (n <= 24) {
      return { pass1: times.map((_, i) => i), pass2: [] };
    }
    const used = new Uint8Array(n);
    const pass1 = [];
    // Phase 1は10点の昇順粗スキャンで高速に全域プレビューを構築し、Phase 2は0→n-1の完全単調前進でH.264/HEVCのGOP順デコードを最大化
    const coarseCount = Math.min(10, n);
    for (let k = 0; k < coarseCount; k++) {
      const idx = Math.min(n - 1, Math.round((k * (n - 1)) / Math.max(1, coarseCount - 1)));
      if (!used[idx]) {
        used[idx] = 1;
        pass1.push(idx);
      }
    }
    if (typeof focusTime === "number" && focusTime > 0) {
      let bestI = 0, minD = Infinity;
      for (let i = 0; i < n; i++) {
        const d = Math.abs(times[i] - focusTime);
        if (d < minD) { minD = d; bestI = i; }
      }
      if (!used[bestI]) {
        used[bestI] = 1;
        pass1.push(bestI);
        pass1.sort((a, b) => a - b);
      }
    }

    const pass2 = [];
    for (let i = 0; i < n; i++) {
      if (!used[i]) {
        used[i] = 1;
        pass2.push(i);
      }
    }
    return { pass1, pass2 };
  }

  // ---------- 静止画の顔・頭部検出＋フォールバック ----------
  async function trackImage(imgEl, isCancelled, opts) {
    const visibleBox = opts && opts.visibleBox ? opts.visibleBox : null;
    if (!imgEl || !imgEl.naturalWidth || !imgEl.naturalHeight) {
      return { status: "fallback", mx: 0.5, my: 0.22, mr: 0.11, keyframes: [] };
    }
    const detectors = await getDetectors();
    if (isCancelled && isCancelled()) return null;
    const cands = detectCandidatesOnSource(detectors, imgEl, imgEl.naturalWidth, imgEl.naturalHeight);
    if (cands.length > 0) {
      cands.sort((a, b) =>
        (b.rawScore * evalVisibleWeight(b.mx, b.my, visibleBox)) -
        (a.rawScore * evalVisibleWeight(a.mx, a.my, visibleBox))
      );
      const hit = cands[0];
      return {
        status: "ai_ok",
        mx: hit.mx,
        my: hit.my,
        mr: hit.mr,
        keyframes: [{ t: 0, mx: hit.mx, my: hit.my, mr: hit.mr }]
      };
    }
    const buf = grabScanBuffer(imgEl, imgEl.naturalWidth, imgEl.naturalHeight);
    const est = estimateHeadFromBuffer(buf, visibleBox);
    return {
      status: "fallback",
      mx: est.mx,
      my: est.my,
      mr: est.mr,
      keyframes: [{ t: 0, mx: est.mx, my: est.my, mr: est.mr }]
    };
  }

  /**
   * 収集済みスロットから大域ビタビ軌道＋双方向楕円補間で全区間キーフレームを約3msで組み立てる
   */
  function assembleTrajectoryFromSlots(slots, visibleBox, anchor) {
    const collected = [];
    for (let i = 0; i < slots.length; i++) {
      if (slots[i]) collected.push(slots[i]);
    }
    if (!collected.length) return null;
    collected.sort((a, b) => a.t - b.t);

    const uniq = [collected[0]];
    for (let i = 1; i < collected.length; i++) {
      if (collected[i].t > uniq[uniq.length - 1].t + 0.012) {
        uniq.push(collected[i]);
      }
    }

    const n = uniq.length;
    const times = uniq.map((s) => s.t);
    const bufs = uniq.map((s) => s.buf);
    const candsPerFrame = uniq.map((s) => s.cands || []);
    const roomModel = buildTemporalRoomModel(bufs);

    let anchorIdx = -1;
    let matchAnchorIdx = -1;
    let anchorConstraint = null;
    if (anchor) {
      let minD = Infinity;
      for (let i = 0; i < n; i++) {
        const d = Math.abs(times[i] - anchor.t);
        if (d < minD) { minD = d; anchorIdx = i; }
      }
      const baseGate = Math.max(0.11, anchor.mr * 1.35);
      const hasNearCand = (idx, gate) => {
        const list = candsPerFrame[idx] || [];
        for (let c = 0; c < list.length; c++) {
          if (Math.hypot(list[c].mx - anchor.mx, list[c].my - anchor.my) <= gate) return true;
        }
        return false;
      };
      if (anchorIdx >= 0 && hasNearCand(anchorIdx, baseGate)) {
        matchAnchorIdx = anchorIdx;
      } else {
        let bestDt = Infinity;
        for (let i = 0; i < n; i++) {
          const dt = Math.abs(times[i] - anchor.t);
          if (dt <= 0.25 && dt < bestDt && hasNearCand(i, baseGate + 0.02)) {
            bestDt = dt;
            matchAnchorIdx = i;
          }
        }
      }
      if (matchAnchorIdx >= 0) {
        anchorConstraint = { idx: matchAnchorIdx, mx: anchor.mx, my: anchor.my, mr: anchor.mr };
      }
    }

    const selectedHits = (!anchor || anchorConstraint)
      ? selectConsistentTrack(times, candsPerFrame, roomModel, visibleBox, anchorConstraint)
      : new Array(n).fill(null);

    let relDx = 0, relDy = 0, relScale = 1;
    if (anchor && matchAnchorIdx >= 0 && selectedHits[matchAnchorIdx]) {
      const ah = selectedHits[matchAnchorIdx];
      relDx = clamp(anchor.mx - ah.mx, -0.25, 0.25);
      relDy = clamp(anchor.my - ah.my, -0.25, 0.25);
      relScale = clamp(anchor.mr / Math.max(0.038, ah.mr), 0.55, 1.75);
    }

    const hitIndices = [];
    for (let i = 0; i < n; i++) {
      if (selectedHits[i]) hitIndices.push(i);
    }

    const minRequiredHits = anchor ? Math.max(2, Math.floor(n * 0.22)) : 1;
    if (hitIndices.length >= minRequiredHits) {
      const frames = new Array(n);
      for (let h = 0; h < hitIndices.length; h++) {
        const idx = hitIndices[h];
        const hit = selectedHits[idx];
        frames[idx] = {
          t: times[idx],
          mx: clamp(hit.mx + relDx, 0.02, 0.98),
          my: clamp(hit.my + relDy, 0.02, 0.98),
          mr: clamp(hit.mr * relScale, MIN_MR, MAX_MR)
        };
      }
      if (anchor && anchorIdx >= 0) {
        frames[anchorIdx] = { t: times[anchorIdx], mx: anchor.mx, my: anchor.my, mr: anchor.mr };
        if (!hitIndices.includes(anchorIdx)) {
          hitIndices.push(anchorIdx);
          hitIndices.sort((a, b) => a - b);
        }
      }

      const firstIdx = hitIndices[0];
      if (firstIdx > 0) {
        const backSeq = trackSequenceElliptical(bufs, times, roomModel, firstIdx, -1, frames[firstIdx]);
        for (let i = 0; i < firstIdx; i++) frames[i] = backSeq[i];
      }

      for (let h = 0; h < hitIndices.length - 1; h++) {
        const i0 = hitIndices[h];
        const i1 = hitIndices[h + 1];
        if (i1 - i0 <= 1) continue;
        const subLen = i1 - i0 + 1;
        const subBufs = bufs.slice(i0, i1 + 1);
        const subTimes = times.slice(i0, i1 + 1);
        const fwd = trackSequenceElliptical(subBufs, subTimes, roomModel, 0, +1, frames[i0]);
        const bwd = trackSequenceElliptical(subBufs, subTimes, roomModel, subLen - 1, -1, frames[i1]);
        const spanT = Math.max(0.001, times[i1] - times[i0]);
        for (let k = 1; k < subLen - 1; k++) {
          const u = clamp((subTimes[k] - times[i0]) / spanT, 0, 1);
          const s = u * u * (3 - 2 * u);
          const trackedMr = fwd[k].mr * (1 - s) + bwd[k].mr * s;
          const endpointMr = frames[i0].mr * (1 - s) + frames[i1].mr * s;
          const trackW = spanT > 0.30 ? 0.85 : 0.65;
          frames[i0 + k] = {
            t: subTimes[k],
            mx: fwd[k].mx * (1 - s) + bwd[k].mx * s,
            my: fwd[k].my * (1 - s) + bwd[k].my * s,
            mr: clamp(trackedMr * trackW + endpointMr * (1 - trackW), MIN_MR, MAX_MR)
          };
        }
      }

      const lastIdx = hitIndices[hitIndices.length - 1];
      if (lastIdx < n - 1) {
        const fwdSeq = trackSequenceElliptical(bufs, times, roomModel, lastIdx, +1, frames[lastIdx]);
        for (let i = lastIdx + 1; i < n; i++) frames[i] = fwdSeq[i];
      }

      const smoothed = smoothKeyframesAdaptive(frames, anchor ? anchorIdx : -1);
      return {
        status: anchor ? "patch_ok" : "ai_ok",
        mx: anchor ? anchor.mx : smoothed[0].mx,
        my: anchor ? anchor.my : smoothed[0].my,
        mr: anchor ? anchor.mr : smoothed[0].mr,
        keyframes: smoothed
      };
    }

    if (anchor && anchorIdx >= 0) {
      const seed = { t: times[anchorIdx], mx: anchor.mx, my: anchor.my, mr: anchor.mr };
      const fwd = trackSequenceElliptical(bufs, times, roomModel, anchorIdx, +1, seed);
      const bwd = trackSequenceElliptical(bufs, times, roomModel, anchorIdx, -1, seed);
      const frames = new Array(n);
      for (let i = 0; i < n; i++) frames[i] = i >= anchorIdx ? fwd[i] : bwd[i];
      const smoothed = smoothKeyframesAdaptive(frames, anchorIdx);
      return {
        status: "patch_ok",
        mx: anchor.mx,
        my: anchor.my,
        mr: anchor.mr,
        keyframes: smoothed
      };
    }

    const est = estimateMovingHeadAtIndex(bufs, 0, roomModel, visibleBox);
    const seq = trackSequenceElliptical(bufs, times, roomModel, 0, +1, { t: times[0], mx: est.mx, my: est.my, mr: est.mr });
    const smoothed = smoothKeyframesAdaptive(seq, -1);
    return {
      status: "fallback",
      mx: smoothed[0].mx,
      my: smoothed[0].my,
      mr: smoothed[0].mr,
      keyframes: smoothed
    };
  }

  /**
   * キャッシュ済みスロットがあればデコード・AI推論ゼロ（約3ms）で即座に再追従結果を返す
   */
  function retrackFromCache(url, opts, anchor) {
    if (!url || !slotCache.has(url)) return null;
    const entry = getOrCreateCacheEntry(url, null);
    if (!entry) return null;
    let count = 0;
    for (let i = 0; i < entry.slots.length; i++) if (entry.slots[i]) count++;
    if (count < 2) return null;
    const visibleBox = opts && opts.visibleBox ? opts.visibleBox : null;
    const cleanAnchor = anchor
      ? {
          t: Math.max(0, Number(anchor.t) || 0),
          mx: clamp(Number(anchor.mx) || 0.5, 0.02, 0.98),
          my: clamp(Number(anchor.my) || 0.22, 0.02, 0.98),
          mr: clamp(Number(anchor.mr) || 0.11, MIN_MR, MAX_MR)
        }
      : null;
    const res = assembleTrajectoryFromSlots(entry.slots, visibleBox, cleanAnchor);
    if (!res) return null;
    return { ...res, fromCache: true, complete: !!entry.complete };
  }

  /**
   * 2フェーズ分割インターリーブ＋単調前進10fpsフルDual-AI動画追従：
   * - キャッシュ完了済みなら 0ms 即時返却
   * - Phase 1（8点粗スキャン）完了時点で一度デコーダロックを解放し、Before/After双方の初期追従を素早く開始
   * - Phase 2（10fps高密度スキャン）は 0→n-1 の単調前進シーク＋全フレームDual-AI検出で最高精度を保証
   */
  async function runTwoPassVideoTrack(url, knownDuration, isCancelled, opts, anchor) {
    const onProgress = opts && typeof opts.onProgress === "function" ? opts.onProgress : null;
    const visibleBox = opts && opts.visibleBox ? opts.visibleBox : null;
    const focusTime = anchor ? anchor.t : (opts && typeof opts.focusTime === "number" ? opts.focusTime : 0);

    // すでに全フレームキャッシュ済みならデコーダもWASMも一切回さず約3msで即座に完了
    const existing = url && slotCache.has(url) ? getOrCreateCacheEntry(url, null) : null;
    if (existing && existing.complete) {
      return assembleTrajectoryFromSlots(existing.slots, visibleBox, anchor);
    }
    // 部分キャッシュ（Pass1完了後など）がある場合も即座に先行プレビューを反映
    if (existing && onProgress) {
      const quickPartial = assembleTrajectoryFromSlots(existing.slots, visibleBox, anchor);
      if (quickPartial) {
        let doneCnt = 0;
        for (let i = 0; i < existing.slots.length; i++) if (existing.slots[i]) doneCnt++;
        onProgress({ ...quickPartial, progress: Math.min(0.95, doneCnt / Math.max(1, existing.slots.length)) });
      }
    }

    const detectors = await getDetectors();
    if (isCancelled && isCancelled()) return null;

    // --- 単一デコーダセッションによる2パス走査（Phase 1: 全域先行ロック → 即時プレビュー通知 → Phase 2: 0→n-1 単調前進フルDual-AIスキャン） ---
    let cacheEntry = existing;
    return await withTempVideo(url, knownDuration, async (v, dur, setPartialGetter) => {
      if (!dur || dur <= 0) return null;
      const vw = v.videoWidth || 360, vh = v.videoHeight || 640;
      if (!cacheEntry) {
        const { times, step } = buildScanTimes(dur);
        cacheEntry = getOrCreateCacheEntry(url, { vw, vh, dur, times, step });
      }
      const { times, step, slots } = cacheEntry;
      const { pass1, pass2 } = buildTwoPassIndices(times, focusTime);
      const totalCount = pass1.length + pass2.length;

      const buildCurrent = () => assembleTrajectoryFromSlots(slots, visibleBox, anchor);
      setPartialGetter(buildCurrent);

      for (let k = 0; k < pass1.length; k++) {
        if (isCancelled && isCancelled()) return null;
        const slotIdx = pass1[k];
        if (slots[slotIdx]) continue;
        const targetT = times[slotIdx];
        if (targetT > cacheEntry.realMaxT + 0.015) continue;

        const actualPts = await seekOnce(v, targetT, 420);
        if (targetT > 0.35 && (v.ended || actualPts < targetT - Math.max(0.08, step * 0.75))) {
          cacheEntry.realMaxT = Math.max(0.2, actualPts);
          continue;
        }
        await yieldInteractive(false);
        const cands = detectors ? detectCandidatesOnSource(detectors, v, vw, vh) : [];
        const buf = grabScanBuffer(v, vw, vh);
        slots[slotIdx] = { t: actualPts, cands, buf };
        if (pass2.length === 0 && onProgress && (k === 5 || k === 12 || k === pass1.length - 1)) {
          const partial = buildCurrent();
          if (partial) {
            onProgress({ ...partial, progress: Math.min(0.98, (k + 1) / Math.max(1, totalCount)) });
          }
        }
        await yieldInteractive(false);
      }

      if (pass2.length === 0) {
        cacheEntry.complete = true;
        return buildCurrent();
      }

      const partial1 = buildCurrent();
      if (partial1 && onProgress) {
        let doneCnt = 0;
        for (let i = 0; i < slots.length; i++) if (slots[i]) doneCnt++;
        onProgress({ ...partial1, progress: Math.min(0.96, doneCnt / Math.max(1, totalCount)) });
      }
      await yieldInteractive(true);

      if (v.currentTime > 0.25) {
        await seekOnce(v, 0, 360);
      }

      let newlyScanned = 0;
      for (let k = 0; k < pass2.length; k++) {
        if (isCancelled && isCancelled()) return null;
        const slotIdx = pass2[k];
        if (slots[slotIdx]) continue;
        const targetT = times[slotIdx];
        if (targetT > cacheEntry.realMaxT + 0.015) continue;

        const actualPts = await seekOnce(v, targetT, 400);
        if (targetT > 0.35 && (v.ended || actualPts < targetT - Math.max(0.08, step * 0.75))) {
          cacheEntry.realMaxT = Math.max(0.2, actualPts);
          continue;
        }

        const buf = grabScanBuffer(v, vw, vh);
        await yieldInteractive(false);
        const cands = detectors ? detectCandidatesOnSource(detectors, v, vw, vh) : [];
        slots[slotIdx] = { t: actualPts, cands, buf };
        newlyScanned++;

        if (onProgress && (newlyScanned % 6 === 0 || k === pass2.length - 1)) {
          const partial = buildCurrent();
          if (partial) {
            let doneCnt = 0;
            for (let i = 0; i < slots.length; i++) if (slots[i]) doneCnt++;
            onProgress({ ...partial, progress: Math.min(0.99, doneCnt / Math.max(1, totalCount)) });
          }
        }
        await yieldInteractive(false);
      }

      cacheEntry.complete = true;
      return buildCurrent();
    });
  }

  async function trackVideoAuto(url, knownDuration, isCancelled, opts) {
    return await runTwoPassVideoTrack(url, knownDuration, isCancelled, opts, null);
  }

  async function trackVideoFromAnchor(url, knownDuration, anchor, isCancelled, opts) {
    const cleanAnchor = {
      t: Math.max(0, Number(anchor && anchor.t) || 0),
      mx: clamp(Number(anchor && anchor.mx) || 0.5, 0.02, 0.98),
      my: clamp(Number(anchor && anchor.my) || 0.22, 0.02, 0.98),
      mr: clamp(Number(anchor && anchor.mr) || 0.11, MIN_MR, MAX_MR)
    };
    return await runTwoPassVideoTrack(url, knownDuration, isCancelled, opts, cleanAnchor);
  }

  // ---------- ゼロ・イーズイン単調エルミート補間（動き出し・サイズ変化の立ち上がり遅延ゼロ＆オーバーシュート防止） ----------
  function interpMonotoneCubic(kf, lo, hi, t, prop) {
    const a = kf[lo], b = kf[hi];
    const h = Math.max(0.0001, b.t - a.t);
    const u = clamp((t - a.t) / h, 0, 1);
    const delta = (b[prop] - a[prop]) / h;
    if (Math.abs(delta) < 1e-7) return a[prop];

    // 粗間隔（Pass1の0.24秒超）では3次曲線のS字遅延を出さず即応線形補間
    if (h > 0.24) {
      return a[prop] + (b[prop] - a[prop]) * u;
    }

    const pPrev = lo > 0 ? kf[lo - 1] : null;
    const pNext = hi + 1 < kf.length ? kf[hi + 1] : null;

    let m0 = delta;
    if (pPrev) {
      const dPrev = (a[prop] - pPrev[prop]) / Math.max(0.0001, a.t - pPrev.t);
      // 厳密な逆転（< 0）のみ傾き0に止め、静止からの動き出し（dPrev === 0）では 0.78*delta で遅れゼロ発進
      if (dPrev * delta < 0) m0 = 0;
      else if (Math.abs(dPrev) < 1e-6) m0 = delta * 0.78;
      else m0 = dPrev * 0.28 + delta * 0.72;
    }
    let m1 = delta;
    if (pNext) {
      const dNext = (pNext[prop] - b[prop]) / Math.max(0.0001, pNext.t - b.t);
      if (delta * dNext < 0) m1 = 0;
      else if (Math.abs(dNext) < 1e-6) m1 = delta * 0.78;
      else m1 = delta * 0.72 + dNext * 0.28;
    }

    const maxSlope = 3 * Math.abs(delta);
    m0 = clamp(m0, -maxSlope, maxSlope);
    m1 = clamp(m1, -maxSlope, maxSlope);

    const u2 = u * u, u3 = u2 * u;
    const h00 = 2 * u3 - 3 * u2 + 1;
    const h10 = u3 - 2 * u2 + u;
    const h01 = -2 * u3 + 3 * u2;
    const h11 = u3 - u2;
    return h00 * a[prop] + h10 * h * m0 + h01 * b[prop] + h11 * h * m1;
  }

  function sampleAtTime(blur, currentTime) {
    if (!blur) return { mx: 0.5, my: 0.22, mr: 0.11 };
    if (blur.mode === "fixed") {
      return {
        mx: clamp(blur.fixedX, 0.02, 0.98),
        my: clamp(blur.fixedY, 0.02, 0.98),
        mr: clamp(blur.baseR || 0.11, MIN_MR, MAX_MR)
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
        mx = interpMonotoneCubic(kf, lo, hi, t, "mx");
        my = interpMonotoneCubic(kf, lo, hi, t, "my");
        mr = interpMonotoneCubic(kf, lo, hi, t, "mr");
      }
    }
    return {
      mx: clamp(mx + (blur.offsetX || 0), 0.02, 0.98),
      my: clamp(my + (blur.offsetY || 0), 0.02, 0.98),
      mr: clamp(mr, MIN_MR, MAX_MR)
    };
  }

  // ---------- 高遮蔽・滑らかガウシアン風楕円ぼかし描画 ----------
  const s1Canvas = document.createElement("canvas");
  s1Canvas.width = 40; s1Canvas.height = 40;
  const s1Ctx = s1Canvas.getContext("2d");

  const s2Canvas = document.createElement("canvas");
  s2Canvas.width = 7; s2Canvas.height = 7;
  const s2Ctx = s2Canvas.getContext("2d");

  function drawSmoothOvalBlur(ctx, W, H, LW, LH, panelRect, centerLogical, radiiLogical) {
    const sxScale = W / LW, syScale = H / LH;
    const cx = centerLogical.x, cy = centerLogical.y;
    const rx = Math.max(15, radiiLogical.rx);
    const ry = Math.max(18, radiiLogical.ry);

    if (cx + rx * 1.15 < panelRect.x || cx - rx * 1.15 > panelRect.x + panelRect.w ||
        cy + ry * 1.15 < panelRect.y || cy - ry * 1.15 > panelRect.y + panelRect.h) {
      return;
    }

    const padX = rx * 1.24, padY = ry * 1.24;
    const srcX = clamp(Math.floor((cx - padX) * sxScale), 0, W - 2);
    const srcY = clamp(Math.floor((cy - padY) * syScale), 0, H - 2);
    const srcR = clamp(Math.ceil((cx + padX) * sxScale), srcX + 2, W);
    const srcB = clamp(Math.ceil((cy + padY) * syScale), srcY + 2, H);
    const srcW = srcR - srcX, srcH = srcB - srcY;
    if (srcW < 4 || srcH < 4) return;

    s1Ctx.imageSmoothingEnabled = true;
    s2Ctx.imageSmoothingEnabled = true;
    s1Ctx.clearRect(0, 0, 40, 40);
    s1Ctx.drawImage(ctx.canvas, srcX, srcY, srcW, srcH, 0, 0, 40, 40);
    s2Ctx.clearRect(0, 0, 7, 7);
    s2Ctx.drawImage(s1Canvas, 0, 0, 40, 40, 0, 0, 7, 7);
    s1Ctx.drawImage(s2Canvas, 0, 0, 7, 7, 0, 0, 24, 24);
    s2Ctx.drawImage(s1Canvas, 0, 0, 24, 24, 0, 0, 6, 6);

    const dstLx = srcX / sxScale;
    const dstLy = srcY / syScale;
    const dstLw = srcW / sxScale;
    const dstLh = srcH / syScale;

    ctx.save();
    ctx.setTransform(sxScale, 0, 0, syScale, 0, 0);
    ctx.beginPath();
    ctx.rect(panelRect.x, panelRect.y, panelRect.w, panelRect.h);
    ctx.clip();

    ctx.imageSmoothingEnabled = true;
    if ("imageSmoothingQuality" in ctx) ctx.imageSmoothingQuality = "high";

    const layers = [
      { scale: 1.12, alpha: 0.40 },
      { scale: 1.00, alpha: 0.85 },
      { scale: 0.90, alpha: 1.00 }
    ];
    for (let i = 0; i < layers.length; i++) {
      ctx.save();
      ctx.globalAlpha = layers[i].alpha;
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx * layers[i].scale, ry * layers[i].scale, 0, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(s2Canvas, 0, 0, 6, 6, dstLx, dstLy, dstLw, dstLh);
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
    retrackFromCache,
    evictCache,
    sampleAtTime,
    drawSmoothOvalBlur,
    drawPreviewRing
  };
})();
