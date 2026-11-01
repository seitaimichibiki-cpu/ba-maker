/**
 * BAメーカー 顔・頭部ぼかし＆高精度自動追従エンジン v21（ブラウザ内完結・サーバー送信なし）
 *
 * 1. 高精度デュアルAI（MediaPipe PoseLandmarker Full 512px ＋ 2段階フル解像度ROIズーム FaceDetector）：
 *    - 全身立ち姿（2〜4.5m遠方）でも骨格から頭部領域を特定し、元映像（1080p/4K）から頭部をフル解像度切り出しズームして顔検出
 *    - 横向き歩行・猫背・前屈／後屈（90度曲げ）・ベッド施術・後ろ姿でも、両耳・顔・両肩・体幹長から360°解剖学的頭蓋中心とサイズを算出
 * 2. 大域ビタビ軌道選択（Viterbi DP）＋ハンペル外れ値除去＋可視パネル優先スコアリング：
 *    - 施術者の映り込み・鏡・壁のポスターへの誤ジャンプ（瞬間ワープ）を運動学ゲートと時間軸活動量マップで徹底排除
 * 3. 背景静止物への吸着をゼロ化する「時間中央値背景モデル＋楕円ガウス重み外観トラッカー」：
 *    - 従来の矩形パッチ四隅に含まれていた背景壁ピクセルを完全除外し、動いている人物頭部の楕円内部のみを追跡
 * 4. 2パス（粗→密0.10秒=10fps）スキャン＋アンカー誘導AI再追従＋速度適応スムージング＆単調3次エルミート補間
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
  const BASE_STEP_SEC = 0.10;   // 10fps高密度キーフレームで歩行・前屈・振り向きも遅れゼロ
  const MAX_TRACK_SEC = 180;
  const MAX_SCAN_POINTS = 220;

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const yieldStep = () => new Promise((r) => setTimeout(r, 0));

  // 楕円ヘッド内部のみをサンプリングする37点同心円ディスク（背景四隅を100%除外）
  const DISC_PTS = (() => {
    const pts = [{ nx: 0, ny: 0, w: 1.0 }];
    const rings = [
      { r: 0.34, n: 6, w: 0.90 },
      { r: 0.66, n: 12, w: 0.68 },
      { r: 0.94, n: 18, w: 0.42 }
    ];
    for (let k = 0; k < rings.length; k++) {
      const { r, n, w } = rings[k];
      for (let i = 0; i < n; i++) {
        const ang = (Math.PI * 2 * i) / n + (k % 2) * (Math.PI / n);
        pts.push({ nx: Math.cos(ang) * r, ny: Math.sin(ang) * r, w });
      }
    }
    return pts;
  })();

  // 頭頂〜側頭部の外側背景ハロー点（頭部と背景の境界コントラスト評価・胴体へのずり下がり防止）
  const HALO_PTS = [
    { nx: 0, ny: -1.32 },
    { nx: -0.92, ny: -0.95 },
    { nx: 0.92, ny: -0.95 },
    { nx: -1.28, ny: -0.15 },
    { nx: 1.28, ny: -0.15 }
  ];

  // ---------- MediaPipe デュアルAI（PoseLandmarker Full + FaceDetector）遅延ローダー ----------
  let detectorsPromise = null;
  let cachedDetectors = null;

  async function createPoseDetector(PoseLandmarker, vision) {
    if (!PoseLandmarker) return null;
    const opts = (modelUrl) => ({
      baseOptions: { modelAssetPath: modelUrl, delegate: "CPU" },
      runningMode: "IMAGE",
      numPoses: 3,
      minPoseDetectionConfidence: 0.28,
      minPosePresenceConfidence: 0.28
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
          FaceDetector
            ? FaceDetector.createFromOptions(vision, {
                baseOptions: { modelAssetPath: FACE_MODEL_URL, delegate: "CPU" },
                runningMode: "IMAGE",
                minDetectionConfidence: 0.34
              }).catch(() => null)
            : Promise.resolve(null),
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
      return 1.0 - Math.abs(mx - 0.5) * 0.22;
    }
    const { x0, y0, x1, y1 } = visibleBox;
    const midX = (x0 + x1) * 0.5;
    const spanX = Math.max(0.15, x1 - x0);
    const outX = mx < x0 ? (x0 - mx) : (mx > x1 ? (mx - x1) : 0);
    const outY = my < y0 ? (y0 - my) : (my > y1 ? (my - y1) : 0);
    const outDist = Math.hypot(outX, outY);
    if (outDist > 0) {
      // 表示パネルの外にトリミングされている人物（横の施術者等）は大幅に減点
      return Math.max(0.18, 0.72 - outDist * 2.8);
    }
    const centerPref = 1.08 - Math.min(0.22, (Math.abs(mx - midX) / spanX) * 0.24);
    return centerPref;
  }

  /**
   * 骨格推定された頭部周辺を元解像度（1080p/4K）から直接256x256へ切り出してFaceDetectorを実行する。
   * 3〜4.5m離れた全身撮影でも近距離並みの精度で顔ボックスと額〜顎中心を特定できる。
   */
  function detectFaceInPoseRoi(faceDetector, sourceEl, srcW, srcH, hx, hy, poseMr) {
    if (!faceDetector || !srcW || !srcH || srcW < 120 || srcH < 120) return null;
    ensureCanvases();
    const minSrc = Math.min(srcW, srcH);
    const halfPx = clamp(Math.round(poseMr * minSrc * 2.45), 36, Math.round(Math.max(srcW, srcH) * 0.46));
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

        // BlazeFaceのボックスは眉〜顎中心のため、額〜頭頂まで自然に覆うよう上方向へ6.5%補正
        const roiCx = (bb.originX + bb.width * 0.5) / ROI_FACE_DIM;
        const roiCy = (bb.originY + bb.height * 0.435) / ROI_FACE_DIM;
        const fMx = (sx + roiCx * sw) / srcW;
        const fMy = (sy + roiCy * sh) / srcH;

        const boxPxW = (bb.width / ROI_FACE_DIM) * sw;
        const boxPxH = (bb.height / ROI_FACE_DIM) * sh;
        const fMr = clamp((Math.max(boxPxW, boxPxH) / minSrc) * 0.74, 0.046, 0.36);

        const dist = Math.hypot(fMx - hx, fMy - hy);
        if (dist > Math.max(0.14, poseMr * 1.75)) continue;

        const score = conf * (1.25 - dist / Math.max(0.14, poseMr * 2.0));
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
   * PoseLandmarker Full の33骨格点から360°全方向（正面・真横の猫背/歩行・90度前屈・後ろ姿）で正確な頭蓋中心と半径を算出
   */
  function detectPoseCandidates(poseDetector, faceDetector, sourceEl, srcW, srcH, visibleBox) {
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
          // 耳軸（頭蓋中心）から顔面側へ0.42寄せることで、正面・横向き（猫背）・後ろ姿すべてで顔全体＋頭部を過不足なく中心捕捉
          hx = ex + (fx - ex) * 0.42;
          hy = ey + (fy - ey) * 0.42;
          earNosePx = Math.hypot((fx - ex) * dw, (fy - ey) * dh);
        } else if (earW > 0) {
          hx = earX / earW; hy = earY / earW;
        } else {
          hx = faceX / faceW; hy = faceY / faceW;
        }

        const meanVis = visSum / visCnt;

        // 両肩（11, 12）と両股関節（23, 24）から体幹長・首ベクトルを算出（横向きで肩幅が0になっても体幹長で頭サイズを安定維持）
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

        const rPx = Math.max(
          maxSpanPx * 1.65,
          earNosePx * 1.50,
          neckPx * 0.48,
          shoulderPx * 0.37,
          torsoPx * 0.235,
          minDim * 0.056
        );

        // 頭頂（額）方向へ半径の18%だけ補正（猫背の横向き立ち姿で鼻先の前方空間へ飛び出さないよう直立時は水平成分を抑制）
        if (hasShoulder && neckPx > 3) {
          let ux = ((hx - sx) * dw) / neckPx;
          let uy = ((hy - sy) * dh) / neckPx;
          const isUpright = (hipY - sy) > 0.10 && hy < sy;
          if (isUpright) {
            ux *= 0.34;
            const nLen = Math.hypot(ux, uy) || 1;
            ux /= nLen; uy /= nLen;
          }
          hx += (ux * rPx * 0.18) / dw;
          hy += (uy * rPx * 0.18) / dh;
        } else {
          hy -= (rPx * 0.14) / dh;
        }

        if (hx < -0.05 || hx > 1.05 || hy < -0.05 || hy > 1.05) continue;

        let finalMx = clamp(hx, 0.02, 0.98);
        let finalMy = clamp(hy, 0.02, 0.98);
        let finalMr = clamp((rPx / minDim) * 1.10, 0.050, 0.35);
        let finalConf = meanVis;
        let hasFace = false;

        // 2段階フル解像度ROI顔ズーム検出でミリ単位に精密化
        const roiFace = detectFaceInPoseRoi(faceDetector, sourceEl, srcW, srcH, finalMx, finalMy, finalMr);
        if (roiFace) {
          finalMx = clamp(roiFace.mx * 0.72 + finalMx * 0.28, 0.02, 0.98);
          finalMy = clamp(roiFace.my * 0.72 + finalMy * 0.28, 0.02, 0.98);
          finalMr = clamp(Math.max(roiFace.mr * 1.12, finalMr * 0.94), 0.050, 0.35);
          finalConf = Math.max(meanVis, roiFace.conf);
          hasFace = true;
        }

        const visW = evalVisibleWeight(finalMx, finalMy, visibleBox);
        const bodyBonus = hasShoulder ? (hasFace ? 1.32 : 1.14) : 0.92;
        const sizeBonus = clamp(finalMr * 5.2, 0.50, 1.32);

        out.push({
          mx: finalMx,
          my: finalMy,
          mr: finalMr,
          conf: finalConf,
          hasBody: hasShoulder,
          hasFace,
          baseScore: finalConf * visW * bodyBonus * sizeBonus
        });
      }
    } catch (e) {}
    return out;
  }

  function detectFullFrameFaceCandidates(faceDetector, sourceEl, srcW, srcH, visibleBox) {
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
        const mr = clamp((Math.max(bb.width, bb.height) / minDim) * 0.74, 0.048, 0.35);
        const visW = evalVisibleWeight(cx, cy, visibleBox);
        const sizeBonus = clamp(mr * 4.8, 0.42, 1.35);

        out.push({
          mx: cx,
          my: cy,
          mr,
          conf,
          hasBody: false,
          hasFace: true,
          baseScore: conf * visW * 0.88 * sizeBonus
        });
      }
    } catch (e) {}
    return out;
  }

  /**
   * 1フレーム上の全頭部候補（骨格＋ROI顔ズーム＋近距離顔）を重複統合して返す
   */
  function detectCandidatesOnSource(detectors, sourceEl, srcW, srcH, visibleBox) {
    if (!detectors || !srcW || !srcH) return [];
    const poseCands = detectPoseCandidates(detectors.pose, detectors.face, sourceEl, srcW, srcH, visibleBox);
    const faceCands = detectFullFrameFaceCandidates(detectors.face, sourceEl, srcW, srcH, visibleBox);

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
          matched.mx = fc.mx * 0.68 + matched.mx * 0.32;
          matched.my = fc.my * 0.68 + matched.my * 0.32;
          matched.mr = Math.max(fc.mr * 1.08, matched.mr * 0.94);
          matched.hasFace = true;
          matched.conf = Math.max(matched.conf, fc.conf);
          matched.baseScore *= 1.18;
        }
      } else {
        // すでに明確な全身骨格がある画面で、身体のない極小顔ボックス（壁のポスター等）は抑制
        if (poseCands.length > 0 && fc.mr < 0.085) {
          fc.baseScore *= 0.42;
        }
        merged.push(fc);
      }
    }

    merged.sort((a, b) => b.baseScore - a.baseScore);
    return merged.slice(0, 4);
  }

  // ---------- 特徴バッファ取得＆時間中央値背景モデル（静止背景への吸着完全防止） ----------
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
      const feat = new Float32Array(n * 3);
      let sumY = 0, minY = 255, maxY = 0;
      for (let i = 0, p = 0; i < n; i++, p += 4) {
        const r = data[p], g = data[p + 1], b = data[p + 2];
        const y = 0.299 * r + 0.587 * g + 0.114 * b;
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

  /**
   * 動画全体から最大9フレームを抽出し、ピクセルごとの時間中央値（＝静止している院内の壁・ドア・ポスター背景）と
   * 時間変動レンジ（＝人物が動いた活動領域マップ）を約1.5msで構築する
   */
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
    const bgFeat = new Float32Array(n * 3);
    const activity = new Float32Array(n);
    const tmpY = new Float32Array(sampleCnt);
    const tmpRG = new Float32Array(sampleCnt);
    const tmpBY = new Float32Array(sampleCnt);
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

      const act = maxL - minL;
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
    // 全く動かない壁のポスター（身体骨格なし＆時間変化ゼロ）を大幅に減点
    if (!cand.hasBody && peak < 8 && meanAct < 4.5) {
      return 0.28;
    }
    if (meanAct > 10 || peak > 22) {
      return 1.12;
    }
    return cand.hasBody ? 1.0 : 0.78;
  }

  /**
   * 大域ビタビ動的計画法（Viterbi DP）＋ハンペル外れ値スパイク除去：
   * 全フレームの全候補から運動学的に連続した「同一人物の頭部軌道」だけを1本選び抜く。
   * 途中で1〜2フレーム別人物やポスターが誤検出されても瞬間ワープを完全に拒否する。
   */
  function selectConsistentTrack(times, candsPerFrame, roomModel, anchorConstraint) {
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
        let nodeScore = cand.baseScore * regionActivityFactor(cand, roomModel);

        if (anchorConstraint && i === anchorConstraint.idx) {
          const dAnchor = Math.hypot(cand.mx - anchorConstraint.mx, cand.my - anchorConstraint.my);
          if (dAnchor <= Math.max(0.16, anchorConstraint.mr * 1.65)) {
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
          const dt = Math.max(0.04, times[i] - times[p]);
          // 人間の頭部の物理的な最大移動距離ゲート（急な前屈は許可しつつ画面反対側への瞬間ワープを遮断）
          const maxJump = 0.11 + 1.95 * dt;

          for (let pc = 0; pc < pList.length; pc++) {
            if (dp[p][pc] < -1e5) continue;
            const prevCand = pList[pc];
            const dist = Math.hypot(cand.mx - prevCand.mx, cand.my - prevCand.my);
            if (dist > maxJump) continue;

            const velCost = (dist / (0.07 + dt * 0.85)) * 0.42;
            const sizeCost = Math.abs(Math.log((cand.mr + 0.02) / (prevCand.mr + 0.02))) * 0.30;
            const gapCost = (i - p - 1) * 0.08;
            const candTotal = dp[p][pc] - velCost - sizeCost - gapCost;

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

    // アンカー制約がある場合、アンカーフレームを通過していない別人物トラックは破棄
    if (anchorConstraint && !selected[anchorConstraint.idx]) {
      return new Array(n).fill(null);
    }

    // 動画全体でたった1フレームしか低信頼ヒットしなかった場合はノイズ誤検出として棄却
    if (!anchorConstraint && n >= 8 && hitCount === 1) {
      const onlyIdx = selected.findIndex(Boolean);
      if (onlyIdx >= 0 && selected[onlyIdx].conf < 0.58 && !selected[onlyIdx].hasBody) {
        return new Array(n).fill(null);
      }
    }

    // ハンペル外れ値スパイク除去：前後が近い位置で一致しているのに1点だけ大きく飛んだ誤検出を除去
    const idxs = [];
    for (let i = 0; i < n; i++) if (selected[i]) idxs.push(i);
    for (let k = 1; k < idxs.length - 1; k++) {
      const iPrev = idxs[k - 1], iCur = idxs[k], iNext = idxs[k + 1];
      if (anchorConstraint && iCur === anchorConstraint.idx) continue;
      const a = selected[iPrev], b = selected[iCur], c = selected[iNext];
      if (!a || !b || !c) continue;
      const span = Math.max(0.001, times[iNext] - times[iPrev]);
      const u = (times[iCur] - times[iPrev]) / span;
      const interpX = a.mx + (c.mx - a.mx) * u;
      const interpY = a.my + (c.my - a.my) * u;
      const dev = Math.hypot(b.mx - interpX, b.my - interpY);
      const neighborSpan = Math.hypot(c.mx - a.mx, c.my - a.my);
      if (dev > 0.095 && dev > neighborSpan * 0.95) {
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
    for (let y = topY; y <= Math.min(yMax, topY + headH * 2); y++) {
      const w = rowMass[y] + 1;
      sumW += w;
      sumX += rowCenter[y] * w;
    }
    const cx = sumW > 0 ? sumX / sumW : sw * defX;
    return {
      mx: clamp(cx / sw, 0.08, 0.92),
      my: clamp(cy / sh, 0.08, 0.56),
      mr: 0.11
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
        // 静止背景中央値モデル（壁・ポスター・ドア）との直接差分で前景の人物シルエットのみを抽出
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
    for (let y = topY; y <= Math.min(yMax, topY + headH * 2); y++) {
      const w = rowMass[y] + 0.1;
      sumW += w;
      sumX += rowCenter[y] * w;
    }
    const cx = sumW > 0 ? sumX / sumW : sw * 0.5;
    return {
      mx: clamp(cx / sw, 0.05, 0.95),
      my: clamp(cy / sh, 0.05, 0.72),
      mr: 0.115
    };
  }

  // ---------- 楕円ガウス重み＋背景減算付きマルチキュー外観トラッカー（背景壁への貼り付きゼロ） ----------
  function getEllipticalRadiiPx(sw, sh, mr) {
    const minDim = Math.min(sw, sh);
    const basePx = clamp((mr || 0.11) * minDim * 0.80, 4.5, minDim * 0.28);
    return {
      rx: Math.max(4.2, basePx * 0.92),
      ry: Math.max(5.0, basePx * 1.14)
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
      mr: mr || 0.11
    };
  }

  function updateEllipticalModelGuarded(model, buf, mx, my, cost, fgScore) {
    if (!model || !buf || cost > 23 || fgScore < 6) return;
    const cur = extractEllipticalModel(buf, mx, my, model.mr);
    if (!cur) return;
    // 初期アンカー特徴を84%保持しつつ16%だけ向き変化に順応（静止壁へのドリフトはfgScore閾値で完全遮断）
    let meanY = 0, meanRG = 0, meanBY = 0;
    for (let i = 0; i < DISC_PTS.length; i++) {
      const k = i * 3;
      const w = DISC_PTS[i].w;
      model.tpl[k] = model.baseTpl[k] * 0.84 + cur.tpl[k] * 0.16;
      model.tpl[k + 1] = model.baseTpl[k + 1] * 0.84 + cur.tpl[k + 1] * 0.16;
      model.tpl[k + 2] = model.baseTpl[k + 2] * 0.84 + cur.tpl[k + 2] * 0.16;
      meanY += model.tpl[k] * w;
      meanRG += model.tpl[k + 1] * w;
      meanBY += model.tpl[k + 2] * w;
    }
    model.meanY = meanY / model.sumW;
    model.meanRG = model.baseMeanRG * 0.84 + (meanRG / model.sumW) * 0.16;
    model.meanBY = model.baseMeanBY * 0.84 + (meanBY / model.sumW) * 0.16;
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
    const lumShift = clamp(candMeanY / subCnt - model.meanY, -42, 42);

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
    // 頭が90度回転・前屈しても保たれる髪＋肌の平均色モーメント一貫性
    const colorMomentCost = (Math.abs(candMeanRG - model.meanRG) + Math.abs(candMeanBY - model.meanBY) * 0.8) * 0.35;

    // 頭頂〜側頭部の外側背景ハローとの境界コントラスト（同色の胴体中央へずり下がるのを防止）
    let haloContrast = 0;
    for (let h = 0; h < HALO_PTS.length; h++) {
      const hp = HALO_PTS[h];
      const hx = clamp(Math.round(cx + hp.nx * rx), 0, sw - 1);
      const hy = clamp(Math.round(cy + hp.ny * ry), 0, sh - 1);
      const hIdx = (hy * sw + hx) * 3;
      haloContrast += Math.abs(feat[hIdx] - (model.meanY + lumShift)) + Math.abs(feat[hIdx + 1] - candMeanRG) * 0.7;
    }
    const contourBonus = Math.min(3.2, (haloContrast / HALO_PTS.length) * 0.065);

    const fgMean = bgFeat ? (fgSum / sumW) : 14;
    const fgBonus = bgFeat ? Math.min(4.8, fgMean * 0.14) : 0;
    const motionBonus = prevFeat ? Math.min(2.2, (motionSum / (m * 0.5)) * 0.11) : 0;

    const predDist = Math.hypot(cx - pcx, cy - pcy);
    const stepDist = Math.hypot(cx - prevCx, cy - prevCy);

    const cost = (sadW / sumW) + colorMomentCost + predDist * 0.18 + stepDist * 0.07 - fgBonus - motionBonus - contourBonus;
    return { cost, fgMean };
  }

  function matchElliptical(buf, prevBuf, roomModel, model, prevMx, prevMy, velMx, velMy) {
    const { sw, sh } = buf;
    const { rx, ry } = getEllipticalRadiiPx(sw, sh, model.mr);

    const predMx = clamp(prevMx + (velMx || 0) * 0.52, 0.03, 0.97);
    const predMy = clamp(prevMy + (velMy || 0) * 0.52, 0.03, 0.97);

    const pcx = clamp(Math.round(predMx * sw), Math.ceil(rx) + 1, sw - Math.ceil(rx) - 2);
    const pcy = clamp(Math.round(predMy * sh), Math.ceil(ry) + 1, sh - Math.ceil(ry) - 2);
    const prevCx = prevMx * sw;
    const prevCy = prevMy * sh;

    const searchRx = Math.max(16, Math.round(sw * 0.25));
    const searchRy = Math.max(20, Math.round(sh * 0.25));

    const padX = Math.min(Math.floor(sw * 0.35), Math.ceil(rx) + 1);
    const padY = Math.min(Math.floor(sh * 0.35), Math.ceil(ry) + 1);
    const x0 = Math.max(padX, pcx - searchRx);
    const x1 = Math.min(sw - padX - 1, pcx + searchRx);
    const y0 = Math.max(padY, pcy - searchRy);
    const y1 = Math.min(sh - padY - 1, pcy + searchRy);

    // 第1段階：2pxステップで広域25%探索窓を高速走査し、上位ピークを捕捉
    let bestCost = Infinity, bestX = pcx, bestY = pcy, bestFg = 10;
    for (let cy = y0; cy <= y1; cy += 2) {
      for (let cx = x0; cx <= x1; cx += 2) {
        const ev = evalEllipticalCandidate(buf, prevBuf, roomModel, model, cx, cy, rx, ry, pcx, pcy, prevCx, prevCy);
        if (ev.cost < bestCost) {
          bestCost = ev.cost;
          bestX = cx;
          bestY = cy;
          bestFg = ev.fgMean;
        }
      }
    }

    // 第2段階：最良点周辺の 5x5 近傍を 1px 単位で精密サブピクセル探索
    const fx0 = Math.max(padX, bestX - 2);
    const fx1 = Math.min(sw - padX - 1, bestX + 2);
    const fy0 = Math.max(padY, bestY - 2);
    const fy1 = Math.min(sh - padY - 1, bestY + 2);
    for (let cy = fy0; cy <= fy1; cy++) {
      for (let cx = fx0; cx <= fx1; cx++) {
        const ev = evalEllipticalCandidate(buf, prevBuf, roomModel, model, cx, cy, rx, ry, pcx, pcy, prevCx, prevCy);
        if (ev.cost < bestCost) {
          bestCost = ev.cost;
          bestX = cx;
          bestY = cy;
          bestFg = ev.fgMean;
        }
      }
    }

    return {
      mx: clamp(bestX / sw, 0.02, 0.98),
      my: clamp(bestY / sh, 0.02, 0.98),
      cost: bestCost,
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

    let velX = 0, velY = 0;
    for (let i = startIdx + dir; i >= 0 && i < n; i += dir) {
      const prev = out[i - dir];
      const curBuf = bufs[i];
      const prevBuf = bufs[i - dir];
      if (model && curBuf) {
        const m = matchElliptical(curBuf, prevBuf, roomModel, model, prev.mx, prev.my, velX, velY);
        velX = (m.mx - prev.mx) * 0.75 + velX * 0.25;
        velY = (m.my - prev.my) * 0.75 + velY * 0.25;
        out[i] = { t: times[i], mx: m.mx, my: m.my, mr: prev.mr };
        updateEllipticalModelGuarded(model, curBuf, m.mx, m.my, m.cost, m.fgMean);
      } else {
        out[i] = { t: times[i], mx: prev.mx, my: prev.my, mr: prev.mr };
      }
    }
    return out;
  }

  /**
   * 速度適応型スムージング（One-Euro風）：
   * - 立ち止まっている時は5点フィルタでAI特有の微細な1〜2px揺れをピタッと静止させる
   * - 歩行・前屈などの素早い移動中はピークを潰さず遅れゼロで頭部に密着追従する
   * - 半径 mr は広い窓で平滑化し、ぼかし円の不自然な脈動（拡大縮小チラつき）を防ぐ
   */
  function smoothKeyframesAdaptive(frames, pinnedIdx) {
    if (!frames || frames.length <= 2) return frames ? frames.map((f) => ({ ...f })) : [];
    const n = frames.length;
    const out = frames.map((f) => ({ ...f }));

    for (let i = 0; i < n; i++) {
      // 半径 mr の5点平滑化
      let rSum = 0, rW = 0;
      for (let d = -2; d <= 2; d++) {
        const j = clamp(i + d, 0, n - 1);
        const w = d === 0 ? 0.36 : (Math.abs(d) === 1 ? 0.22 : 0.10);
        rSum += frames[j].mr * w;
        rW += w;
      }
      out[i].mr = rSum / rW;

      if (i === 0 || i === n - 1 || i === pinnedIdx) continue;

      const prev = frames[i - 1], cur = frames[i], next = frames[i + 1];
      const speed = Math.hypot(next.mx - prev.mx, next.my - prev.my) * 0.5;

      if (speed < 0.009 && i >= 2 && i <= n - 3) {
        // 静止〜微動時：5点ガウス平滑でブレを完全吸収
        const p2 = frames[i - 2], n2 = frames[i + 2];
        out[i].mx = p2.mx * 0.11 + prev.mx * 0.22 + cur.mx * 0.34 + next.mx * 0.22 + n2.mx * 0.11;
        out[i].my = p2.my * 0.11 + prev.my * 0.22 + cur.my * 0.34 + next.my * 0.22 + n2.my * 0.11;
      } else if (speed < 0.032) {
        // 通常歩行速度：軽めの3点平滑
        out[i].mx = prev.mx * 0.16 + cur.mx * 0.68 + next.mx * 0.16;
        out[i].my = prev.my * 0.16 + cur.my * 0.68 + next.my * 0.16;
      } else {
        // 高速移動（急な前屈・振り向き）：ピーク遅れゼロ
        out[i].mx = prev.mx * 0.06 + cur.mx * 0.88 + next.mx * 0.06;
        out[i].my = prev.my * 0.06 + cur.my * 0.88 + next.my * 0.06;
      }
    }

    if (typeof pinnedIdx === "number" && pinnedIdx >= 0 && pinnedIdx < n) {
      out[pinnedIdx] = { ...frames[pinnedIdx] };
    }
    return out;
  }

  // ---------- 直列デコーダキュー＋確実なフレームデコード保証付き一時 <video> ----------
  let scanQueue = Promise.resolve();

  function enqueueVideoScan(taskFn) {
    const job = scanQueue.then(taskFn);
    scanQueue = job.catch(() => null);
    return job;
  }

  function waitDecodedFrameAfterSeek(v) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(tId);
        resolve();
      };
      const tId = setTimeout(finish, 26);
      if (typeof v.requestVideoFrameCallback === "function") {
        v.requestVideoFrameCallback(finish);
      }
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(() => {
          if (v.readyState >= 2 && !v.seeking) finish();
        });
      }
    });
  }

  function seekOnce(v, t, timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        v.removeEventListener("seeked", onSeeked);
        resolve();
      };
      const onSeeked = () => {
        waitDecodedFrameAfterSeek(v).then(finish);
      };
      const timer = setTimeout(finish, timeoutMs || 340);
      v.addEventListener("seeked", onSeeked);
      try {
        const target = Math.max(0, t || 0);
        if (Math.abs(v.currentTime - target) < 0.005 && !v.seeking && v.readyState >= 2) {
          finish();
          return;
        }
        v.currentTime = target;
      } catch (e) {
        finish();
      }
    });
  }

  async function primeTempVideo(v) {
    try {
      if (!isFinite(v.duration) || v.duration <= 0) {
        await seekOnce(v, 1e7, 450);
        await seekOnce(v, 0, 280);
      }
      const p = v.play();
      if (p && typeof p.then === "function") {
        await Promise.race([p.catch(() => {}), new Promise((r) => setTimeout(r, 120))]);
      }
      await new Promise((r) => setTimeout(r, 30));
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
      }, 50000);

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

  /**
   * 2パス（粗→密）スキャン順序：
   * - Pass 1（約14点・昇順）：約1秒で動画の0秒〜終端まで全域のAI骨格軌道を即座に確定しプレビューへ反映
   * - Pass 2（残り全点・focusTime以降を優先して昇順）：トリミング後の再生中区間から最優先で10fps高密度化する
   */
  function buildTwoPassOrder(times, focusTime) {
    const n = times.length;
    if (n <= 16) {
      return { order: times.map((_, i) => i), coarseEndStep: n - 1 };
    }
    const used = new Uint8Array(n);
    const order = [];
    const coarseCount = Math.min(14, n);
    for (let k = 0; k < coarseCount; k++) {
      const idx = Math.min(n - 1, Math.round((k * (n - 1)) / Math.max(1, coarseCount - 1)));
      if (!used[idx]) {
        used[idx] = 1;
        order.push(idx);
      }
    }
    // ユーザー指定時刻（focusTime / anchor.t）に最も近い点もPass 1に必ず含める
    if (typeof focusTime === "number" && focusTime > 0) {
      let bestI = 0, minD = Infinity;
      for (let i = 0; i < n; i++) {
        const d = Math.abs(times[i] - focusTime);
        if (d < minD) { minD = d; bestI = i; }
      }
      if (!used[bestI]) {
        used[bestI] = 1;
        order.push(bestI);
        order.sort((a, b) => a - b);
      }
    }
    const coarseEndStep = order.length - 1;

    let focusIdx = 0;
    if (typeof focusTime === "number" && focusTime > 0) {
      for (let i = 0; i < n; i++) {
        if (times[i] >= focusTime - 0.02) { focusIdx = i; break; }
      }
    }
    for (let i = focusIdx; i < n; i++) {
      if (!used[i]) { used[i] = 1; order.push(i); }
    }
    for (let i = 0; i < focusIdx; i++) {
      if (!used[i]) { used[i] = 1; order.push(i); }
    }
    return { order, coarseEndStep };
  }

  // ---------- 静止画の顔・頭部検出＋フォールバック ----------
  async function trackImage(imgEl, isCancelled, opts) {
    const visibleBox = opts && opts.visibleBox ? opts.visibleBox : null;
    if (!imgEl || !imgEl.naturalWidth || !imgEl.naturalHeight) {
      return { status: "fallback", mx: 0.5, my: 0.22, mr: 0.11, keyframes: [] };
    }
    const detectors = await getDetectors();
    if (isCancelled && isCancelled()) return null;
    const cands = detectCandidatesOnSource(detectors, imgEl, imgEl.naturalWidth, imgEl.naturalHeight, visibleBox);
    if (cands.length > 0) {
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
   * 収集済みフレーム（時間順ソート）から大域ビタビ軌道＋双方向楕円外観補間で全区間キーフレームを構築する
   */
  function assembleTrajectoryFromSlots(slots, visibleBox, anchor) {
    const collected = [];
    for (let i = 0; i < slots.length; i++) {
      if (slots[i]) collected.push(slots[i]);
    }
    if (!collected.length) return null;
    collected.sort((a, b) => a.t - b.t);

    // 同一時刻の重複スロットを除去
    const uniq = [collected[0]];
    for (let i = 1; i < collected.length; i++) {
      if (collected[i].t > uniq[uniq.length - 1].t + 0.015) {
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
      const baseGate = Math.max(0.16, anchor.mr * 1.65);
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
          if (dt <= 0.35 && dt < bestDt && hasNearCand(i, baseGate + 0.04)) {
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
      ? selectConsistentTrack(times, candsPerFrame, roomModel, anchorConstraint)
      : new Array(n).fill(null);

    // アンカー指定時は、マッチしたAI骨格中心とユーザー指定座標の相対オフセットを全AIヒットへ反映
    let relDx = 0, relDy = 0, relScale = 1;
    if (anchor && matchAnchorIdx >= 0 && selectedHits[matchAnchorIdx]) {
      const ah = selectedHits[matchAnchorIdx];
      relDx = clamp(anchor.mx - ah.mx, -0.14, 0.14);
      relDy = clamp(anchor.my - ah.my, -0.14, 0.14);
      relScale = clamp(anchor.mr / Math.max(0.04, ah.mr), 0.65, 1.55);
    }

    const hitIndices = [];
    for (let i = 0; i < n; i++) {
      if (selectedHits[i]) hitIndices.push(i);
    }

    if (hitIndices.length > 0) {
      const frames = new Array(n);
      for (let h = 0; h < hitIndices.length; h++) {
        const idx = hitIndices[h];
        const hit = selectedHits[idx];
        frames[idx] = {
          t: times[idx],
          mx: clamp(hit.mx + relDx, 0.02, 0.98),
          my: clamp(hit.my + relDy, 0.02, 0.98),
          mr: clamp(hit.mr * relScale, 0.045, 0.36)
        };
      }
      if (anchor && anchorIdx >= 0) {
        frames[anchorIdx] = { t: times[anchorIdx], mx: anchor.mx, my: anchor.my, mr: anchor.mr };
        if (!hitIndices.includes(anchorIdx)) {
          hitIndices.push(anchorIdx);
          hitIndices.sort((a, b) => a - b);
        }
      }

      // 1. 最初のAIヒットより前の区間を後方楕円外観追跡
      const firstIdx = hitIndices[0];
      if (firstIdx > 0) {
        const backSeq = trackSequenceElliptical(bufs, times, roomModel, firstIdx, -1, frames[firstIdx]);
        for (let i = 0; i < firstIdx; i++) frames[i] = backSeq[i];
      }

      // 2. AIヒット間の未検出ギャップを前方・後方双方向の楕円外観追跡ブレンドで段差ゼロ補間
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
          // 滑らかなコサインブレンド重み s = 3u^2 - 2u^3
          const s = u * u * (3 - 2 * u);
          frames[i0 + k] = {
            t: subTimes[k],
            mx: fwd[k].mx * (1 - s) + bwd[k].mx * s,
            my: fwd[k].my * (1 - s) + bwd[k].my * s,
            mr: frames[i0].mr * (1 - s) + frames[i1].mr * s
          };
        }
      }

      // 3. 最後のAIヒットより後の区間を前方楕円外観追跡
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

    // AI未検出時（またはユーザーが非AI対象の位置を指定した場合）：楕円ガウス重み＋背景減算外観トラッカーで双方向追従
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

  async function runTwoPassVideoTrack(url, knownDuration, isCancelled, opts, anchor) {
    const onProgress = opts && typeof opts.onProgress === "function" ? opts.onProgress : null;
    const visibleBox = opts && opts.visibleBox ? opts.visibleBox : null;
    const focusTime = anchor ? anchor.t : (opts && typeof opts.focusTime === "number" ? opts.focusTime : 0);

    const detectors = await getDetectors();
    if (isCancelled && isCancelled()) return null;

    return await withTempVideo(url, knownDuration, async (v, dur, setPartialGetter) => {
      if (!dur || dur <= 0) return null;
      const vw = v.videoWidth || 360, vh = v.videoHeight || 640;
      const { times, step } = buildScanTimes(dur);
      const { order, coarseEndStep } = buildTwoPassOrder(times, focusTime);
      const slots = new Array(times.length).fill(null);
      let realMaxT = Infinity;

      const buildCurrent = () => assembleTrajectoryFromSlots(slots, visibleBox, anchor);
      setPartialGetter(buildCurrent);

      for (let sIdx = 0; sIdx < order.length; sIdx++) {
        if (isCancelled && isCancelled()) return null;
        const slotIdx = order[sIdx];
        const targetT = times[slotIdx];
        if (targetT > realMaxT + 0.02) continue;

        await seekOnce(v, targetT, 340);
        if (targetT > 0.45 && (v.ended || v.currentTime < targetT - Math.max(0.25, step * 0.85))) {
          realMaxT = Math.max(0.2, v.currentTime);
          continue;
        }
        const actualT = Math.max(0, Math.round(v.currentTime * 100) / 100);
        const cands = detectors ? detectCandidatesOnSource(detectors, v, vw, vh, visibleBox) : [];
        const buf = grabScanBuffer(v, vw, vh);
        slots[slotIdx] = { t: actualT, cands, buf };

        const shouldEmit =
          onProgress &&
          (sIdx === coarseEndStep ||
           (sIdx > coarseEndStep && (sIdx - coarseEndStep) % 8 === 0) ||
           sIdx === order.length - 1);

        if (shouldEmit) {
          const partial = buildCurrent();
          if (partial) {
            onProgress({
              ...partial,
              progress: Math.min(0.99, (sIdx + 1) / order.length)
            });
          }
        }
        await yieldStep();
      }

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
      mr: clamp(Number(anchor && anchor.mr) || 0.11, 0.04, 0.36)
    };
    return await runTwoPassVideoTrack(url, knownDuration, isCancelled, opts, cleanAnchor);
  }

  // ---------- 単調3次エルミート補間（Fritsch-Carlson）による60fps滑らか追従サンプリング ----------
  function interpMonotoneCubic(kf, lo, hi, t, prop) {
    const a = kf[lo], b = kf[hi];
    const h = Math.max(0.0001, b.t - a.t);
    const u = clamp((t - a.t) / h, 0, 1);
    const delta = (b[prop] - a[prop]) / h;
    if (Math.abs(delta) < 1e-7) return a[prop];

    const pPrev = lo > 0 ? kf[lo - 1] : null;
    const pNext = hi + 1 < kf.length ? kf[hi + 1] : null;

    let m0 = delta;
    if (pPrev) {
      const dPrev = (a[prop] - pPrev[prop]) / Math.max(0.0001, a.t - pPrev.t);
      m0 = dPrev * delta <= 0 ? 0 : (dPrev + delta) * 0.5;
    }
    let m1 = delta;
    if (pNext) {
      const dNext = (pNext[prop] - b[prop]) / Math.max(0.0001, pNext.t - b.t);
      m1 = delta * dNext <= 0 ? 0 : (delta + dNext) * 0.5;
    }

    // オーバーシュート防止クランプ（Fritsch-Carlson単調性条件）
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
        mx = interpMonotoneCubic(kf, lo, hi, t, "mx");
        my = interpMonotoneCubic(kf, lo, hi, t, "my");
        mr = interpMonotoneCubic(kf, lo, hi, t, "mr");
      }
    }
    return {
      mx: clamp(mx + (blur.offsetX || 0), 0.02, 0.98),
      my: clamp(my + (blur.offsetY || 0), 0.02, 0.98),
      mr: clamp(mr, 0.04, 0.36)
    };
  }

  // ---------- 高遮蔽・滑らかガウシアン風楕円ぼかし描画（輪郭からの目・鼻はみ出しゼロ） ----------
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
    sampleAtTime,
    drawSmoothOvalBlur,
    drawPreviewRing
  };
})();
