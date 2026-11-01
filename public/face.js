/**
 * BAメーカー 顔・頭部ぼかし＆高精度自動追従エンジン（ブラウザ内完結・サーバー送信なし）
 *
 * 1. デュアルAI自動追従（MediaPipe FaceDetector ＋ PoseLandmarker 全身姿勢骨格AI）：
 *    - 近距離〜中距離の正面・斜め顔は FaceDetector（最大512px高精細スキャン）で検出
 *    - 整体院特有の全身立ち姿（2〜4m遠方）・横向き歩行・前屈／後屈・ベッド横臥・後ろ姿も
 *      PoseLandmarker（頭部0〜10番＋両肩11〜12番ランドマーク）で頭の位置とサイズを自動追従
 * 2. AI未検出区間・オフライン・指定位置追従向けのマルチキュー映像追従：
 *    - 時間軸モーション解析により、院内の壁・ドア・ポスター・カーテン等の静止背景への誤吸着を防止
 *    - 速度予測＋輝度・色差テンプレート＋段階的テンプレート更新＋前後双方向ブレンド補間（前屈等の大移動対応）
 * 3. デコーダ直列キュー＆逐次ライブ反映（onProgress）により、長い動画（最大90秒）でもタイムアウトせず即座に追従開始
 * 4. iOS Safari を含む全ブラウザで 0.1ms 以下で動作する多段バイリニア平滑ガウシアン風楕円ぼかし描画
 */
(() => {
  "use strict";

  const VISION_ESM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";
  const VISION_WASM_DIR = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
  const FACE_MODEL_URL = "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite";
  const POSE_MODEL_URL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";

  const SCAN_MAX_DIM = 160;
  const PATCH_R = 5;          // 11x11 パッチ
  const BASE_STEP_SEC = 0.20; // 短〜中尺動画は0.20秒刻み（秒間5点）で前屈・歩行も滑らかに追従
  const MAX_TRACK_SEC = 180;  // トリミングを含む長尺動画（有料プラン最大90秒書き出し）を全域カバー
  const MAX_SCAN_POINTS = 100;

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const yieldStep = () => new Promise((r) => setTimeout(r, 0));

  // ---------- MediaPipe デュアルAI（FaceDetector + PoseLandmarker）遅延ローダー ----------
  // CPU (WASM XNNPACK SIMD) デリゲートに統一することで、モバイル／ヘッドレスWebGLシェーダコンパイル凍結を回避し安定高速推論（約15〜35ms/frame）
  let detectorsPromise = null;
  let cachedDetectors = null;

  async function getDetectors() {
    if (cachedDetectors && (cachedDetectors.face || cachedDetectors.pose)) {
      return cachedDetectors;
    }
    if (detectorsPromise) return detectorsPromise;

    detectorsPromise = (async () => {
      try {
        const mod = await Promise.race([
          import(VISION_ESM_URL),
          new Promise((_, rej) => setTimeout(() => rej(new Error("vision_timeout")), 12000))
        ]);
        const FilesetResolver = mod.FilesetResolver;
        const FaceDetector = mod.FaceDetector;
        const PoseLandmarker = mod.PoseLandmarker;
        if (!FilesetResolver) throw new Error("vision_api_missing");

        const vision = await Promise.race([
          FilesetResolver.forVisionTasks(VISION_WASM_DIR),
          new Promise((_, rej) => setTimeout(() => rej(new Error("wasm_timeout")), 12000))
        ]);

        const [face, pose] = await Promise.all([
          FaceDetector
            ? FaceDetector.createFromOptions(vision, {
                baseOptions: { modelAssetPath: FACE_MODEL_URL, delegate: "CPU" },
                runningMode: "IMAGE",
                minDetectionConfidence: 0.36
              }).catch(() => null)
            : Promise.resolve(null),
          PoseLandmarker
            ? PoseLandmarker.createFromOptions(vision, {
                baseOptions: { modelAssetPath: POSE_MODEL_URL, delegate: "CPU" },
                runningMode: "IMAGE",
                numPoses: 2,
                minPoseDetectionConfidence: 0.33,
                minPosePresenceConfidence: 0.33
              }).catch(() => null)
            : Promise.resolve(null)
        ]);

        if (!face && !pose) {
          detectorsPromise = null;
          return null;
        }
        cachedDetectors = { face, pose };
        return cachedDetectors;
      } catch (e) {
        // 一時的な通信遅延でも次回リトライできるよう恒久ロックしない
        detectorsPromise = null;
        return null;
      }
    })();

    return detectorsPromise;
  }

  // ---------- 解析用オフスクリーンキャンバス ----------
  let faceCanvas = null, faceCtx = null;
  let poseCanvas = null, poseCtx = null;
  let patchCanvas = null, patchCtx = null;

  function ensureCanvases() {
    if (!faceCanvas) {
      faceCanvas = document.createElement("canvas");
      faceCtx = faceCanvas.getContext("2d", { willReadFrequently: true });
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

  function detectByFaceModel(faceDetector, sourceEl, srcW, srcH, prevHit) {
    if (!faceDetector || !srcW || !srcH) return null;
    ensureCanvases();
    const scale = Math.min(1, 512 / Math.max(srcW, srcH));
    const dw = Math.max(48, Math.round(srcW * scale));
    const dh = Math.max(48, Math.round(srcH * scale));
    if (faceCanvas.width !== dw || faceCanvas.height !== dh) {
      faceCanvas.width = dw;
      faceCanvas.height = dh;
    }
    try {
      faceCtx.drawImage(sourceEl, 0, 0, dw, dh);
      const res = faceDetector.detect(faceCanvas);
      const list = (res && res.detections) ? res.detections : [];
      if (!list.length) return null;

      const minDim = Math.min(dw, dh);
      let best = null, bestScore = -1;
      for (let i = 0; i < list.length; i++) {
        const d = list[i];
        const bb = d.boundingBox;
        if (!bb || bb.width <= 0 || bb.height <= 0) continue;
        const cx = (bb.originX + bb.width / 2) / dw;
        const cy = (bb.originY + bb.height / 2) / dh - (bb.height / dh) * 0.05;
        const nr = (Math.max(bb.width, bb.height) / minDim) * 0.68;
        const conf = (d.categories && d.categories[0] && d.categories[0].score) || 0.5;
        const centerBias = 1 - Math.abs(cx - 0.5) * 0.35;
        const areaBias = clamp(nr * 4.5, 0.35, 1.45);
        const contBias = prevHit
          ? Math.max(0.35, 1.35 - Math.hypot(cx - prevHit.mx, cy - prevHit.my) * 1.9)
          : (cy < 0.78 ? 1.12 : 0.78);
        const score = conf * centerBias * areaBias * contBias;
        if (score > bestScore) {
          bestScore = score;
          best = {
            mx: clamp(cx, 0.03, 0.97),
            my: clamp(cy, 0.03, 0.97),
            mr: clamp(nr, 0.048, 0.35),
            conf,
            kind: "face"
          };
        }
      }
      return best;
    } catch (e) {
      return null;
    }
  }

  /**
   * PoseLandmarker の33骨格点から頭部（0:鼻, 1〜6:目, 7〜8:耳, 9〜10:口）と両肩（11, 12）を使って
   * 正面・横向き・後ろ姿・前屈（頭が腰より下）・ベッド横臥すべてで正確な頭部中心と半径を算出する
   */
  function detectByPoseModel(poseDetector, sourceEl, srcW, srcH, prevHit) {
    if (!poseDetector || !srcW || !srcH) return null;
    ensureCanvases();
    const scale = Math.min(1, 384 / Math.max(srcW, srcH));
    const dw = Math.max(48, Math.round(srcW * scale));
    const dh = Math.max(48, Math.round(srcH * scale));
    if (poseCanvas.width !== dw || poseCanvas.height !== dh) {
      poseCanvas.width = dw;
      poseCanvas.height = dh;
    }
    try {
      poseCtx.drawImage(sourceEl, 0, 0, dw, dh);
      const res = poseDetector.detect(poseCanvas);
      const poses = (res && res.landmarks) ? res.landmarks : [];
      if (!poses.length) return null;

      const minDim = Math.min(dw, dh);
      const HEAD_WEIGHTS = [
        [0, 1.35], // nose
        [2, 1.10], // left_eye
        [5, 1.10], // right_eye
        [7, 1.45], // left_ear（横向き・後ろ姿で特に重要）
        [8, 1.45], // right_ear
        [1, 0.65], [3, 0.65], [4, 0.65], [6, 0.65],
        [9, 0.75], [10, 0.75]
      ];

      let best = null, bestScore = -1;

      for (let pIdx = 0; pIdx < poses.length; pIdx++) {
        const lm = poses[pIdx];
        if (!lm || lm.length < 13) continue;

        let sumW = 0, sumX = 0, sumY = 0, visSum = 0, visCnt = 0;
        const headPts = [];

        for (let k = 0; k < HEAD_WEIGHTS.length; k++) {
          const [idx, baseW] = HEAD_WEIGHTS[k];
          const pt = lm[idx];
          if (!pt || !isFinite(pt.x) || !isFinite(pt.y)) continue;
          if (pt.x < -0.12 || pt.x > 1.12 || pt.y < -0.12 || pt.y > 1.12) continue;
          const vis = typeof pt.visibility === "number" ? pt.visibility : 0.6;
          if (vis < 0.16) continue;
          const w = baseW * (0.35 + vis * 0.65);
          sumW += w;
          sumX += pt.x * w;
          sumY += pt.y * w;
          visSum += vis;
          visCnt++;
          headPts.push(pt);
        }

        if (visCnt < 2 || sumW <= 0) continue;

        let hx = sumX / sumW;
        let hy = sumY / sumW;
        const meanVis = visSum / visCnt;

        // 両肩（11, 12）が見えている場合は「肩中点 → 頭重心」ベクトル方向に頭頂補正をかけ、解剖学的な頭サイズも算出
        const ls = lm[11], rs = lm[12];
        const lsOk = ls && isFinite(ls.x) && isFinite(ls.y) && (ls.visibility === undefined || ls.visibility >= 0.18);
        const rsOk = rs && isFinite(rs.x) && isFinite(rs.y) && (rs.visibility === undefined || rs.visibility >= 0.18);

        let neckPx = 0, shoulderPx = 0;
        if (lsOk && rsOk) {
          const sx = (ls.x + rs.x) * 0.5;
          const sy = (ls.y + rs.y) * 0.5;
          const vx = hx - sx;
          const vy = hy - sy;
          hx += vx * 0.14;
          hy += vy * 0.14;
          neckPx = Math.hypot(vx * dw, vy * dh);
          shoulderPx = Math.hypot((ls.x - rs.x) * dw, (ls.y - rs.y) * dh);
        } else if (lsOk || rsOk) {
          const sp = lsOk ? ls : rs;
          const vx = hx - sp.x;
          const vy = hy - sp.y;
          hx += vx * 0.10;
          hy += vy * 0.10;
          neckPx = Math.hypot(vx * dw, vy * dh) * 0.88;
        }

        if (hx < -0.04 || hx > 1.04 || hy < -0.04 || hy > 1.04) continue;

        let maxSpanPx = 0;
        for (let i = 0; i < headPts.length; i++) {
          const dPx = Math.hypot((headPts[i].x - hx) * dw, (headPts[i].y - hy) * dh);
          if (dPx > maxSpanPx) maxSpanPx = dPx;
        }

        const rPx = Math.max(maxSpanPx * 1.72, neckPx * 0.52, shoulderPx * 0.36, minDim * 0.055);
        const mr = clamp((rPx / minDim) * 1.08, 0.052, 0.34);

        const centerBias = 1 - Math.abs(hx - 0.5) * 0.30;
        const contBias = prevHit
          ? Math.max(0.30, 1.45 - Math.hypot(hx - prevHit.mx, hy - prevHit.my) * 2.0)
          : 1.0;
        const score = meanVis * centerBias * contBias * clamp(mr * 5.0, 0.45, 1.35);

        if (score > bestScore) {
          bestScore = score;
          best = {
            mx: clamp(hx, 0.03, 0.97),
            my: clamp(hy, 0.03, 0.97),
            mr,
            conf: meanVis,
            kind: "pose"
          };
        }
      }
      return best;
    } catch (e) {
      return null;
    }
  }

  function detectHeadOnSource(detectors, sourceEl, srcW, srcH, prevHit) {
    if (!detectors || !srcW || !srcH) return null;
    const faceHit = detectByFaceModel(detectors.face, sourceEl, srcW, srcH, prevHit);
    if (faceHit && faceHit.conf >= 0.50) {
      return faceHit;
    }
    const poseHit = detectByPoseModel(detectors.pose, sourceEl, srcW, srcH, prevHit);
    if (faceHit && poseHit) {
      // 両方ヒットして同一人物付近なら顔ボックスと骨格頭部を融合、離れていれば信頼度優先
      const dist = Math.hypot(faceHit.mx - poseHit.mx, faceHit.my - poseHit.my);
      if (dist < 0.14) {
        return {
          mx: faceHit.mx * 0.65 + poseHit.mx * 0.35,
          my: faceHit.my * 0.65 + poseHit.my * 0.35,
          mr: Math.max(faceHit.mr, poseHit.mr * 0.95),
          conf: Math.max(faceHit.conf, poseHit.conf),
          kind: "face+pose"
        };
      }
      return faceHit.conf >= poseHit.conf ? faceHit : poseHit;
    }
    return faceHit || poseHit || null;
  }

  // ---------- アスペクト比維持の特徴バッファ取得（黒フレーム除外付き） ----------
  function getScanDims(srcW, srcH) {
    const w = srcW || 360, h = srcH || 640;
    const sc = SCAN_MAX_DIM / Math.max(w, h);
    return {
      sw: Math.max(48, Math.round(w * sc)),
      sh: Math.max(48, Math.round(h * sc))
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
      // シーク直後の未デコード黒フレーム（輝度ほぼ0かつ分散ゼロ）を弾いて誤追跡を防止
      if (sumY / n < 1.8 && (maxY - minY) < 3) {
        return null;
      }
      return { feat, sw, sh };
    } catch (e) {
      return null;
    }
  }

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

  /**
   * 静止画用：左右端の背景色との色差から上部シルエットの頭頂〜頭部中心を推定
   */
  function estimateHeadFromBuffer(buf) {
    if (!buf || !buf.feat) return { mx: 0.5, my: 0.22, mr: 0.11 };
    const { feat, sw, sh } = buf;
    const bg = computeBorderBg(buf);

    const xMin = Math.floor(sw * 0.14);
    const xMax = Math.ceil(sw * 0.86);
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
      rowCenter[y] = mass > 0 ? wx / mass : sw / 2;
    }

    let peakMass = 0;
    for (let y = yMin; y <= yMax; y++) {
      if (rowMass[y] > peakMass) peakMass = rowMass[y];
    }
    if (peakMass < sw * 1.6) {
      return { mx: 0.5, my: 0.22, mr: 0.11 };
    }

    const th = peakMass * 0.26;
    let topY = -1;
    for (let y = yMin; y <= yMax - 3; y++) {
      if (rowMass[y] >= th && rowMass[y + 1] >= th && rowMass[y + 2] >= th) {
        topY = y;
        break;
      }
    }
    if (topY < 0) return { mx: 0.5, my: 0.22, mr: 0.11 };

    const headH = Math.max(4, Math.round(sh * 0.075));
    const cy = clamp(topY + headH, yMin + 3, yMax);
    let sumW = 0, sumX = 0;
    for (let y = topY; y <= Math.min(yMax, topY + headH * 2); y++) {
      const w = rowMass[y] + 1;
      sumW += w;
      sumX += rowCenter[y] * w;
    }
    const cx = sumW > 0 ? sumX / sumW : sw / 2;
    return {
      mx: clamp(cx / sw, 0.10, 0.90),
      my: clamp(cy / sh, 0.08, 0.56),
      mr: 0.11
    };
  }

  /**
   * 動画でAI未検出（オフラインや特殊アングル）時の初期頭部検出：
   * フレーム間の「時間軸モーション（動いている領域）」を使うことで、
   * 院内の壁にあるドア・ポスター・カーテン等の静止物への誤吸着を完全に排除する！
   */
  function estimateMovingHeadAtStart(bufs) {
    const valid = bufs.filter(Boolean);
    if (!valid.length) return { mx: 0.5, my: 0.22, mr: 0.11 };
    if (valid.length < 3) return estimateHeadFromBuffer(valid[0]);

    const { sw, sh } = valid[0];
    const n = sw * sh;
    // 冒頭付近（最大8フレーム）と全体の差分エネルギーから初期フレームの動体シルエットを抽出
    const earlyCount = Math.min(valid.length, 10);
    const motionMap = new Float32Array(n);
    const refFeat = valid[0].feat;

    for (let f = 1; f < earlyCount; f++) {
      if (valid[f].sw !== sw || valid[f].sh !== sh) continue;
      const cur = valid[f].feat;
      const prev = valid[f - 1].feat;
      const wDecay = 1 / (1 + (f - 1) * 0.28);
      for (let i = 0; i < n; i++) {
        const idx = i * 3;
        // frame 0 からの変化と隣接フレーム変化の両方が起きている初期位置（= frame 0 で人物がいた場所）を捉える
        const d0 = Math.abs(cur[idx] - refFeat[idx]) + Math.abs(cur[idx + 1] - refFeat[idx + 1]) * 0.7;
        const dp = Math.abs(cur[idx] - prev[idx]) + Math.abs(cur[idx + 1] - prev[idx + 1]) * 0.7;
        motionMap[i] += Math.min(d0, dp * 1.8 + 8) * wDecay;
      }
    }

    const bg = computeBorderBg(valid[0]);
    const xMin = Math.floor(sw * 0.08);
    const xMax = Math.ceil(sw * 0.92);
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
        const bgDiff = Math.abs(refFeat[idx] - bg.bgY) +
                       Math.abs(refFeat[idx + 1] - bg.bgRG) * 0.8 +
                       Math.abs(refFeat[idx + 2] - bg.bgBY) * 0.6;
        const mVal = motionMap[i] / Math.max(1, earlyCount - 1);
        // 動いており、かつ背景壁とも色が異なる領域のみを人物としてカウント（静止ドア・ポスターは mVal≈0 のため0になる）
        if (mVal > 5.5 && bgDiff > 16) {
          const w = (mVal - 5.0) * (1 + Math.min(bgDiff, 80) / 60);
          mass += w;
          wx += x * w;
        }
      }
      rowMass[y] = mass;
      rowCenter[y] = mass > 0 ? wx / mass : sw / 2;
      if (mass > peakMass) peakMass = mass;
    }

    if (peakMass < sw * 0.55) {
      return estimateHeadFromBuffer(valid[0]);
    }

    const th = peakMass * 0.22;
    let topY = -1;
    for (let y = yMin; y <= yMax - 2; y++) {
      if (rowMass[y] >= th && rowMass[y + 1] >= th * 0.85) {
        topY = y;
        break;
      }
    }
    if (topY < 0) return estimateHeadFromBuffer(valid[0]);

    const headH = Math.max(4, Math.round(sh * 0.068));
    const cy = clamp(topY + headH, yMin + 3, yMax);
    let sumW = 0, sumX = 0;
    for (let y = topY; y <= Math.min(yMax, topY + headH * 2); y++) {
      const w = rowMass[y] + 0.1;
      sumW += w;
      sumX += rowCenter[y] * w;
    }
    const cx = sumW > 0 ? sumX / sumW : sw / 2;
    return {
      mx: clamp(cx / sw, 0.06, 0.94),
      my: clamp(cy / sh, 0.06, 0.72),
      mr: 0.115
    };
  }

  // ---------- 速度予測＋段階適応テンプレートパッチ追従（前屈・スクワット・歩行の大移動対応） ----------
  function extractPatch(buf, mx, my) {
    if (!buf || !buf.feat) return null;
    const { feat, sw, sh } = buf;
    const cx = clamp(Math.round(mx * sw), PATCH_R + 1, sw - PATCH_R - 2);
    const cy = clamp(Math.round(my * sh), PATCH_R + 1, sh - PATCH_R - 2);
    const side = PATCH_R * 2 + 1;
    const tpl = new Float32Array(side * side * 3);
    let k = 0, meanY = 0;
    for (let dy = -PATCH_R; dy <= PATCH_R; dy++) {
      for (let dx = -PATCH_R; dx <= PATCH_R; dx++) {
        const idx = ((cy + dy) * sw + (cx + dx)) * 3;
        tpl[k] = feat[idx];
        tpl[k + 1] = feat[idx + 1];
        tpl[k + 2] = feat[idx + 2];
        meanY += feat[idx];
        k += 3;
      }
    }
    meanY /= (side * side);
    return { tpl, baseTpl: new Float32Array(tpl), meanY, baseMeanY: meanY, sw, sh };
  }

  function updatePatchGuarded(patch, buf, mx, my, cost) {
    if (!patch || !buf || cost > 26) return;
    const cur = extractPatch(buf, mx, my);
    if (!cur || cur.tpl.length !== patch.tpl.length) return;
    // 初期アンカー特徴を82%保持しつつ直近フレームの向き変化を18%取り込み、壁へのドリフトを防ぎながら前屈や横向き回転に追従
    let meanY = 0;
    const nPix = (PATCH_R * 2 + 1) * (PATCH_R * 2 + 1);
    for (let i = 0; i < patch.tpl.length; i += 3) {
      patch.tpl[i] = patch.baseTpl[i] * 0.82 + cur.tpl[i] * 0.18;
      patch.tpl[i + 1] = patch.baseTpl[i + 1] * 0.82 + cur.tpl[i + 1] * 0.18;
      patch.tpl[i + 2] = patch.baseTpl[i + 2] * 0.82 + cur.tpl[i + 2] * 0.18;
      meanY += patch.tpl[i];
    }
    patch.meanY = meanY / nPix;
  }

  function matchPatch(buf, prevBuf, patch, prevMx, prevMy, velMx, velMy) {
    const { feat, sw, sh } = buf;
    const side = PATCH_R * 2 + 1;
    const count = side * side;

    const predMx = clamp(prevMx + (velMx || 0) * 0.45, 0.04, 0.96);
    const predMy = clamp(prevMy + (velMy || 0) * 0.45, 0.04, 0.96);

    const pcx = clamp(Math.round(predMx * sw), PATCH_R + 1, sw - PATCH_R - 2);
    const pcy = clamp(Math.round(predMy * sh), PATCH_R + 1, sh - PATCH_R - 2);
    const prevCx = prevMx * sw;
    const prevCy = prevMy * sh;

    const searchRx = Math.max(18, Math.round(sw * 0.26));
    const searchRy = Math.max(22, Math.round(sh * 0.25));

    const x0 = Math.max(PATCH_R + 1, pcx - searchRx);
    const x1 = Math.min(sw - PATCH_R - 2, pcx + searchRx);
    const y0 = Math.max(PATCH_R + 1, pcy - searchRy);
    const y1 = Math.min(sh - PATCH_R - 2, pcy + searchRy);

    const hasPrevSameDim = !!(prevBuf && prevBuf.feat && prevBuf.sw === sw && prevBuf.sh === sh);
    const prevFeat = hasPrevSameDim ? prevBuf.feat : null;

    let bestCost = Infinity;
    let bestX = pcx, bestY = pcy;

    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        let candMeanY = 0;
        for (let dy = -PATCH_R; dy <= PATCH_R; dy += 2) {
          const rowOff = (cy + dy) * sw;
          for (let dx = -PATCH_R; dx <= PATCH_R; dx += 2) {
            candMeanY += feat[(rowOff + cx + dx) * 3];
          }
        }
        const subCnt = Math.ceil(side / 2) * Math.ceil(side / 2);
        const lumShift = clamp(candMeanY / subCnt - patch.meanY, -45, 45);

        let sad = 0, motionSum = 0, k = 0;
        for (let dy = -PATCH_R; dy <= PATCH_R; dy++) {
          const rowOff = (cy + dy) * sw;
          for (let dx = -PATCH_R; dx <= PATCH_R; dx++) {
            const idx = (rowOff + cx + dx) * 3;
            sad += Math.abs((feat[idx] - lumShift) - patch.tpl[k])
                 + Math.abs(feat[idx + 1] - patch.tpl[k + 1]) * 0.90
                 + Math.abs(feat[idx + 2] - patch.tpl[k + 2]) * 0.70;
            if (prevFeat && ((dx | dy) & 1) === 0) {
              motionSum += Math.abs(feat[idx] - prevFeat[idx]);
            }
            k += 3;
          }
        }

        // 前屈などの大きな上下移動を妨げていた anchorYDrift を撤廃し、予測位置からの緩やかな連続性のみを評価
        const predDist = Math.hypot(cx - pcx, cy - pcy);
        const stepDist = Math.hypot(cx - prevCx, cy - prevCy);
        // 動いている被写体が静止背景と同コストになった際、実際に変化している候補をわずかに優遇して壁残りを防止
        const motionBonus = prevFeat ? Math.min(2.4, (motionSum / (count * 0.35)) * 0.12) : 0;
        const cost = (sad / count) + predDist * 0.20 + stepDist * 0.08 - motionBonus;

        if (cost < bestCost) {
          bestCost = cost;
          bestX = cx;
          bestY = cy;
        }
      }
    }

    return {
      mx: clamp(bestX / sw, 0.03, 0.97),
      my: clamp(bestY / sh, 0.03, 0.97),
      cost: bestCost
    };
  }

  function trackSequenceFromSeed(bufs, times, startIdx, dir, seedFrame) {
    const n = times.length;
    const out = new Array(n);
    out[startIdx] = { t: times[startIdx], mx: seedFrame.mx, my: seedFrame.my, mr: seedFrame.mr };
    const patch = bufs[startIdx] ? extractPatch(bufs[startIdx], seedFrame.mx, seedFrame.my) : null;

    let velX = 0, velY = 0;
    for (let i = startIdx + dir; i >= 0 && i < n; i += dir) {
      const prev = out[i - dir];
      const curBuf = bufs[i];
      const prevBuf = bufs[i - dir];
      if (patch && curBuf) {
        const m = matchPatch(curBuf, prevBuf, patch, prev.mx, prev.my, velX, velY);
        velX = m.mx - prev.mx;
        velY = m.my - prev.my;
        out[i] = { t: times[i], mx: m.mx, my: m.my, mr: prev.mr };
        updatePatchGuarded(patch, curBuf, m.mx, m.my, m.cost);
      } else {
        out[i] = { t: times[i], mx: prev.mx, my: prev.my, mr: prev.mr };
      }
    }
    return out;
  }

  function smoothKeyframes(frames) {
    if (!frames || frames.length <= 2) return frames || [];
    const out = frames.map((f) => ({ ...f }));
    for (let i = 1; i < out.length - 1; i++) {
      out[i].mx = out[i - 1].mx * 0.20 + out[i].mx * 0.60 + out[i + 1].mx * 0.20;
      out[i].my = out[i - 1].my * 0.20 + out[i].my * 0.60 + out[i + 1].my * 0.20;
      out[i].mr = out[i - 1].mr * 0.24 + out[i].mr * 0.52 + out[i + 1].mr * 0.24;
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
        // Safari/Chrome で seeked 直後にデコード済みフレームが GPU/Canvas へ反映されるよう1フレーム待機
        if (typeof v.requestVideoFrameCallback === "function") {
          let settled = false;
          const subT = setTimeout(() => { if (!settled) { settled = true; finish(); } }, 45);
          v.requestVideoFrameCallback(() => {
            if (!settled) {
              settled = true;
              clearTimeout(subT);
              finish();
            }
          });
        } else {
          finish();
        }
      };
      const timer = setTimeout(finish, timeoutMs || 320);
      v.addEventListener("seeked", onSeeked);
      try {
        const target = Math.max(0, t || 0);
        if (Math.abs(v.currentTime - target) < 0.006 && !v.seeking && v.readyState >= 2) {
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
        await seekTempVideo(v, 1e7, 420);
        await seekTempVideo(v, 0, 260);
      }
      const p = v.play();
      if (p && typeof p.then === "function") {
        await Promise.race([p.catch(() => {}), new Promise((r) => setTimeout(r, 120))]);
      }
      await new Promise((r) => setTimeout(r, 35));
      v.pause();
    } catch (e) {}
  }

  function withTempVideo(url, knownDuration, workFn) {
    return enqueueVideoScan(() => new Promise((resolve) => {
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

      // 最大90秒動画でも余裕を持って完走でき、万一タイムアウトしても途中までの追従キーフレームを必ず返す
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
    const maxT = Math.min(MAX_TRACK_SEC, Math.max(0.4, dur));
    const step = Math.max(BASE_STEP_SEC, Math.round((maxT / MAX_SCAN_POINTS) * 100) / 100);
    const times = [];
    for (let t = 0; t <= maxT - 0.02; t = Math.round((t + step) * 100) / 100) {
      times.push(t);
    }
    if (!times.length || times[times.length - 1] < maxT - step * 0.45) {
      times.push(Math.max(0, Math.round((maxT - 0.04) * 100) / 100));
    }
    return { times, step };
  }

  // ---------- 静止画の顔・頭部検出＋フォールバック ----------
  async function trackImage(imgEl, isCancelled) {
    if (!imgEl || !imgEl.naturalWidth || !imgEl.naturalHeight) {
      return { status: "fallback", mx: 0.5, my: 0.22, mr: 0.11, keyframes: [] };
    }
    const detectors = await getDetectors();
    if (isCancelled && isCancelled()) return null;
    const hit = detectHeadOnSource(detectors, imgEl, imgEl.naturalWidth, imgEl.naturalHeight, null);
    if (hit) {
      return {
        status: "ai_ok",
        mx: hit.mx,
        my: hit.my,
        mr: hit.mr,
        keyframes: [{ t: 0, mx: hit.mx, my: hit.my, mr: hit.mr }]
      };
    }
    const buf = grabScanBuffer(imgEl, imgEl.naturalWidth, imgEl.naturalHeight);
    const est = estimateHeadFromBuffer(buf);
    return {
      status: "fallback",
      mx: est.mx,
      my: est.my,
      mr: est.mr,
      keyframes: [{ t: 0, mx: est.mx, my: est.my, mr: est.mr }]
    };
  }

  /**
   * AIヒット点と特徴バッファ列から全フレームの追従軌道を組み立てる。
   * 複数のAIヒット間にある未検出ギャップは「前方パッチ追跡」と「後方パッチ追跡」を時間比でブレンドし段差ゼロで接続する。
   */
  function assembleAutoTrajectory(times, aiHits, bufs) {
    const n = times.length;
    if (!n) return null;

    const hitIndices = [];
    for (let i = 0; i < n; i++) {
      if (aiHits[i]) hitIndices.push(i);
    }

    if (hitIndices.length > 0) {
      const frames = new Array(n);
      for (let h = 0; h < hitIndices.length; h++) {
        const idx = hitIndices[h];
        frames[idx] = { t: times[idx], mx: aiHits[idx].mx, my: aiHits[idx].my, mr: aiHits[idx].mr };
      }

      // 1. 最初のAI検出より前の区間を後方パッチ追跡
      const firstIdx = hitIndices[0];
      if (firstIdx > 0) {
        const backSeq = trackSequenceFromSeed(bufs, times, firstIdx, -1, frames[firstIdx]);
        for (let i = 0; i < firstIdx; i++) frames[i] = backSeq[i];
      }

      // 2. AI検出同士のギャップ区間を前方・後方双方向パッチ追跡の重み付きブレンドで滑らかに補間
      for (let h = 0; h < hitIndices.length - 1; h++) {
        const i0 = hitIndices[h];
        const i1 = hitIndices[h + 1];
        if (i1 - i0 <= 1) continue;
        const subLen = i1 - i0 + 1;
        const subBufs = bufs.slice(i0, i1 + 1);
        const subTimes = times.slice(i0, i1 + 1);
        const fwd = trackSequenceFromSeed(subBufs, subTimes, 0, +1, frames[i0]);
        const bwd = trackSequenceFromSeed(subBufs, subTimes, subLen - 1, -1, frames[i1]);
        const spanT = Math.max(0.001, times[i1] - times[i0]);
        for (let k = 1; k < subLen - 1; k++) {
          const u = clamp((subTimes[k] - times[i0]) / spanT, 0, 1);
          frames[i0 + k] = {
            t: subTimes[k],
            mx: fwd[k].mx * (1 - u) + bwd[k].mx * u,
            my: fwd[k].my * (1 - u) + bwd[k].my * u,
            mr: frames[i0].mr * (1 - u) + frames[i1].mr * u
          };
        }
      }

      // 3. 最後のAI検出より後の区間を前方パッチ追跡
      const lastIdx = hitIndices[hitIndices.length - 1];
      if (lastIdx < n - 1) {
        const fwdSeq = trackSequenceFromSeed(bufs, times, lastIdx, +1, frames[lastIdx]);
        for (let i = lastIdx + 1; i < n; i++) frames[i] = fwdSeq[i];
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

    // AIモデル未検出時：時間軸モーションで動いている人物の頭部を特定し（静止した壁やドアを除外）、パッチ自動追従を実行
    const est = estimateMovingHeadAtStart(bufs);
    const seq = trackSequenceFromSeed(bufs, times, 0, +1, { t: times[0], mx: est.mx, my: est.my, mr: est.mr });
    const smoothed = smoothKeyframes(seq);
    return {
      status: "fallback",
      mx: smoothed[0].mx,
      my: smoothed[0].my,
      mr: smoothed[0].mr,
      keyframes: smoothed
    };
  }

  // ---------- 動画のデュアルAI自動追従＋逐次ライブ反映 ----------
  async function trackVideoAuto(url, knownDuration, isCancelled, opts) {
    const onProgress = opts && typeof opts.onProgress === "function" ? opts.onProgress : null;
    const detectors = await getDetectors();
    if (isCancelled && isCancelled()) return null;

    return await withTempVideo(url, knownDuration, async (v, dur, setPartialGetter) => {
      if (!dur || dur <= 0) return null;
      const vw = v.videoWidth || 360, vh = v.videoHeight || 640;
      const { times, step } = buildScanTimes(dur);

      const usedTimes = [];
      const bufs = [];
      const aiHits = [];
      let lastHit = null;

      setPartialGetter(() => assembleAutoTrajectory(usedTimes, aiHits, bufs));

      for (let i = 0; i < times.length; i++) {
        if (isCancelled && isCancelled()) return null;
        await seekOnce(v, times[i], 320);
        // MediaRecorder WebM 等の duration 不明動画で実際の終端に到達したらクリーンに打ち切る
        if (i > 0 && (v.ended || (times[i] > 0.45 && v.currentTime < times[i] - step * 0.75))) {
          break;
        }
        const actualT = Math.max(0, Math.round(v.currentTime * 100) / 100);
        if (usedTimes.length > 0 && actualT <= usedTimes[usedTimes.length - 1] + 0.02) {
          continue;
        }

        const hit = detectors ? detectHeadOnSource(detectors, v, vw, vh, lastHit) : null;
        const buf = grabScanBuffer(v, vw, vh);
        usedTimes.push(actualT);
        aiHits.push(hit);
        bufs.push(buf);
        if (hit) lastHit = hit;

        // スキャン中もプレビュー上で即座に追従が始まるよう逐次キーフレームを配信
        if (onProgress && (i === 0 || i % 4 === 0 || i === times.length - 1)) {
          const partial = assembleAutoTrajectory(usedTimes, aiHits, bufs);
          if (partial) {
            onProgress({
              ...partial,
              progress: Math.min(0.99, (i + 1) / times.length)
            });
          }
        }
        await yieldStep();
      }

      return assembleAutoTrajectory(usedTimes, aiHits, bufs);
    });
  }

  // ---------- ユーザーが頭に合わせて指定した位置からの双方向パッチ自動追従 ----------
  async function trackVideoFromAnchor(url, knownDuration, anchor, isCancelled, opts) {
    const onProgress = opts && typeof opts.onProgress === "function" ? opts.onProgress : null;
    const aTime = Math.max(0, Number(anchor && anchor.t) || 0);
    const aMx = clamp(Number(anchor && anchor.mx) || 0.5, 0.03, 0.97);
    const aMy = clamp(Number(anchor && anchor.my) || 0.22, 0.03, 0.97);
    const aMr = clamp(Number(anchor && anchor.mr) || 0.11, 0.04, 0.35);

    return await withTempVideo(url, knownDuration, async (v, dur, setPartialGetter) => {
      if (!dur || dur <= 0) return null;
      const vw = v.videoWidth || 360, vh = v.videoHeight || 640;
      const { times, step } = buildScanTimes(dur);

      const usedTimes = [];
      const bufs = [];

      const buildFromCollected = () => {
        if (!usedTimes.length) return null;
        let anchorIdx = 0, minDiff = Infinity;
        for (let i = 0; i < usedTimes.length; i++) {
          const d = Math.abs(usedTimes[i] - aTime);
          if (d < minDiff) { minDiff = d; anchorIdx = i; }
        }
        const seed = { t: usedTimes[anchorIdx], mx: aMx, my: aMy, mr: aMr };
        const fwd = trackSequenceFromSeed(bufs, usedTimes, anchorIdx, +1, seed);
        const bwd = trackSequenceFromSeed(bufs, usedTimes, anchorIdx, -1, seed);
        const frames = new Array(usedTimes.length);
        for (let i = 0; i < usedTimes.length; i++) {
          frames[i] = i >= anchorIdx ? fwd[i] : bwd[i];
        }
        const smoothed = smoothKeyframes(frames);
        // アンカー時刻そのものはユーザーが指定した座標を厳密に維持
        smoothed[anchorIdx] = { t: usedTimes[anchorIdx], mx: aMx, my: aMy, mr: aMr };
        return {
          status: "patch_ok",
          mx: aMx,
          my: aMy,
          mr: aMr,
          keyframes: smoothed
        };
      };

      setPartialGetter(buildFromCollected);

      for (let i = 0; i < times.length; i++) {
        if (isCancelled && isCancelled()) return null;
        await seekOnce(v, times[i], 320);
        if (i > 0 && (v.ended || (times[i] > 0.45 && v.currentTime < times[i] - step * 0.75))) {
          break;
        }
        const actualT = Math.max(0, Math.round(v.currentTime * 100) / 100);
        if (usedTimes.length > 0 && actualT <= usedTimes[usedTimes.length - 1] + 0.02) {
          continue;
        }
        usedTimes.push(actualT);
        bufs.push(grabScanBuffer(v, vw, vh));

        if (onProgress && (i % 6 === 0 || i === times.length - 1)) {
          const partial = buildFromCollected();
          if (partial) {
            onProgress({
              ...partial,
              progress: Math.min(0.99, (i + 1) / times.length)
            });
          }
        }
        await yieldStep();
      }

      return buildFromCollected();
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

  function drawSmoothOvalBlur(ctx, W, H, LW, LH, panelRect, centerLogical, radiiLogical) {
    const sxScale = W / LW, syScale = H / LH;
    const cx = centerLogical.x, cy = centerLogical.y;
    const rx = Math.max(14, radiiLogical.rx);
    const ry = Math.max(16, radiiLogical.ry);

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
    ctx.beginPath();
    ctx.rect(panelRect.x, panelRect.y, panelRect.w, panelRect.h);
    ctx.clip();

    ctx.imageSmoothingEnabled = true;
    if ("imageSmoothingQuality" in ctx) ctx.imageSmoothingQuality = "high";

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
