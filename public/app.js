(() => {
  "use strict";
  const CFG = window.BAM_CONFIG;
  const $ = (id) => document.getElementById(id);

  // ---------- 定数・アスペクト比別ジオメトリ（論理幅 LW=1080 基準） ----------
  const LW = 1080;
  const GAP = 6;
  const END_CARD_ADD_SEC = 2.2;
  const FONT = '"Noto Sans JP","Hiragino Sans","Hiragino Kaku Gothic ProN",Meiryo,sans-serif';

  const ASPECT_SPECS = {
    "9:16": {
      label: "9:16",
      LH: 1920, topH: 360, bottomY: 1500,
      pvW: 540, pvH: 960,
      freeW: 720, freeH: 1280, proW: 1080, proH: 1920,
      baseY: { symptom: 125, age: 250, clinic: 1590, sub: 1700 },
      disclaimerY: 1868,
      fonts: {
        symptom: [132, 52], age: [64, 34, 40],
        clinic: [88, 38, 120], sub: [48, 28],
        disclaimer: [30, 22], badge: [54, 84]
      }
    },
    "4:5": {
      label: "4:5",
      LH: 1350, topH: 230, bottomY: 1100,
      pvW: 540, pvH: 675,
      freeW: 720, freeH: 900, proW: 1080, proH: 1350,
      baseY: { symptom: 82, age: 168, clinic: 1172, sub: 1256 },
      disclaimerY: 1318,
      fonts: {
        symptom: [92, 42], age: [48, 28, 28],
        clinic: [68, 34, 92], sub: [38, 24],
        disclaimer: [26, 20], badge: [46, 72]
      }
    },
    "1:1": {
      label: "1:1",
      LH: 1080, topH: 184, bottomY: 880,
      pvW: 540, pvH: 540,
      freeW: 720, freeH: 720, proW: 1080, proH: 1080,
      baseY: { symptom: 66, age: 138, clinic: 942, sub: 1012 },
      disclaimerY: 1054,
      fonts: {
        symptom: [76, 36], age: [42, 26, 22],
        clinic: [58, 30, 78], sub: [34, 22],
        disclaimer: [24, 18], badge: [42, 66]
      }
    }
  };

  const TEXT_SLIDERS = {
    symptom: "posSymptomY",
    age:     "posAgeY",
    clinic:  "posClinicY",
    sub:     "posSubY"
  };

  const THEMES = {
    dark:  { name: "ダーク",   pro: false, bg: "#111111", text: "#ffffff", accent: "#ff5a5f" },
    white: { name: "ホワイト", pro: false, bg: "#ffffff", text: "#1a1a1a", accent: "#e8454b" },
    gold:  { name: "ゴールド", pro: true,  bg: "#1b1608", text: "#fff6dc", accent: "#e6b422" },
    mint:  { name: "ミント",   pro: true,  bg: "#0e2a26", text: "#eafff9", accent: "#2fd1a8" },
    navy:  { name: "ネイビー", pro: true,  bg: "#0c1b3a", text: "#f0f5ff", accent: "#4da3ff" },
    custom:{ name: "自由配色", pro: true,  bg: "#111111", text: "#ffffff", accent: "#ff5a5f" }
  };

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const cap = (s) => s[0].toUpperCase() + s.slice(1);

  const newTextPos = () => ({
    symptom: { dx: 0, dy: 0 },
    age:     { dx: 0, dy: 0 },
    clinic:  { dx: 0, dy: 0 },
    sub:     { dx: 0, dy: 0 }
  });

  const BGM = window.BAM_BGM;
  const MOTION = window.BAM_MOTION;
  const FACE = window.BAM_FACE;

  // WebKit / Blink のオクルージョン間引き（背面隠蔽時のフレーム供給低下）を防ぐため、非隠蔽・極小（2x2px・不透明度0.4%）の前面透過レイヤーに配置
  const mediaPool = document.createElement("div");
  mediaPool.setAttribute("aria-hidden", "true");
  mediaPool.style.cssText = "position:fixed;right:2px;bottom:2px;width:4px;height:2px;overflow:hidden;opacity:0.004;pointer-events:none;z-index:9;contain:strict";
  document.body.appendChild(mediaPool);

  // WebKitのGPU（IOSurface / Metal VideoTextureCopierCV）最小加速サイズ（257x257超）を満たすウォームアップ専用キャンバス
  const warmCanvas = document.createElement("canvas");
  warmCanvas.width = 280;
  warmCanvas.height = 280;
  const warmCtx = warmCanvas.getContext("2d", { alpha: false });

  // ---------- 状態 ----------
  const newBlur = () => ({
    enabled: true,
    mode: "auto",       // "auto" | "patch" | "fixed"
    scale: 1,
    fixedX: 0.5,
    fixedY: 0.22,
    baseR: 0.11,
    offsetX: 0,
    offsetY: 0,
    keyframes: [],
    status: "idle",     // "idle" | "tracking" | "ai_ok" | "patch_ok" | "fallback" | "fixed"
    trackId: 0,
    trackPromise: null
  });

  const newPanel = () => ({
    type: null, el: null, url: null, name: "", zoom: 1, ox: 0, oy: 0,
    trimStart: 0, autoTrimSec: 0, autoDetected: false,
    scanning: false, scanId: 0, scanPromise: null, audioSrc: null,
    holdCanvas: null, hasHold: false, warmed: false, warming: false,
    frameSeq: 0, drawnFrameSeq: -1, drawnTime: -1, drawnHold: null,
    blur: newBlur()
  });

  const state = {
    symptom: "", age: "", clinic: "", sub: "",
    aspect: "9:16",      // "9:16" | "4:5" | "1:1"
    layout: "split-h",   // "split-h" | "split-v" | "wipe"
    wipePos: 0.5,
    wipeManual: false,
    faceBlur: false,
    posture: {
      grid: false,
      lines: false,
      y1: 0.26,
      y2: 0.56,
      markers: [],       // [{ id, type: "circle" | "arrow", nx, ny, angle, scale }]
      selectedId: 0
    },
    endCard: {
      enabled: false,
      area: "",
      offer: "",
      cta: "ご予約はプロフィールの公式LINEから ▶",
      previewing: false
    },
    disclaimer: {
      enabled: false,
      text: "※施術効果には個人差があります"
    },
    snsFooter: "",
    preferredSnsFooter: "",
    theme: "dark",
    preferredTheme: "dark",
    custom: { bg: "#111111", text: "#ffffff", accent: "#ff5a5f" },
    textPos: newTextPos(),
    bgm: { enabled: true, seed: 1, volume: 0.7, photoSec: 8 },
    autoSync: true,
    guide: false, playing: true, exporting: false,
    logo: null,
    panels: { before: newPanel(), after: newPanel() }
  };

  let markerSeq = 1;
  let blurRingUntil = 0;
  let bgmPreview = null;
  let loopTimer = null;
  let scrubbingTrim = false;
  let syncingVideos = false;
  let syncToken = 0;
  let logoUrl = null;
  let previewDirty = true;
  let fontEpoch = 0;
  let lastExport = null;
  let captionEdited = false;
  let pendingSnsTarget = null;
  let lastSnsUiReady = null;
  const fitCache = new Map();

  function getSpec() {
    return ASPECT_SPECS[state.aspect] || ASPECT_SPECS["9:16"];
  }
  function getGeom() {
    const sp = getSpec();
    return {
      LW,
      LH: sp.LH,
      topH: sp.topH,
      bottomY: sp.bottomY,
      panelY: sp.topH,
      panelH: sp.bottomY - sp.topH,
      disclaimerY: sp.disclaimerY,
      fonts: sp.fonts,
      baseY: sp.baseY,
      spec: sp
    };
  }
  function getPanelFrame(which) {
    const g = getGeom();
    if (state.layout === "split-v") {
      const h1 = Math.floor((g.panelH - GAP) / 2);
      return which === "before"
        ? { x: 0, y: g.panelY, w: LW, h: h1 }
        : { x: 0, y: g.panelY + h1 + GAP, w: LW, h: g.panelH - h1 - GAP };
    }
    if (state.layout === "wipe") {
      return { x: 0, y: g.panelY, w: LW, h: g.panelH };
    }
    const w = (LW - GAP) / 2;
    return which === "before"
      ? { x: 0, y: g.panelY, w, h: g.panelH }
      : { x: w + GAP, y: g.panelY, w, h: g.panelH };
  }
  function getWipeRatio(opt) {
    if (opt && typeof opt.wipeRatio === "number") {
      return clamp(opt.wipeRatio, 0.08, 0.92);
    }
    if (opt && opt.staticWipe) {
      return clamp(state.wipePos, 0.08, 0.92);
    }
    if (opt && typeof opt.wipeTime === "number") {
      return clamp(0.5 - 0.36 * Math.sin(opt.wipeTime * (Math.PI * 2 / 3.4)), 0.12, 0.88);
    }
    if (state.playing && !state.wipeManual && !(drag && drag.kind === "wipe")) {
      const t = performance.now() / 1000;
      return clamp(0.5 - 0.36 * Math.sin(t * (Math.PI * 2 / 3.4)), 0.12, 0.88);
    }
    return clamp(state.wipePos, 0.08, 0.92);
  }

  function markDirty() {
    previewDirty = true;
    if (lastExport) refreshSnsUI();
  }

  function clearLogo() {
    if (logoUrl) {
      URL.revokeObjectURL(logoUrl);
      logoUrl = null;
    }
    state.logo = null;
    const btn = $("btnLogoClear");
    if (btn) btn.hidden = true;
    markDirty();
  }

  function stopBgmPreview() {
    if (bgmPreview) {
      bgmPreview.stop();
      bgmPreview = null;
    }
    const btn = $("btnBgmPreview");
    if (btn) btn.textContent = "🎧 試聴";
  }

  function refreshBgmUI() {
    const info = BGM.describeTrack(state.bgm.seed);
    $("bgmTitle").textContent = state.bgm.enabled ? "🎵 " + info.title : "BGMオフ（" + info.title + "）";
    $("chkBgm").checked = state.bgm.enabled;
    $("chkBgm").closest(".bgm-box").classList.toggle("off", !state.bgm.enabled);
    const willVideo = Object.values(state.panels).some(p => p.type === "video") || state.bgm.enabled || state.endCard.enabled;
    $("btnSave").textContent = willVideo
      ? (state.bgm.enabled ? "💾 動画で保存する（🎵BGM付き）" : "💾 動画で保存する")
      : "💾 画像（PNG）で保存する";
    refreshSnsUI();
  }

  function toggleBgmPreview() {
    if (bgmPreview) {
      stopBgmPreview();
      return;
    }
    if (!state.bgm.enabled) {
      state.bgm.enabled = true;
      saveSettings();
      refreshBgmUI();
    }
    try {
      const ctx = BGM.ensureContext();
      bgmPreview = BGM.start(ctx, ctx.destination, { seed: state.bgm.seed, volume: state.bgm.volume });
      $("btnBgmPreview").textContent = "⏹ 停止";
      restartVideos();
    } catch (e) {
      setMsg(e.message || "試聴を開始できませんでした。", "err");
    }
  }

  function nextBgmTrack() {
    state.bgm.seed = (state.bgm.seed % 999) + 1;
    if (!state.bgm.enabled) state.bgm.enabled = true;
    saveSettings();
    refreshBgmUI();
    if (bgmPreview) {
      stopBgmPreview();
      toggleBgmPreview();
    }
  }

  function textBaseFor(key) {
    const g = getGeom();
    return { x: LW / 2, y: g.baseY[key], slider: TEXT_SLIDERS[key] };
  }
  function textXY(key) {
    const g = getGeom();
    const b = textBaseFor(key), p = state.textPos[key];
    return {
      x: clamp(b.x + p.dx, 80, LW - 80),
      y: clamp(b.y + p.dy, 45, g.LH - 45)
    };
  }
  function syncTextSliders() {
    const g = getGeom();
    Object.entries(TEXT_SLIDERS).forEach(([k, sliderId]) => {
      const el = $(sliderId);
      if (el) {
        el.min = "45";
        el.max = String(g.LH - 45);
        el.value = Math.round(textXY(k).y);
      }
    });
  }

  // ---------- 設定・テンプレートの保存・復元 ----------
  const LS_SETTINGS = "bam_settings_v1";
  const LS_PRESETS = "bam_presets_v1";
  const isHex = (v) => typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v);

  function saveSettings() {
    try {
      localStorage.setItem(LS_SETTINGS, JSON.stringify({
        clinic: state.clinic,
        theme: state.preferredTheme || state.theme,
        custom: state.custom,
        textPos: state.textPos,
        bgm: state.bgm,
        autoSync: state.autoSync,
        endCard: {
          area: state.endCard.area,
          offer: state.endCard.offer,
          cta: state.endCard.cta
        },
        disclaimerText: state.disclaimer.text,
        snsFooter: state.snsFooter || state.preferredSnsFooter || ""
      }));
    } catch (e) {}
  }

  function loadSettings() {
    try {
      const raw = localStorage.getItem(LS_SETTINGS);
      if (raw) {
        const d = JSON.parse(raw);
        if (d && typeof d.clinic === "string") {
          state.clinic = d.clinic.trim().slice(0, 30);
        }
        if (d && d.custom) {
          if (isHex(d.custom.bg)) state.custom.bg = d.custom.bg;
          if (isHex(d.custom.text)) state.custom.text = d.custom.text;
          if (isHex(d.custom.accent)) state.custom.accent = d.custom.accent;
        }
        $("cBg").value = state.custom.bg;
        $("cText").value = state.custom.text;
        $("cAccent").value = state.custom.accent;
        if (d && typeof d.theme === "string" && THEMES[d.theme]) {
          state.preferredTheme = d.theme;
          state.theme = THEMES[d.theme].pro && !pro ? "dark" : d.theme;
        }
        if (d && d.textPos) {
          const g = getGeom();
          Object.keys(TEXT_SLIDERS).forEach((k) => {
            const tp = d.textPos[k], b = textBaseFor(k);
            if (tp && typeof tp.dx === "number" && isFinite(tp.dx)) {
              state.textPos[k].dx = clamp(Math.round(tp.dx), 80 - b.x, LW - 80 - b.x);
            }
            if (tp && typeof tp.dy === "number" && isFinite(tp.dy)) {
              state.textPos[k].dy = clamp(Math.round(tp.dy), 45 - b.y, g.LH - 45 - b.y);
            }
          });
        }
        if (d && d.bgm) {
          if (typeof d.bgm.enabled === "boolean") state.bgm.enabled = d.bgm.enabled;
          if (typeof d.bgm.seed === "number" && d.bgm.seed >= 1) state.bgm.seed = Math.floor(d.bgm.seed);
          if (typeof d.bgm.volume === "number" && isFinite(d.bgm.volume)) state.bgm.volume = clamp(d.bgm.volume, 0.1, 1);
          if ([5, 8, 10, 15].includes(Number(d.bgm.photoSec))) state.bgm.photoSec = Number(d.bgm.photoSec);
        }
        if (d && typeof d.autoSync === "boolean") {
          state.autoSync = d.autoSync;
        }
        if (d && d.endCard) {
          if (typeof d.endCard.area === "string") state.endCard.area = d.endCard.area.slice(0, 32);
          if (typeof d.endCard.offer === "string") state.endCard.offer = d.endCard.offer.slice(0, 42);
          if (typeof d.endCard.cta === "string" && d.endCard.cta.trim()) state.endCard.cta = d.endCard.cta.slice(0, 36);
        }
        if (d && typeof d.disclaimerText === "string" && d.disclaimerText.trim()) {
          state.disclaimer.text = d.disclaimerText.slice(0, 45);
        }
        if (d && typeof d.snsFooter === "string") {
          state.preferredSnsFooter = d.snsFooter.slice(0, 400);
        }
      }
    } catch (e) {}
    $("inClinic").value = state.clinic;
    $("inEndArea").value = state.endCard.area;
    $("inEndOffer").value = state.endCard.offer;
    $("inEndCta").value = state.endCard.cta;
    $("inDisclaimer").value = state.disclaimer.text;
    $("inSnsFooter").value = state.snsFooter;
    $("bgmVol").value = state.bgm.volume;
    $("selPhotoSec").value = String(state.bgm.photoSec);
    $("chkAutoSync").checked = state.autoSync;
    syncTextSliders();
    refreshBgmUI();
    refreshTrimUI();
    renderPresets();
    syncAutoCaption();
    initSnsUI();
  }

  // ---------- ライセンス（自動認証・2台制限・解約自動遮断） ----------
  const LS_KEY = "bam_license";
  const LS_LIC_META = "bam_license_meta_v1";
  const LS_DEVICE = "bam_device_v1";
  const OFFLINE_GRACE_MS = 24 * 3600_000;
  const VERIFY_CACHE_MS = 5 * 60_000;
  let pro = false;
  let licMeta = null;
  let verifyInFlight = null;
  let showFullKey = false;

  const normKey = (k) => String(k || "").trim().toUpperCase().replace(/\s+/g, "");
  const apiBase = () => String(CFG.LICENSE_API_URL || "").trim().replace(/\/+$/, "");

  function maskKeyLocal(k) {
    const n = normKey(k);
    if (!n) return "BAM-••••";
    const parts = n.split("-");
    return parts.length === 4
      ? `${parts[0]}-${parts[1]}-••••-${parts[3].slice(-2)}••`
      : n.slice(0, 8) + "••••";
  }

  function getDeviceId() {
    try {
      const existing = localStorage.getItem(LS_DEVICE);
      if (existing && existing.length >= 12) return existing;
    } catch (e) {}
    let rnd = "";
    if (window.crypto && crypto.getRandomValues) {
      const buf = new Uint8Array(12);
      crypto.getRandomValues(buf);
      rnd = Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
    } else {
      rnd = Math.random().toString(36).slice(2) + Date.now().toString(36);
    }
    const id = "dev_" + rnd;
    try { localStorage.setItem(LS_DEVICE, id); } catch (e) {}
    return id;
  }

  function getDeviceLabel() {
    const ua = navigator.userAgent || "";
    if (/iPad/i.test(ua) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1)) return "iPad";
    if (/iPhone/i.test(ua)) return "iPhone";
    if (/Android/i.test(ua)) return "Android";
    if (/Macintosh|Mac OS/i.test(ua)) return "Mac";
    if (/Windows/i.test(ua)) return "Windows";
    return "ブラウザ";
  }

  function loadLicMeta() {
    try {
      const raw = localStorage.getItem(LS_LIC_META);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function saveLicMeta(meta) {
    licMeta = meta;
    try { localStorage.setItem(LS_LIC_META, JSON.stringify(meta)); } catch (e) {}
  }

  function clearLocalLicense() {
    licMeta = null;
    pro = false;
    showFullKey = false;
    try {
      localStorage.removeItem(LS_KEY);
      localStorage.removeItem(LS_LIC_META);
    } catch (e) {}
  }

  async function sha256(str) {
    if (!(window.crypto && crypto.subtle)) throw new Error("HTTPS（またはlocalhost）で開いてください");
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
  }

  async function checkOfflineHash(key) {
    if (!Array.isArray(CFG.LICENSE_HASHES) || CFG.LICENSE_HASHES.length === 0) return false;
    try { return CFG.LICENSE_HASHES.includes(await sha256(normKey(key))); }
    catch (e) { return false; }
  }

  async function postLicenseApi(path, payload, timeoutMs) {
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs || 8000) : 0;
    try {
      const res = await fetch(apiBase() + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: ctrl ? ctrl.signal : undefined
      });
      let data = null;
      try { data = await res.json(); } catch (e) {}
      return { okHttp: res.ok, status: res.status, data };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function formatJpDate(unixSec) {
    if (!unixSec || !isFinite(unixSec)) return "";
    const d = new Date(unixSec * 1000);
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
  }

  function getActiveProFeatures() {
    const list = [];
    if (state.aspect !== "9:16") list.push(`サイズ切替(${state.aspect})`);
    if (state.layout !== "split-h") list.push(state.layout === "wipe" ? "スライド比較" : "上下2分割");
    if (state.faceBlur) list.push("AI顔ぼかし追従");
    if (state.posture.grid || state.posture.lines || state.posture.markers.length > 0) list.push("姿勢基準線・スタンプ");
    if (state.endCard.enabled) list.push("ラスト2秒誘導カット");
    if (state.disclaimer.enabled) list.push("免責テロップ");
    if ((state.snsFooter || "").trim().length > 0) list.push("SNS固定フッター");
    return list;
  }

  function refreshQualityLabels() {
    const sp = getSpec();
    const selQ = $("selQuality");
    if (selQ && selQ.options[0]) {
      selQ.options[0].textContent = `${sp.freeW}×${sp.freeH}（無料）`;
    }
    const optHq = $("optHQ");
    if (optHq) {
      optHq.textContent = pro
        ? `${sp.proW}×${sp.proH}（フルHD・高画質）`
        : `🔒 ${sp.proW}×${sp.proH}（有料）`;
    }
    const bar = $("planBar");
    if (bar) {
      bar.className = "plan-bar " + (pro ? "pro" : "free");
      $("planBarText").textContent = pro
        ? `⭐ 有料プラン適用中：透かしなし・${sp.proW}×${sp.proH} 高画質`
        : `無料プラン：${sp.freeW}×${sp.freeH}画質・院名下に透かしが入ります`;
      $("btnPlanBarUpgrade").hidden = pro;
    }
    const limCfg = pro ? CFG.LIMITS.pro : CFG.LIMITS.free;
    const outW = (pro && selQ && selQ.value === "1080") ? sp.proW : sp.freeW;
    const outH = (pro && selQ && selQ.value === "1080") ? sp.proH : sp.freeH;
    const lh = $("limitHint");
    if (lh) {
      lh.textContent =
        `現在のプラン：${outW}×${outH}（${sp.label}） ／ 動画は最大${limCfg.maxSeconds}秒` +
        (pro ? " ／ 透かしなし" : " ／ 院名下に透かしあり") +
        "。MP4で保存できない環境ではWebMで保存されます。";
    }
  }

  function refreshProTrialUI() {
    document.body.classList.toggle("is-pro", pro);
    const feats = getActiveProFeatures();
    const badge = $("proToolsBadge");
    if (badge) {
      if (pro) {
        badge.textContent = "⭐ 有料機能すべて解放済";
        badge.className = "try-pill pro-unlocked";
      } else if (feats.length > 0) {
        badge.textContent = `⭐ お試し中（${feats.length}機能）`;
        badge.className = "try-pill";
      } else {
        badge.textContent = "プレビューでお試しOK";
        badge.className = "try-pill";
      }
    }
    const tBar = $("proTrialBar");
    if (tBar) {
      if (!pro && feats.length > 0) {
        tBar.hidden = false;
        $("proTrialText").textContent = `⭐ 有料機能をお試し中：${feats.join("・")}（このまま保存するには有料プランが必要です）`;
      } else {
        tBar.hidden = true;
      }
    }
    const mReset = $("btnModalResetTrial");
    if (mReset) {
      mReset.hidden = pro || feats.length === 0;
    }
  }

  function checkProGateBeforeExport() {
    if (pro) return true;
    const feats = getActiveProFeatures();
    if (!feats.length) return true;
    openModal(`🔒 お試し中の有料機能（${feats.join("・")}）を含めて保存・SNS投稿するには、有料プラン（${CFG.PRO_PRICE_LABEL}）への切り替えが必要です。`);
    return false;
  }

  function syncModalView() {
    $("modalFreeView").hidden = pro;
    $("modalProView").hidden = !pro;
    $("priceLabel").textContent = CFG.PRO_PRICE_LABEL;
    $("priceNote").textContent = CFG.PRO_PRICE_NOTE;
    refreshProTrialUI();

    const buy = $("btnBuy");
    if (CFG.PAYMENT_URL) {
      buy.href = CFG.PAYMENT_URL;
      buy.removeAttribute("aria-disabled");
    } else {
      buy.removeAttribute("href");
    }
    $("buyNote").textContent = CFG.PAYMENT_URL
      ? "決済完了後、ご登録メール宛にワンタップ有効化リンク＆ライセンスキーが即時自動送信されます（最大2台まで利用可）。"
      : "※購入ページは準備中です（管理者が config.js の PAYMENT_URL を設定すると有効になります）。";

    const lineUrl = String(CFG.LINE_CONTACT_URL || "https://lin.ee/XB6R3kS").trim();
    ["btnLineContact", "modalLineContact"].forEach((id) => {
      const el = $(id);
      if (el && lineUrl) el.href = lineUrl;
    });

    const isOwnerAdmin = Boolean(pro && licMeta && licMeta.isAdmin);
    if ($("btnAdminPage")) $("btnAdminPage").hidden = !isOwnerAdmin;
    if ($("btnModalAdminPage")) $("btnModalAdminPage").hidden = !isOwnerAdmin;

    if (pro) {
      const maxD = (licMeta && licMeta.maxDevices) || CFG.MAX_DEVICES || 2;
      const curD = (licMeta && licMeta.deviceCount) || 1;
      const rawSaved = normKey(localStorage.getItem(LS_KEY) || "");
      $("proStatusBadge").textContent = isOwnerAdmin
        ? "有効（管理者ライセンス）"
        : ((licMeta && licMeta.cancelAtPeriodEnd) ? "有効（期間終了で自動終了）" : "有効（認証済み）");
      $("proKeyMasked").textContent = (showFullKey && rawSaved)
        ? rawSaved
        : ((licMeta && licMeta.maskedKey) || maskKeyLocal(rawSaved));
      $("btnToggleKey").textContent = showFullKey ? "隠す" : "表示";
      $("btnToggleKey").hidden = !rawSaved;
      $("btnCopyKey").hidden = !rawSaved;
      $("proDeviceInfo").textContent = `${curD} / ${maxD} 台（最大${maxD}台まで）`;

      const subNote = $("proSubNote");
      if (licMeta && licMeta.cancelAtPeriodEnd) {
        const endStr = formatJpDate(licMeta.currentPeriodEnd);
        subNote.textContent = endStr
          ? `※${endStr}までは有料プランをご利用いただけ、その後は自動で無料プランへ戻ります。`
          : "※現在の契約期間終了後に自動で無料プランへ戻ります。";
        subNote.hidden = false;
      } else {
        subNote.hidden = true;
      }
    }
  }

  function applyPlan(upgradeQuality) {
    $("planBadge").textContent = pro ? "⭐ 有料プラン（認証済）" : "無料プラン";
    $("planBadge").className = "badge " + (pro ? "pro" : "free");

    // 有料会員もいつでも端末解除・解約確認できるようボタンを常時表示し役割を切り替える
    const upg = $("btnUpgrade");
    upg.hidden = false;
    upg.textContent = pro ? "⚙ プラン・端末管理" : "⭐ 有料プラン / キー入力";
    upg.className = pro ? "btn small" : "btn primary small";

    $("btnLogo").textContent = pro ? "🖼 ロゴを追加" : "🔒 ロゴを追加（有料）";

    if (pro) {
      if (upgradeQuality) $("selQuality").value = "1080";
      if (state.preferredTheme && THEMES[state.preferredTheme]) {
        state.theme = state.preferredTheme;
      }
      if (!state.snsFooter && state.preferredSnsFooter) {
        state.snsFooter = state.preferredSnsFooter;
        if ($("inSnsFooter")) $("inSnsFooter").value = state.snsFooter;
        syncAutoCaption();
      }
    } else {
      if (THEMES[state.theme].pro) state.theme = "dark";
      $("selQuality").value = "720";
      clearLogo();
    }

    refreshQualityLabels();
    refreshProTrialUI();
    renderThemes();
    syncModalView();
    markDirty();
  }

  function buildMetaFromApi(key, data) {
    return {
      isAdmin: !!(data && data.isAdmin),
      maskedKey: (data && data.maskedKey) || maskKeyLocal(key),
      deviceCount: (data && data.deviceCount) || 1,
      maxDevices: (data && data.maxDevices) || CFG.MAX_DEVICES || 2,
      cancelAtPeriodEnd: !!(data && data.cancelAtPeriodEnd),
      currentPeriodEnd: (data && data.currentPeriodEnd) || null,
      verifiedAt: Date.now()
    };
  }

  async function activateLicenseKey(rawKey) {
    const key = normKey(rawKey);
    if (!key) throw new Error("ライセンスキーを入力してください。");

    if (apiBase()) {
      let res;
      try {
        res = await postLicenseApi("/api/activate", {
          key,
          deviceId: getDeviceId(),
          deviceLabel: getDeviceLabel()
        }, 8000);
      } catch (e) {
        throw new Error("認証サーバーに接続できませんでした。通信環境をご確認のうえ再度お試しください。");
      }
      const d = res.data || {};
      if (res.okHttp && d.ok && d.active) {
        const finalKey = normKey(d.key || key);
        try { localStorage.setItem(LS_KEY, finalKey); } catch (e) {}
        saveLicMeta(buildMetaFromApi(finalKey, d));
        pro = true;
        applyPlan(true);
        return licMeta;
      }
      throw new Error(d.message || "ライセンスキーを有効化できませんでした。");
    }

    // オフラインフォールバック（LICENSE_API_URL 未設定時のみ）
    if (!Array.isArray(CFG.LICENSE_HASHES) || CFG.LICENSE_HASHES.length === 0) {
      throw new Error("ライセンス認証サーバー（config.js の LICENSE_API_URL）が未設定です。");
    }
    if (await checkOfflineHash(key)) {
      try { localStorage.setItem(LS_KEY, key); } catch (e) {}
      saveLicMeta(buildMetaFromApi(key, null));
      pro = true;
      applyPlan(true);
      return licMeta;
    }
    throw new Error("ライセンスキーが正しくありません。");
  }

  async function verifyActiveLicense(opts) {
    opts = opts || {};
    if (verifyInFlight) return verifyInFlight;
    verifyInFlight = (async () => {
      const saved = normKey(localStorage.getItem(LS_KEY) || "");
      if (!saved) {
        if (pro) { pro = false; applyPlan(false); }
        return false;
      }

      if (!apiBase()) {
        const ok = await checkOfflineHash(saved);
        if (!ok) {
          clearLocalLicense();
          applyPlan(false);
          return false;
        }
        const wasPro = pro;
        if (!licMeta) saveLicMeta(buildMetaFromApi(saved, null));
        pro = true;
        applyPlan(!wasPro);
        return true;
      }

      if (!opts.force && pro && licMeta && (Date.now() - (licMeta.verifiedAt || 0) < VERIFY_CACHE_MS)) {
        return true;
      }

      try {
        const res = await postLicenseApi("/api/verify", {
          key: saved,
          deviceId: getDeviceId(),
          deviceLabel: getDeviceLabel()
        }, 6000);
        const d = res.data || {};
        if (res.okHttp && d.ok && d.active) {
          const wasPro = pro;
          saveLicMeta(buildMetaFromApi(saved, d));
          pro = true;
          applyPlan(!wasPro);
          return true;
        }
        if (res.status === 403 || res.status === 404 || d.active === false) {
          const msg = d.message || "有料プランの有効期限が終了したため、無料プランに戻りました。";
          clearLocalLicense();
          applyPlan(false);
          setMsg(msg, "err");
          if (!$("modal").hidden) {
            $("keyMsg").textContent = msg;
            $("keyMsg").className = "msg err";
          }
          return false;
        }
      } catch (e) {
        // 一時的な通信断は最終認証から24時間以内のみ猶予し、それ以降は自動遮断する
        if (licMeta && licMeta.verifiedAt && (Date.now() - licMeta.verifiedAt < OFFLINE_GRACE_MS)) {
          const wasPro = pro;
          pro = true;
          applyPlan(!wasPro);
          return true;
        }
        pro = false;
        applyPlan(false);
        return false;
      }
      return pro;
    })();
    try { return await verifyInFlight; }
    finally { verifyInFlight = null; }
  }

  async function deactivateCurrentDevice() {
    const saved = normKey(localStorage.getItem(LS_KEY) || "");
    const btn = $("btnDeactivate");
    const msgEl = $("proMsg");
    msgEl.textContent = "";
    msgEl.className = "msg";

    if (saved && apiBase()) {
      btn.disabled = true;
      try {
        const res = await postLicenseApi("/api/deactivate", {
          key: saved,
          deviceId: getDeviceId()
        }, 7000);
        if (!res.okHttp && res.status !== 404) {
          throw new Error((res.data && res.data.message) || "解除に失敗しました。");
        }
      } catch (e) {
        btn.disabled = false;
        msgEl.textContent = "通信エラーのため端末枠を解除できませんでした。ネット接続を確認して再度お試しください。";
        msgEl.className = "msg err";
        return;
      }
      btn.disabled = false;
    }

    clearLocalLicense();
    $("inKey").value = "";
    applyPlan(false);
    $("keyMsg").textContent = "この端末のライセンスを解除し、無料プランに戻りました（端末枠が1つ空きました）。";
    $("keyMsg").className = "msg ok";
    setMsg("この端末のライセンスを解除しました（無料プランに戻りました）。", "ok");
  }

  async function claimSessionFromRedirect(sessionId) {
    if (!apiBase()) {
      openModal("お申し込みありがとうございます！メールで届くライセンスキーを下の欄に入力してください。");
      return;
    }
    setMsg("決済を確認して有料プランを有効化しています…");
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const res = await postLicenseApi("/api/claim-session", {
          sessionId,
          deviceId: getDeviceId(),
          deviceLabel: getDeviceLabel()
        }, 8000);
        const d = res.data || {};
        if (res.status === 202 || d.code === "PENDING") {
          await new Promise((r) => setTimeout(r, 1500));
          continue;
        }
        if (res.okHttp && d.ok && d.active && d.key) {
          const finalKey = normKey(d.key);
          try { localStorage.setItem(LS_KEY, finalKey); } catch (e) {}
          saveLicMeta(buildMetaFromApi(finalKey, d));
          pro = true;
          applyPlan(true);
          setMsg("⭐ ご購入ありがとうございます！有料プランが自動で有効になりました（控えメールも送信しました）。", "ok");
          return;
        }
        openModal(d.message || "自動有効化できませんでした。メールに届いたライセンスキーを入力してください。");
        return;
      } catch (e) {
        if (attempt === 4) {
          openModal("通信エラーのため自動有効化を完了できませんでした。メールに届いたライセンスキーを入力してください。");
          return;
        }
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    openModal("決済確認に時間がかかっています。数分以内に届くメールのワンタップリンクまたはキーをご利用ください。");
  }

  async function initLicense() {
    licMeta = loadLicMeta();
    const saved = normKey(localStorage.getItem(LS_KEY) || "");

    // URLパラメータ（?key=BAM-... ワンタップメール認証 ／ ?session_id=cs_... 決済直後リダイレクト）を処理
    let urlKey = "", urlSession = "";
    try {
      const url = new URL(window.location.href);
      urlKey = normKey(url.searchParams.get("key") || "");
      urlSession = String(url.searchParams.get("session_id") || "").trim();
      if (urlKey || urlSession) {
        url.searchParams.delete("key");
        url.searchParams.delete("session_id");
        window.history.replaceState(null, "", url.pathname + (url.search ? url.search : "") + url.hash);
      }
    } catch (e) {}

    if (urlKey) {
      applyPlan(false);
      try {
        await activateLicenseKey(urlKey);
        setMsg("⭐ ワンタップ認証完了：有料プランが有効になりました！", "ok");
      } catch (e) {
        $("inKey").value = urlKey;
        openModal(e.message || "ライセンスを有効化できませんでした。");
        $("keyMsg").textContent = e.message || "";
        $("keyMsg").className = "msg err";
      }
      return;
    }

    if (urlSession) {
      applyPlan(false);
      await claimSessionFromRedirect(urlSession);
      return;
    }

    // 保存済みキーがある場合、24時間以内のキャッシュがあれば初期描画のチラつきを防ぎつつ即時サーバー照合
    if (saved && licMeta && licMeta.verifiedAt && (Date.now() - licMeta.verifiedAt < OFFLINE_GRACE_MS)) {
      pro = true;
      applyPlan(true);
    } else {
      applyPlan(false);
    }
    if (saved) {
      await verifyActiveLicense({ silent: false, force: true });
    }
  }

  // ---------- モーダル ----------
  async function copySavedLicenseKey() {
    const rawSaved = normKey(localStorage.getItem(LS_KEY) || "");
    const msgEl = $("proMsg");
    if (!rawSaved) return;
    let copied = false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(rawSaved);
        copied = true;
      }
    } catch (e) {}
    if (!copied) {
      try {
        const ta = document.createElement("textarea");
        ta.value = rawSaved;
        ta.setAttribute("readonly", "");
        ta.style.cssText = "position:fixed;left:0;top:0;opacity:0";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        ta.setSelectionRange(0, rawSaved.length);
        copied = document.execCommand("copy");
        document.body.removeChild(ta);
      } catch (e) {}
    }
    if (copied) {
      msgEl.textContent = "📋 ライセンスキーをコピーしました（2台目の端末で貼り付けて有効化できます）。";
      msgEl.className = "msg ok";
    } else {
      showFullKey = true;
      syncModalView();
      msgEl.textContent = "キーを表示しました。長押しまたは選択してコピーしてください。";
      msgEl.className = "msg";
    }
  }

  function openModal(reason) {
    showFullKey = false;
    syncModalView();
    const reasonEl = $("modalReason");
    if (reason && !pro) {
      reasonEl.textContent = reason;
      reasonEl.hidden = false;
    } else {
      reasonEl.textContent = "";
      reasonEl.hidden = true;
    }
    $("keyMsg").textContent = "";
    $("keyMsg").className = "msg";
    $("proMsg").textContent = "";
    $("proMsg").className = "msg";
    $("modal").hidden = false;
    if (pro && apiBase()) {
      verifyActiveLicense({ silent: false, force: false });
    }
  }
  function requirePro(feature) {
    if (pro) return true;
    openModal(`🔒「${feature}」は有料プラン限定の機能です。`);
    return false;
  }

  // ---------- テーマ ----------
  function theme() {
    const t = THEMES[state.theme] || THEMES.dark;
    return state.theme === "custom" ? { ...t, ...state.custom } : t;
  }
  function renderThemes() {
    const box = $("themes");
    box.innerHTML = "";
    Object.entries(THEMES).forEach(([key, t]) => {
      const tt = key === "custom" ? { ...t, ...state.custom } : t;
      const b = document.createElement("button");
      b.className = "theme" + (state.theme === key ? " active" : "") + (t.pro && !pro ? " locked" : "");
      b.innerHTML = `<div class="sw" style="background:${tt.bg}"><i style="background:${tt.accent}"></i></div><span>${t.pro && !pro ? "🔒" : ""}${t.name}</span>`;
      b.onclick = () => {
        if (t.pro && !requirePro(t.name + "テーマ")) return;
        state.theme = key;
        state.preferredTheme = key;
        saveSettings();
        renderThemes();
      };
      box.appendChild(b);
    });
    $("customBox").hidden = !(pro && state.theme === "custom");
    markDirty();
  }

  // ---------- 描画ヘルパー ----------
  function rr(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function fit(ctx, text, maxW, size, min, weight) {
    const cKey = `${fontEpoch}|${weight}|${maxW}|${size}|${min}|${text}`;
    const hit = fitCache.get(cKey);
    if (hit !== undefined) {
      ctx.font = `${weight} ${hit}px ${FONT}`;
      return hit;
    }
    let cur = size;
    while (cur > min) {
      ctx.font = `${weight} ${cur}px ${FONT}`;
      if (ctx.measureText(text).width <= maxW) {
        if (fitCache.size > 512) fitCache.clear();
        fitCache.set(cKey, cur);
        return cur;
      }
      cur -= 2;
    }
    ctx.font = `${weight} ${min}px ${FONT}`;
    if (fitCache.size > 512) fitCache.clear();
    fitCache.set(cKey, min);
    return min;
  }
  function mediaSize(p) {
    if (!p.el) return null;
    const w = p.type === "video" ? p.el.videoWidth : p.el.naturalWidth;
    const h = p.type === "video" ? p.el.videoHeight : p.el.naturalHeight;
    return w && h ? { w, h } : null;
  }
  function panelRange(p, w, h) {   // 位置調整できる余白（論理px）
    const s = mediaSize(p); if (!s) return { rx: 0, ry: 0 };
    const sc = Math.max(w / s.w, h / s.h) * p.zoom;
    return { rx: Math.max(0, (s.w * sc - w) / 2), ry: Math.max(0, (s.h * sc - h) / 2) };
  }
  function shouldUseHold(p) {
    return !!(p && p.type === "video" && p.hasHold &&
      !scrubbingTrim &&
      (p.scanning || p.warming || syncingVideos || !p.el || p.el.seeking || p.el.readyState < 2));
  }
  // ---------- プロ演出・顔ぼかし・姿勢スタンプ・テンプレ制御 ----------
  function setAspect(nextAspect) {
    if (!ASPECT_SPECS[nextAspect]) return;
    state.aspect = nextAspect;
    const sp = getSpec();
    document.querySelectorAll("[data-aspect]").forEach((b) => {
      b.classList.toggle("active", b.dataset.aspect === nextAspect);
    });
    if (pv) {
      pv.dataset.aspect = nextAspect;
      if (pv.width !== sp.pvW || pv.height !== sp.pvH) {
        pv.width = sp.pvW;
        pv.height = sp.pvH;
      }
    }
    Object.keys(TEXT_SLIDERS).forEach((k) => {
      const b = textBaseFor(k);
      state.textPos[k].dy = clamp(state.textPos[k].dy, 45 - b.y, sp.LH - 45 - b.y);
    });
    ["before", "after"].forEach((w) => {
      const p = state.panels[w];
      const pf = getPanelFrame(w);
      const { rx, ry } = panelRange(p, pf.w, pf.h);
      if (rx === 0) p.ox = 0;
      if (ry === 0) p.oy = 0;
    });
    syncTextSliders();
    refreshQualityLabels();
    refreshProTrialUI();
    markDirty();
  }

  function setLayout(nextLayout) {
    if (!["split-h", "split-v", "wipe"].includes(nextLayout)) return;
    state.layout = nextLayout;
    state.wipeManual = false;
    document.querySelectorAll("[data-layout]").forEach((b) => {
      b.classList.toggle("active", b.dataset.layout === nextLayout);
    });
    ["before", "after"].forEach((w) => {
      const p = state.panels[w];
      const pf = getPanelFrame(w);
      const { rx, ry } = panelRange(p, pf.w, pf.h);
      if (rx === 0) p.ox = 0;
      if (ry === 0) p.oy = 0;
    });
    refreshProTrialUI();
    markDirty();
  }

  function refreshBlurStatusUI() {
    const chkMain = $("chkFaceBlur");
    const body = $("faceBlurBody");
    if (chkMain) chkMain.checked = state.faceBlur;
    if (body) body.hidden = !state.faceBlur;

    ["before", "after"].forEach((w) => {
      const W = cap(w);
      const p = state.panels[w];
      const b = p.blur;
      const chkEl = $("chkBlur" + W);
      const selEl = $("selBlurMode" + W);
      const szEl = $("blurSize" + W);
      const stEl = $("blurStatus" + W);
      if (chkEl) chkEl.checked = b.enabled;
      if (selEl) selEl.value = b.mode;
      if (szEl) szEl.value = String(b.scale);
      if (!stEl) return;

      stEl.className = "blur-status";
      if (!b.enabled) {
        stEl.textContent = "この枠のぼかし：オフ";
      } else if (!p.el) {
        stEl.textContent = "写真・動画を選ぶと自動検出します";
      } else if (b.status === "tracking") {
        stEl.textContent = "🔍 顔・頭の位置を解析中…";
      } else if (b.mode === "fixed") {
        stEl.textContent = "📌 位置固定中（プレビューの丸をドラッグで移動）";
        stEl.classList.add("ok");
      } else if (b.status === "ai_ok") {
        stEl.textContent = "✅ AI自動追従中（丸をドラッグで微調整可）";
        stEl.classList.add("ok");
      } else if (b.status === "patch_ok") {
        stEl.textContent = "✅ 指定した頭の位置から自動追従中";
        stEl.classList.add("ok");
      } else if (b.status === "fallback") {
        stEl.textContent = "⚠ 正面顔未検出：丸を頭にドラッグ→「今の丸の位置から追従」または「位置を固定」で調整可";
        stEl.classList.add("warn");
      } else {
        stEl.textContent = "待機中";
      }
    });
  }

  async function runFaceTrack(which, fromCurrentAnchor) {
    const p = state.panels[which];
    if (!p || !p.el || !FACE) {
      refreshBlurStatusUI();
      return;
    }
    const b = p.blur;
    const token = ++b.trackId;
    const isCancelled = () => !Object.values(state.panels).includes(p) || b.trackId !== token;

    if (p.type === "image") {
      if (fromCurrentAnchor) {
        const cur = FACE.sampleAtTime(b, 0);
        b.fixedX = cur.mx;
        b.fixedY = cur.my;
        b.baseR = cur.mr;
        b.offsetX = 0;
        b.offsetY = 0;
        b.mode = "fixed";
        b.status = "fixed";
        blurRingUntil = Date.now() + 2600;
        refreshBlurStatusUI();
        markDirty();
        return;
      }
      b.status = "tracking";
      refreshBlurStatusUI();
      const res = await FACE.trackImage(p.el, isCancelled);
      if (isCancelled() || !res) return;
      b.fixedX = res.mx;
      b.fixedY = res.my;
      b.baseR = res.mr;
      b.offsetX = 0;
      b.offsetY = 0;
      b.keyframes = res.keyframes || [];
      b.status = res.status;
      blurRingUntil = Date.now() + 2600;
      refreshBlurStatusUI();
      markDirty();
      return;
    }

    if (p.type === "video") {
      if (fromCurrentAnchor) {
        const curT = p.el ? p.el.currentTime : (p.trimStart || 0);
        const cur = FACE.sampleAtTime(b, curT);
        b.mode = "patch";
        b.status = "tracking";
        refreshBlurStatusUI();
        const res = await FACE.trackVideoFromAnchor(
          p.url,
          p.el.duration || 0,
          { t: curT, mx: cur.mx, my: cur.my, mr: cur.mr },
          isCancelled
        );
        if (isCancelled()) return;
        if (res) {
          b.fixedX = res.mx;
          b.fixedY = res.my;
          b.baseR = res.mr;
          b.offsetX = 0;
          b.offsetY = 0;
          b.keyframes = res.keyframes || [];
          b.status = "patch_ok";
        } else {
          b.mode = "fixed";
          b.fixedX = cur.mx;
          b.fixedY = cur.my;
          b.baseR = cur.mr;
          b.offsetX = 0;
          b.offsetY = 0;
          b.status = "fixed";
        }
        blurRingUntil = Date.now() + 2600;
        refreshBlurStatusUI();
        markDirty();
        return;
      }

      b.status = "tracking";
      refreshBlurStatusUI();
      const res = await FACE.trackVideoAuto(p.url, p.el.duration || 0, isCancelled);
      if (isCancelled()) return;
      if (res) {
        b.fixedX = res.mx;
        b.fixedY = res.my;
        b.baseR = res.mr;
        b.offsetX = 0;
        b.offsetY = 0;
        b.keyframes = res.keyframes || [];
        b.status = res.status;
      } else {
        b.status = "fallback";
      }
      blurRingUntil = Date.now() + 2600;
      refreshBlurStatusUI();
      markDirty();
    }
  }

  function refreshMarkerButtons() {
    const list = state.posture.markers;
    const hasArrow = list.some((m) => m.type === "arrow");
    const rotBtn = $("btnRotateMarker");
    const clrBtn = $("btnClearMarkers");
    if (rotBtn) rotBtn.hidden = !hasArrow;
    if (clrBtn) clrBtn.hidden = list.length === 0;
  }

  function addMarker(type) {
    if (state.posture.markers.length >= 12) {
      setMsg("スタンプは最大12個まで追加できます。", "err");
      return;
    }
    const idx = state.posture.markers.length;
    const stepOff = (idx % 4) * 0.055;
    const m = {
      id: markerSeq++,
      type: type === "arrow" ? "arrow" : "circle",
      nx: clamp((type === "arrow" ? 0.66 : 0.75) - stepOff * 0.6, 0.12, 0.88),
      ny: clamp(0.42 + stepOff, 0.12, 0.88),
      angle: 0,
      scale: 1
    };
    state.posture.markers.push(m);
    state.posture.selectedId = m.id;
    refreshMarkerButtons();
    refreshProTrialUI();
    markDirty();
  }

  function rotateSelectedMarker() {
    const arrows = state.posture.markers.filter((m) => m.type === "arrow");
    if (!arrows.length) return;
    let target = arrows.find((m) => m.id === state.posture.selectedId);
    if (!target) {
      target = arrows[arrows.length - 1];
      state.posture.selectedId = target.id;
    }
    target.angle = ((target.angle || 0) + 45) % 360;
    markDirty();
  }

  function clearAllMarkers() {
    state.posture.markers = [];
    state.posture.selectedId = 0;
    refreshMarkerButtons();
    refreshProTrialUI();
    markDirty();
  }

  function refreshEndCardPreviewBtn() {
    const btn = $("btnPreviewEndCard");
    if (!btn) return;
    btn.textContent = state.endCard.previewing
      ? "↩ 比較プレビューに戻る"
      : "👁 プレビューで誘導カットを確認";
  }

  function loadPresets() {
    try {
      const raw = localStorage.getItem(LS_PRESETS);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      return [];
    }
  }
  function savePresetList(arr) {
    try { localStorage.setItem(LS_PRESETS, JSON.stringify(arr.slice(0, 15))); } catch (e) {}
  }
  function renderPresets() {
    const box = $("presetList");
    if (!box) return;
    const list = loadPresets();
    box.innerHTML = "";
    if (!list.length) {
      const sp = document.createElement("span");
      sp.className = "preset-empty";
      sp.textContent = "よく使う症状・配色・演出を保存してワンタップで呼び出せます";
      box.appendChild(sp);
      return;
    }
    list.forEach((pr) => {
      const chip = document.createElement("div");
      chip.className = "preset-chip";
      const loadBtn = document.createElement("button");
      loadBtn.type = "button";
      loadBtn.className = "preset-load";
      loadBtn.textContent = "📋 " + (pr.name || "テンプレ");
      loadBtn.onclick = () => applyPreset(pr);
      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "preset-del";
      delBtn.setAttribute("aria-label", "削除");
      delBtn.textContent = "×";
      delBtn.onclick = () => deletePreset(pr.id);
      chip.appendChild(loadBtn);
      chip.appendChild(delBtn);
      box.appendChild(chip);
    });
  }

  function saveCurrentPreset() {
    if (!requirePro("症状別テンプレート保存")) return;
    const nameIn = $("inPresetName");
    const rawName = (nameIn ? nameIn.value.trim() : "") || state.symptom || "症状テンプレ";
    const name = rawName.slice(0, 20);
    const list = loadPresets();
    const entry = {
      id: "pr_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6),
      name,
      symptom: state.symptom,
      age: state.age,
      sub: state.sub,
      aspect: state.aspect,
      layout: state.layout,
      theme: state.theme,
      custom: { ...state.custom },
      textPos: JSON.parse(JSON.stringify(state.textPos)),
      faceBlur: state.faceBlur,
      postureGrid: state.posture.grid,
      postureLines: state.posture.lines,
      postureY1: state.posture.y1,
      postureY2: state.posture.y2,
      endCardEnabled: state.endCard.enabled,
      endArea: state.endCard.area,
      endOffer: state.endCard.offer,
      endCta: state.endCard.cta,
      disclaimerEnabled: state.disclaimer.enabled,
      disclaimerText: state.disclaimer.text
    };
    const existingIdx = list.findIndex((x) => x.name === name);
    if (existingIdx >= 0) list[existingIdx] = entry;
    else list.unshift(entry);
    savePresetList(list);
    if (nameIn) nameIn.value = "";
    renderPresets();
    setMsg(`💾 テンプレート「${name}」を保存しました。`, "ok");
  }

  function applyPreset(pr) {
    if (!pr) return;
    if (typeof pr.symptom === "string") { state.symptom = pr.symptom; $("inSymptom").value = pr.symptom; }
    if (typeof pr.age === "string") { state.age = pr.age; $("inAge").value = pr.age; }
    if (typeof pr.sub === "string") { state.sub = pr.sub; $("inSub").value = pr.sub; }
    if (pr.custom) {
      if (isHex(pr.custom.bg)) { state.custom.bg = pr.custom.bg; $("cBg").value = pr.custom.bg; }
      if (isHex(pr.custom.text)) { state.custom.text = pr.custom.text; $("cText").value = pr.custom.text; }
      if (isHex(pr.custom.accent)) { state.custom.accent = pr.custom.accent; $("cAccent").value = pr.custom.accent; }
    }
    if (pr.theme && THEMES[pr.theme]) {
      state.preferredTheme = pr.theme;
      state.theme = (THEMES[pr.theme].pro && !pro) ? "dark" : pr.theme;
    }
    if (pr.aspect && ASPECT_SPECS[pr.aspect]) setAspect(pr.aspect);
    if (pr.layout) setLayout(pr.layout);
    if (pr.textPos) {
      const g = getGeom();
      Object.keys(TEXT_SLIDERS).forEach((k) => {
        const tp = pr.textPos[k], b = textBaseFor(k);
        if (tp && typeof tp.dx === "number") state.textPos[k].dx = clamp(Math.round(tp.dx), 80 - b.x, LW - 80 - b.x);
        if (tp && typeof tp.dy === "number") state.textPos[k].dy = clamp(Math.round(tp.dy), 45 - b.y, g.LH - 45 - b.y);
      });
      syncTextSliders();
    }
    if (typeof pr.faceBlur === "boolean") {
      state.faceBlur = pr.faceBlur;
      refreshBlurStatusUI();
      if (state.faceBlur) {
        ["before", "after"].forEach((w) => {
          const p = state.panels[w];
          if (p.el && p.blur.status === "idle") p.blur.trackPromise = runFaceTrack(w, false);
        });
      }
    }
    if (typeof pr.postureGrid === "boolean") {
      state.posture.grid = pr.postureGrid;
      $("chkPostureGrid").checked = pr.postureGrid;
    }
    if (typeof pr.postureLines === "boolean") {
      state.posture.lines = pr.postureLines;
      $("chkPostureLines").checked = pr.postureLines;
    }
    if (typeof pr.postureY1 === "number") state.posture.y1 = clamp(pr.postureY1, 0.04, 0.96);
    if (typeof pr.postureY2 === "number") state.posture.y2 = clamp(pr.postureY2, 0.04, 0.96);
    if (typeof pr.endCardEnabled === "boolean") {
      state.endCard.enabled = pr.endCardEnabled;
      state.endCard.previewing = false;
      $("chkEndCard").checked = pr.endCardEnabled;
      $("endCardBody").hidden = !pr.endCardEnabled;
      refreshEndCardPreviewBtn();
    }
    if (typeof pr.endArea === "string") { state.endCard.area = pr.endArea; $("inEndArea").value = pr.endArea; }
    if (typeof pr.endOffer === "string") { state.endCard.offer = pr.endOffer; $("inEndOffer").value = pr.endOffer; }
    if (typeof pr.endCta === "string" && pr.endCta) { state.endCard.cta = pr.endCta; $("inEndCta").value = pr.endCta; }
    if (typeof pr.disclaimerEnabled === "boolean") {
      state.disclaimer.enabled = pr.disclaimerEnabled;
      $("chkDisclaimer").checked = pr.disclaimerEnabled;
      $("disclaimerBody").hidden = !pr.disclaimerEnabled;
    }
    if (typeof pr.disclaimerText === "string" && pr.disclaimerText) {
      state.disclaimer.text = pr.disclaimerText;
      $("inDisclaimer").value = pr.disclaimerText;
    }
    captionEdited = false;
    syncAutoCaption();
    renderThemes();
    refreshBgmUI();
    refreshProTrialUI();
    saveSettings();
    markDirty();
    setMsg(`📋 テンプレート「${pr.name}」を反映しました。`, "ok");
  }

  function deletePreset(id) {
    const list = loadPresets().filter((x) => x.id !== id);
    savePresetList(list);
    renderPresets();
  }

  function resetProOnlyFeatures() {
    setAspect("9:16");
    setLayout("split-h");
    state.faceBlur = false;
    refreshBlurStatusUI();

    state.posture.grid = false;
    state.posture.lines = false;
    state.posture.markers = [];
    state.posture.selectedId = 0;
    if ($("chkPostureGrid")) $("chkPostureGrid").checked = false;
    if ($("chkPostureLines")) $("chkPostureLines").checked = false;
    refreshMarkerButtons();

    state.endCard.enabled = false;
    state.endCard.previewing = false;
    if ($("chkEndCard")) $("chkEndCard").checked = false;
    if ($("endCardBody")) $("endCardBody").hidden = true;
    refreshEndCardPreviewBtn();

    state.disclaimer.enabled = false;
    if ($("chkDisclaimer")) $("chkDisclaimer").checked = false;
    if ($("disclaimerBody")) $("disclaimerBody").hidden = true;

    state.snsFooter = "";
    if ($("inSnsFooter")) $("inSnsFooter").value = "";
    captionEdited = false;
    syncAutoCaption();

    if ($("modal")) $("modal").hidden = true;
    refreshBgmUI();
    refreshProTrialUI();
    markDirty();
    setMsg("有料機能をオフに戻しました。このまま無料プランで保存・SNS投稿できます。", "ok");
  }

  function computeBlurGeom(which, visRect) {
    const p = state.panels[which];
    if (!p || !p.el || !p.blur || !p.blur.enabled || !FACE) return null;
    const s = mediaSize(p);
    if (!s) return null;
    const frame = getPanelFrame(which);
    const sc = Math.max(frame.w / s.w, frame.h / s.h) * p.zoom;
    const dw = s.w * sc, dh = s.h * sc;
    const rangeX = Math.max(0, (dw - frame.w) / 2);
    const rangeY = Math.max(0, (dh - frame.h) / 2);
    const dx = frame.x + (frame.w - dw) / 2 + p.ox * rangeX;
    const dy = frame.y + (frame.h - dh) / 2 + p.oy * rangeY;
    const mediaT = (p.type === "video" && p.el) ? p.el.currentTime : 0;
    const smp = FACE.sampleAtTime(p.blur, mediaT);
    const cx = dx + smp.mx * dw;
    const cy = dy + smp.my * dh;
    const baseR = smp.mr * Math.min(dw, dh) * (p.blur.scale || 1);
    return {
      cx,
      cy,
      rx: Math.max(16, baseR * 0.92),
      ry: Math.max(19, baseR * 1.16),
      dw,
      dh,
      smp,
      clipRect: visRect || frame
    };
  }

  function drawMedia(ctx, p, x, y, w, h, th, placeholder, label, visRect) {
    const vis = visRect || { x, y, w, h };
    if (vis.w <= 0.5 || vis.h <= 0.5) return;
    const s = mediaSize(p);
    if (s) {
      const useHold = shouldUseHold(p);
      const src = useHold ? p.holdCanvas : p.el;
      const srcW = useHold ? p.holdCanvas.width : s.w;
      const srcH = useHold ? p.holdCanvas.height : s.h;
      if (src && srcW > 0 && srcH > 0) {
        // ctx.clip() を使わず9引数のソース矩形切り出しで描画し、4K動画やスライド比較のクリップ負荷をゼロ化
        const sc = Math.max(w / srcW, h / srcH) * p.zoom;
        const dw = srcW * sc, dh = srcH * sc;
        const rx = Math.max(0, (dw - w) / 2), ry = Math.max(0, (dh - h) / 2);
        const dx = x + (w - dw) / 2 + p.ox * rx;
        const dy = y + (h - dh) / 2 + p.oy * ry;
        const sx = clamp((vis.x - dx) / sc, 0, srcW);
        const sy = clamp((vis.y - dy) / sc, 0, srcH);
        const sw = clamp(vis.w / sc, 0, Math.max(0, srcW - sx));
        const sh = clamp(vis.h / sc, 0, Math.max(0, srcH - sy));
        if (sw > 0 && sh > 0) {
          ctx.drawImage(src, sx, sy, sw, sh, vis.x, vis.y, vis.w, vis.h);
        }
      }
      if (placeholder && (p.scanning || p.warming) && vis.w > 180) {
        const bw = Math.min(vis.w - 40, 440);
        const bx = vis.x + (vis.w - bw) / 2;
        ctx.fillStyle = "rgba(0,0,0,0.58)";
        rr(ctx, bx, vis.y + vis.h / 2 - 44, bw, 88, 22);
        ctx.fill();
        ctx.fillStyle = "#fff";
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.font = `700 28px ${FONT}`;
        ctx.fillText(p.scanning ? "🚶 動き始めを解析中…" : "▶ 再生を準備中…", vis.x + vis.w / 2, vis.y + vis.h / 2 + 2);
      }
    } else {
      ctx.fillStyle = "rgba(128,128,128,0.18)";
      ctx.fillRect(vis.x, vis.y, vis.w, vis.h);
      if (placeholder && vis.w > 150) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(vis.x, vis.y, vis.w, vis.h);
        ctx.clip();
        ctx.fillStyle = "rgba(160,160,160,0.9)";
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.font = `700 46px ${FONT}`;
        ctx.fillText(label, vis.x + vis.w / 2, vis.y + vis.h / 2 - 28);
        ctx.font = `500 32px ${FONT}`;
        ctx.fillText("画像・動画を追加", vis.x + vis.w / 2, vis.y + vis.h / 2 + 32);
        ctx.restore();
      }
    }
  }

  function badge(ctx, text, x, y, color, textColor, g, alignRight) {
    const fSz = (g && g.fonts && g.fonts.badge) ? g.fonts.badge[0] : 54;
    const h = (g && g.fonts && g.fonts.badge) ? g.fonts.badge[1] : 84;
    ctx.font = `900 ${fSz}px ${FONT}`;
    const w = ctx.measureText(text).width + Math.round(fSz * 1.04);
    const drawX = alignRight ? x - w : x;
    ctx.fillStyle = color;
    rr(ctx, drawX, y, w, h, 16);
    ctx.fill();
    ctx.fillStyle = textColor;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(text, drawX + w / 2, y + h / 2 + 2);
  }

  function drawPostureLayer(c, g, opt) {
    if (!state.posture.grid && !state.posture.lines && state.posture.markers.length === 0) return;
    c.save();
    c.beginPath();
    c.rect(0, g.panelY, LW, g.panelH);
    c.clip();

    // 1. 方眼グリッド＋中心垂線
    if (state.posture.grid) {
      const step = 90;
      c.lineWidth = 2;
      c.strokeStyle = "rgba(0,0,0,0.28)";
      c.beginPath();
      for (let x = step; x < LW; x += step) { c.moveTo(x + 1, g.panelY); c.lineTo(x + 1, g.bottomY); }
      for (let y = g.panelY + step; y < g.bottomY; y += step) { c.moveTo(0, y + 1); c.lineTo(LW, y + 1); }
      c.stroke();

      c.strokeStyle = "rgba(255,255,255,0.34)";
      c.beginPath();
      for (let x = step; x < LW; x += step) { c.moveTo(x, g.panelY); c.lineTo(x, g.bottomY); }
      for (let y = g.panelY + step; y < g.bottomY; y += step) { c.moveTo(0, y); c.lineTo(LW, y); }
      c.stroke();

      // 各パネルの体幹中心線（重心ライン）
      c.save();
      c.strokeStyle = "rgba(56,232,255,0.78)";
      c.lineWidth = 3.5;
      c.setLineDash([16, 12]);
      c.beginPath();
      if (state.layout === "split-h") {
        const pw = (LW - GAP) / 2;
        c.moveTo(pw / 2, g.panelY); c.lineTo(pw / 2, g.bottomY);
        c.moveTo(pw + GAP + pw / 2, g.panelY); c.lineTo(pw + GAP + pw / 2, g.bottomY);
      } else {
        c.moveTo(LW / 2, g.panelY); c.lineTo(LW / 2, g.bottomY);
      }
      c.stroke();
      c.restore();
    }

    // 2. 肩・骨盤の高さ比較ライン（上下ドラッグ対応）
    if (state.posture.lines) {
      const defs = [
        { ny: state.posture.y1, color: "#38e8ff", tag: "肩・耳ライン" },
        { ny: state.posture.y2, color: "#ffd24a", tag: "骨盤・腰ライン" }
      ];
      defs.forEach((ln) => {
        const ly = Math.round(g.panelY + clamp(ln.ny, 0.04, 0.96) * g.panelH);
        c.save();
        c.strokeStyle = "rgba(0,0,0,0.58)";
        c.lineWidth = 9;
        c.beginPath(); c.moveTo(0, ly); c.lineTo(LW, ly); c.stroke();

        c.strokeStyle = ln.color;
        c.lineWidth = 5;
        c.beginPath(); c.moveTo(0, ly); c.lineTo(LW, ly); c.stroke();

        if (opt.preview) {
          c.font = `700 22px ${FONT}`;
          const tw = c.measureText(ln.tag).width + 24;
          c.fillStyle = "rgba(15,17,21,0.84)";
          rr(c, 16, ly - 38, tw, 32, 10);
          c.fill();
          c.fillStyle = ln.color;
          c.textAlign = "left";
          c.textBaseline = "middle";
          c.fillText(ln.tag, 28, ly - 21);
        }
        c.restore();
      });
    }

    // 3. 注目スタンプ（赤丸・8方向回転矢印）
    state.posture.markers.forEach((m) => {
      const mx = clamp(m.nx, 0.04, 0.96) * LW;
      const my = g.panelY + clamp(m.ny, 0.04, 0.96) * g.panelH;
      const sc = clamp(m.scale || 1, 0.55, 2.0);
      c.save();
      c.translate(mx, my);
      if (m.type === "arrow") {
        c.rotate(((m.angle || 0) * Math.PI) / 180);
        c.scale(sc, sc);
        c.beginPath();
        c.moveTo(58, 0);
        c.lineTo(6, -42);
        c.lineTo(6, -18);
        c.lineTo(-58, -18);
        c.lineTo(-58, 18);
        c.lineTo(6, 18);
        c.lineTo(6, 42);
        c.closePath();
        c.lineJoin = "round";
        c.strokeStyle = "rgba(255,255,255,0.95)";
        c.lineWidth = 12;
        c.stroke();
        c.fillStyle = "#ff2638";
        c.fill();
      } else {
        const r = 74 * sc;
        c.beginPath();
        c.arc(0, 0, r, 0, Math.PI * 2);
        c.strokeStyle = "rgba(255,255,255,0.92)";
        c.lineWidth = 15;
        c.stroke();
        c.strokeStyle = "#ff2638";
        c.lineWidth = 9;
        c.stroke();
      }
      c.restore();
    });

    c.restore();
  }

  // ---------- 静的オーバーレイキャッシュ＆エンドカードキャッシュ ----------
  const textBoxes = { symptom: null, age: null, clinic: null, sub: null };
  const overlaySlots = {
    preview: { key: "", canvas: null, ctx: null },
    export:  { key: "", canvas: null, ctx: null }
  };
  const endCardSlot = { key: "", canvas: null, ctx: null };

  function serializePostureKey() {
    return [
      state.posture.grid ? 1 : 0,
      state.posture.lines ? `${state.posture.y1.toFixed(4)},${state.posture.y2.toFixed(4)}` : "0",
      state.posture.markers.map((m) => `${m.id}:${m.type}:${m.nx.toFixed(4)}:${m.ny.toFixed(4)}:${m.angle}:${m.scale}`).join(";")
    ].join("|");
  }

  function getOverlayCanvas(W, H, opt) {
    const g = getGeom();
    const slot = opt.preview ? overlaySlots.preview : overlaySlots.export;
    const hasValidLogo = !!(state.logo && pro && state.logo.naturalWidth > 0 && state.logo.naturalHeight > 0);
    const discText = state.disclaimer.enabled ? (state.disclaimer.text || "").trim() : "";
    const key = [
      W, H,
      state.aspect,
      state.layout,
      opt.preview ? 1 : 0,
      opt.guide ? 1 : 0,
      opt.noWatermark ? 1 : 0,
      pro ? 1 : 0,
      fontEpoch,
      state.theme,
      state.theme === "custom" ? `${state.custom.bg},${state.custom.text},${state.custom.accent}` : "",
      hasValidLogo ? (logoUrl || "1") : "0",
      state.symptom,
      state.age,
      state.clinic,
      state.sub,
      discText,
      serializePostureKey(),
      state.textPos.symptom.dx, state.textPos.symptom.dy,
      state.textPos.age.dx, state.textPos.age.dy,
      state.textPos.clinic.dx, state.textPos.clinic.dy,
      state.textPos.sub.dx, state.textPos.sub.dy
    ].join("\x1f");

    if (slot.canvas && slot.key === key) {
      return slot.canvas;
    }

    if (!slot.canvas) {
      slot.canvas = document.createElement("canvas");
      slot.ctx = slot.canvas.getContext("2d");
    }
    if (slot.canvas.width !== W || slot.canvas.height !== H) {
      slot.canvas.width = W;
      slot.canvas.height = H;
    }

    const c = slot.ctx;
    const th = theme();
    c.save();
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, W, H);
    c.setTransform(W / LW, 0, 0, H / g.LH, 0, 0);

    // 姿勢チェック基準線・注目スタンプ（映像窓の上に重なり、上下文字帯の下に収まる）
    drawPostureLayer(c, g, opt);

    // 上部帯・下部帯・分割仕切り線を描画
    c.fillStyle = th.bg;
    c.fillRect(0, 0, LW, g.panelY);
    c.fillRect(0, g.bottomY, LW, g.LH - g.bottomY);
    if (state.layout === "split-h") {
      const pw = (LW - GAP) / 2;
      c.fillRect(pw, g.panelY, GAP, g.panelH);
      badge(c, "BEFORE", 24, g.panelY + 20, "rgba(70,76,88,0.92)", "#fff", g, false);
      badge(c, "AFTER", pw + GAP + 24, g.panelY + 20, th.accent, "#fff", g, false);
    } else if (state.layout === "split-v") {
      const h1 = Math.floor((g.panelH - GAP) / 2);
      c.fillRect(0, g.panelY + h1, LW, GAP);
      badge(c, "BEFORE", 24, g.panelY + 18, "rgba(70,76,88,0.92)", "#fff", g, false);
      badge(c, "AFTER", 24, g.panelY + h1 + GAP + 18, th.accent, "#fff", g, false);
    } else {
      badge(c, "BEFORE", 24, g.panelY + 20, "rgba(70,76,88,0.92)", "#fff", g, false);
      badge(c, "AFTER", LW - 24, g.panelY + 20, th.accent, "#fff", g, true);
    }

    // 上部テキスト：症状・年齢
    c.textAlign = "center"; c.textBaseline = "middle";
    const symptom = state.symptom || (opt.preview ? "症状を入力" : "");
    if (symptom) {
      const { x: sx, y: sy } = textXY("symptom");
      c.fillStyle = state.symptom ? th.text : "rgba(160,160,160,0.7)";
      const sz = fit(c, symptom, 960, g.fonts.symptom[0], g.fonts.symptom[1], 900);
      c.fillText(symptom, sx, sy);
      if (opt.preview) {
        const tw = Math.max(240, c.measureText(symptom).width);
        textBoxes.symptom = { x: sx - tw / 2 - 24, y: sy - sz / 2 - 20, w: tw + 48, h: sz + 40 };
      }
    } else if (opt.preview) {
      textBoxes.symptom = null;
    }

    const age = state.age || (opt.preview ? "年齢・属性" : "");
    if (age) {
      const { x: ax, y: ay } = textXY("age");
      const sz = fit(c, age, 800, g.fonts.age[0], g.fonts.age[1], 700);
      const tw = c.measureText(age).width + 76, ph = sz + g.fonts.age[2];
      c.fillStyle = state.age ? th.accent : "rgba(160,160,160,0.35)";
      rr(c, ax - tw / 2, ay - ph / 2 + 2, tw, ph, ph / 2); c.fill();
      c.fillStyle = "#fff"; c.textAlign = "center"; c.textBaseline = "middle";
      c.fillText(age, ax, ay + 2);
      if (opt.preview) {
        textBoxes.age = { x: ax - tw / 2 - 16, y: ay - ph / 2 - 12, w: tw + 32, h: ph + 24 };
      }
    } else if (opt.preview) {
      textBoxes.age = null;
    }

    // 下部テキスト：院名（ロゴは左）・補足
    const clinic = state.clinic || (opt.preview ? "院名を入力" : "");
    const { x: cx, y: cy } = textXY("clinic");
    const maxLogoH = g.fonts.clinic[2];
    let clinicHalfH = -24;
    if (clinic) {
      c.textAlign = "center"; c.textBaseline = "middle";
      let maxW = 960, logoW = 0;
      if (hasValidLogo) {
        logoW = Math.min(state.logo.naturalWidth / state.logo.naturalHeight * maxLogoH, 240);
        maxW = 960 - logoW - 26;
      }
      const sz = fit(c, clinic, maxW, g.fonts.clinic[0], g.fonts.clinic[1], 900);
      clinicHalfH = Math.max(sz / 2, logoW ? maxLogoH / 2 : 34);
      const tw = c.measureText(clinic).width;
      const total = tw + (logoW ? logoW + 26 : 0);
      const left = cx - total / 2;
      if (logoW) {
        const lh = logoW / (state.logo.naturalWidth / state.logo.naturalHeight);
        c.drawImage(state.logo, left, cy - lh / 2, logoW, lh);
      }
      c.textAlign = "left";
      c.fillStyle = state.clinic ? th.text : "rgba(160,160,160,0.7)";
      c.fillText(clinic, left + (logoW ? logoW + 26 : 0), cy + 2);
      if (opt.preview) {
        const bh = Math.max(sz + 32, logoW ? maxLogoH + 12 : 84);
        const bw = Math.max(240, total + 48);
        textBoxes.clinic = { x: cx - bw / 2, y: cy - bh / 2, w: bw, h: bh };
      }
    } else if (hasValidLogo) {
      const lh = maxLogoH, lw = Math.min(state.logo.naturalWidth / state.logo.naturalHeight * lh, 380);
      clinicHalfH = lh / 2;
      c.drawImage(state.logo, cx - lw / 2, cy - lh / 2, lw, lh);
      if (opt.preview) {
        textBoxes.clinic = { x: cx - lw / 2 - 20, y: cy - lh / 2 - 16, w: lw + 40, h: lh + 32 };
      }
    } else if (opt.preview) {
      textBoxes.clinic = null;
    }

    let subBoxY = null, subHalfH = 0;
    if (state.sub) {
      const { x: sx, y: sy } = textXY("sub");
      c.textAlign = "center"; c.textBaseline = "middle";
      c.fillStyle = th.text; c.globalAlpha = 0.82;
      const sz = fit(c, state.sub, 940, g.fonts.sub[0], g.fonts.sub[1], 500);
      c.fillText(state.sub, sx, sy);
      c.globalAlpha = 1;
      subBoxY = sy;
      subHalfH = sz / 2;
      if (opt.preview) {
        const tw = Math.max(200, c.measureText(state.sub).width);
        textBoxes.sub = { x: sx - tw / 2 - 24, y: sy - sz / 2 - 20, w: tw + 48, h: sz + 40 };
      }
    } else if (opt.preview) {
      textBoxes.sub = null;
    }

    // 免責ミニテロップ（「※施術効果には個人差があります」等）
    if (discText) {
      c.save();
      c.textAlign = "center";
      c.textBaseline = "middle";
      c.fillStyle = th.text;
      c.globalAlpha = 0.72;
      fit(c, discText, 980, g.fonts.disclaimer[0], g.fonts.disclaimer[1], 500);
      c.fillText(discText, LW / 2, g.disclaimerY);
      c.restore();
    }

    // 透かし（無料プラン：院名の下に表示）
    if (!pro && !opt.noWatermark) {
      c.save();
      c.font = `700 30px ${FONT}`;
      const wmText = CFG.WATERMARK_TEXT || "BAメーカー 無料版";
      const tw = c.measureText(wmText).width;
      const pw = tw + 50, ph = 50;
      const wmX = clamp(cx, pw / 2 + 24, LW - pw / 2 - 24);
      const bottomLimit = discText ? g.disclaimerY - 38 : g.LH - 22;
      let wmY = cy + clinicHalfH + 40;
      if (subBoxY !== null && Math.abs(subBoxY - wmY) < 52) {
        wmY = subBoxY + subHalfH + 38;
      }
      if (wmY + ph / 2 > bottomLimit) {
        wmY = Math.max(ph / 2 + 24, cy - Math.max(38, clinicHalfH) - 38);
      }
      c.fillStyle = th.bg;
      c.globalAlpha = 0.75;
      rr(c, wmX - pw / 2, wmY - ph / 2, pw, ph, ph / 2);
      c.fill();
      c.strokeStyle = th.text;
      c.globalAlpha = 0.35;
      c.lineWidth = 2;
      c.stroke();
      c.fillStyle = th.text;
      c.globalAlpha = 0.88;
      c.textAlign = "center";
      c.textBaseline = "middle";
      c.fillText(wmText, wmX, wmY + 2);
      c.restore();
    }

    // 安全域ガイド（プレビューのみ）
    if (opt.guide) {
      c.fillStyle = "rgba(255,0,0,0.18)";
      const topSafe = Math.round(g.LH * 0.065);
      const botSafe = Math.round(g.LH * 0.855);
      c.fillRect(0, 0, LW, topSafe);
      c.fillRect(0, botSafe, LW, g.LH - botSafe);
      c.fillRect(960, Math.round(g.LH * 0.52), 120, botSafe - Math.round(g.LH * 0.52));
      c.fillStyle = "#fff"; c.font = `500 26px ${FONT}`; c.textAlign = "center";
      c.fillText("SNSのUIで隠れやすい範囲（目安）", LW / 2, g.LH - 26);
    }

    c.restore();
    slot.key = key;
    return slot.canvas;
  }

  /**
   * 動画ラスト2秒の「予約・LINE誘導エンドカード」（リール視聴スマホ特化・QRコードなし）
   */
  function getEndCardCanvas(W, H, opt) {
    const g = getGeom();
    const th = theme();
    const hasValidLogo = !!(state.logo && pro && state.logo.naturalWidth > 0 && state.logo.naturalHeight > 0);
    const areaText = (state.endCard.area || "").trim();
    const offerText = (state.endCard.offer || "").trim() ||
      (state.symptom ? `「${state.symptom}」のお悩みはお気軽にご相談ください` : "つらい痛み・姿勢のお悩みはお任せください");
    const ctaText = (state.endCard.cta || "").trim() || "ご予約はプロフィールの公式LINEから ▶";
    const clinicText = (state.clinic || "").trim() || "ご予約・ご相談受付中";
    const discText = state.disclaimer.enabled ? (state.disclaimer.text || "").trim() : "";

    const key = [
      W, H, state.aspect, pro ? 1 : 0, opt && opt.noWatermark ? 1 : 0, fontEpoch,
      state.theme,
      state.theme === "custom" ? `${state.custom.bg},${state.custom.text},${state.custom.accent}` : "",
      hasValidLogo ? (logoUrl || "1") : "0",
      clinicText, areaText, offerText, ctaText, discText
    ].join("\x1f");

    if (endCardSlot.canvas && endCardSlot.key === key) {
      return endCardSlot.canvas;
    }
    if (!endCardSlot.canvas) {
      endCardSlot.canvas = document.createElement("canvas");
      endCardSlot.ctx = endCardSlot.canvas.getContext("2d");
    }
    if (endCardSlot.canvas.width !== W || endCardSlot.canvas.height !== H) {
      endCardSlot.canvas.width = W;
      endCardSlot.canvas.height = H;
    }

    const c = endCardSlot.ctx;
    const LH = g.LH;
    const isShort = LH <= 1150;
    const isMid = LH <= 1400 && !isShort;
    const kS = isShort ? 0.72 : (isMid ? 0.84 : 1);

    c.save();
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, W, H);
    c.setTransform(W / LW, 0, 0, H / LH, 0, 0);

    // ベース背景＋アクセント光彩
    c.fillStyle = th.bg;
    c.fillRect(0, 0, LW, LH);
    const grad = c.createRadialGradient(LW / 2, LH * 0.42, 40, LW / 2, LH * 0.48, LW * 0.85);
    grad.addColorStop(0, "rgba(255,255,255,0.08)");
    grad.addColorStop(1, "rgba(0,0,0,0.22)");
    c.fillStyle = grad;
    c.fillRect(0, 0, LW, LH);

    // 中央カード枠
    const cardX = 56;
    const cardW = LW - 112;
    const cardY = Math.round(LH * (isShort ? 0.08 : 0.14));
    const cardH = Math.round(LH * (isShort ? 0.82 : 0.72));
    c.fillStyle = "rgba(18,21,28,0.86)";
    rr(c, cardX, cardY, cardW, cardH, 42);
    c.fill();
    c.strokeStyle = th.accent;
    c.lineWidth = 4;
    c.stroke();

    let curY = cardY + Math.round(92 * kS);

    // 地域・最寄り駅ピル
    if (areaText) {
      const sz = fit(c, "📍 " + areaText, cardW - 120, Math.round(44 * kS), 24, 700);
      const pw = c.measureText("📍 " + areaText).width + 68;
      const ph = sz + Math.round(32 * kS);
      c.fillStyle = "rgba(255,255,255,0.12)";
      rr(c, LW / 2 - pw / 2, curY - ph / 2, pw, ph, ph / 2);
      c.fill();
      c.fillStyle = "#ffffff";
      c.textAlign = "center";
      c.textBaseline = "middle";
      c.fillText("📍 " + areaText, LW / 2, curY + 2);
      curY += Math.round(118 * kS);
    } else {
      curY += Math.round(34 * kS);
    }

    // 院ロゴ（有効時）
    if (hasValidLogo) {
      const lh = Math.round(130 * kS);
      const lw = Math.min(state.logo.naturalWidth / state.logo.naturalHeight * lh, 320);
      const realH = lw / (state.logo.naturalWidth / state.logo.naturalHeight);
      c.drawImage(state.logo, LW / 2 - lw / 2, curY - realH / 2, lw, realH);
      curY += Math.round(126 * kS);
    }

    // 院名
    c.fillStyle = "#ffffff";
    c.textAlign = "center";
    c.textBaseline = "middle";
    fit(c, clinicText, cardW - 96, Math.round(88 * kS), 38, 900);
    c.fillText(clinicText, LW / 2, curY);
    curY += Math.round(78 * kS);

    // アクセント区切りバー
    c.fillStyle = th.accent;
    rr(c, LW / 2 - 90, curY, 180, 8, 4);
    c.fill();
    curY += Math.round(108 * kS);

    // 初回オファー・見出しボックス
    const boxW = cardW - 88;
    const boxH = Math.round(176 * kS);
    c.fillStyle = "rgba(255,255,255,0.08)";
    rr(c, LW / 2 - boxW / 2, curY - boxH / 2, boxW, boxH, 26);
    c.fill();
    c.strokeStyle = "rgba(255,255,255,0.22)";
    c.lineWidth = 2;
    c.stroke();

    c.fillStyle = "#ffd966";
    c.textAlign = "center";
    c.textBaseline = "middle";
    fit(c, offerText, boxW - 56, Math.round(54 * kS), 26, 900);
    c.fillText(offerText, LW / 2, curY + 2);

    // 下部 LINE / 予約誘導ボタン（スマホ視聴者がそのままプロフィールへ行けるデザイン）
    const btnW = cardW - 84;
    const btnH = Math.round(132 * kS);
    const btnY = cardY + cardH - Math.round(190 * kS);
    c.fillStyle = "#06c755";
    rr(c, LW / 2 - btnW / 2, btnY - btnH / 2, btnW, btnH, btnH / 2);
    c.fill();

    c.fillStyle = "#ffffff";
    c.textAlign = "center";
    c.textBaseline = "middle";
    fit(c, ctaText, btnW - 72, Math.round(48 * kS), 26, 900);
    c.fillText(ctaText, LW / 2, btnY + 2);

    c.fillStyle = "rgba(255,255,255,0.78)";
    c.font = `700 ${Math.round(28 * kS)}px ${FONT}`;
    c.fillText("▲ アイコンをタップしてプロフィールのリンクへ", LW / 2, btnY + btnH / 2 + Math.round(46 * kS));

    if (discText) {
      c.fillStyle = "rgba(255,255,255,0.68)";
      fit(c, discText, 960, g.fonts.disclaimer[0], g.fonts.disclaimer[1], 500);
      c.fillText(discText, LW / 2, g.disclaimerY);
    }

    if (!pro && !(opt && opt.noWatermark)) {
      c.fillStyle = "rgba(255,255,255,0.75)";
      c.font = `700 28px ${FONT}`;
      c.fillText((CFG.WATERMARK_TEXT || "BAメーカー 無料版") + "（お試しプレビュー）", LW / 2, cardY - 26);
    }

    c.restore();
    endCardSlot.key = key;
    return endCardSlot.canvas;
  }

  function drawWipeBar(c, g, splitX, th) {
    c.save();
    c.strokeStyle = "rgba(0,0,0,0.5)";
    c.lineWidth = 10;
    c.beginPath(); c.moveTo(splitX, g.panelY); c.lineTo(splitX, g.bottomY); c.stroke();

    c.strokeStyle = "#ffffff";
    c.lineWidth = 5;
    c.beginPath(); c.moveTo(splitX, g.panelY); c.lineTo(splitX, g.bottomY); c.stroke();

    const hy = g.panelY + g.panelH * 0.5;
    c.beginPath();
    c.arc(splitX, hy, 42, 0, Math.PI * 2);
    c.fillStyle = th.accent;
    c.fill();
    c.lineWidth = 5;
    c.strokeStyle = "#ffffff";
    c.stroke();

    c.fillStyle = "#ffffff";
    c.font = `900 28px ${FONT}`;
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.fillText("◀▶", splitX, hy + 2);
    c.restore();
  }

  function render(c, W, H, opt) {
    opt = opt || {};
    const g = getGeom();
    const th = theme();

    // エンドカード単体プレビュー中または完全フェード後
    const previewEndOnly = !!(opt.preview && state.endCard.enabled && state.endCard.previewing);
    const endAlpha = previewEndOnly ? 1 : clamp(Number(opt.endCardAlpha) || 0, 0, 1);

    if (endAlpha >= 0.999) {
      const ec = getEndCardCanvas(W, H, opt);
      c.save();
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.drawImage(ec, 0, 0);
      c.restore();
      return;
    }

    const ov = getOverlayCanvas(W, H, opt);

    c.save();
    c.setTransform(W / LW, 0, 0, H / g.LH, 0, 0);

    // ベース背景
    c.fillStyle = th.bg;
    c.fillRect(0, 0, LW, g.LH);

    // 中央：レイアウト別の比較映像／画像描画
    let beforeVis = null, afterVis = null, splitX = 0;
    if (state.layout === "wipe") {
      const ratio = getWipeRatio(opt);
      splitX = Math.round(LW * ratio);
      const full = { x: 0, y: g.panelY, w: LW, h: g.panelH };
      beforeVis = { x: 0, y: g.panelY, w: splitX, h: g.panelH };
      afterVis = { x: splitX, y: g.panelY, w: LW - splitX, h: g.panelH };
      drawMedia(c, state.panels.before, full.x, full.y, full.w, full.h, th, opt.preview, "BEFORE", beforeVis);
      drawMedia(c, state.panels.after, full.x, full.y, full.w, full.h, th, opt.preview, "AFTER", afterVis);
    } else {
      beforeVis = getPanelFrame("before");
      afterVis = getPanelFrame("after");
      drawMedia(c, state.panels.before, beforeVis.x, beforeVis.y, beforeVis.w, beforeVis.h, th, opt.preview, "BEFORE", beforeVis);
      drawMedia(c, state.panels.after, afterVis.x, afterVis.y, afterVis.w, afterVis.h, th, opt.preview, "AFTER", afterVis);
    }

    // 患者様の顔ぼかし描画（動画・写真のフレームに追従し、バッジや基準線より下に合成）
    if (state.faceBlur && FACE) {
      const showRing = !!(opt.preview && (
        (drag && drag.kind === "blur") ||
        Date.now() < blurRingUntil ||
        !state.playing
      ));
      [["before", beforeVis], ["after", afterVis]].forEach(([w, vis]) => {
        const bg = computeBlurGeom(w, vis);
        if (!bg) return;
        FACE.drawSmoothOvalBlur(c, W, H, LW, g.LH, bg.clipRect, { x: bg.cx, y: bg.cy }, { rx: bg.rx, ry: bg.ry });
        if (showRing || (opt.preview && state.panels[w].blur.status === "fallback")) {
          const isActive = !!(drag && drag.kind === "blur" && drag.which === w);
          FACE.drawPreviewRing(c, W, H, LW, g.LH, bg.clipRect, { x: bg.cx, y: bg.cy }, { rx: bg.rx, ry: bg.ry }, isActive);
        }
      });
    }

    // キャッシュ済み文字・基準線・スタンプ・バッジ・透かしレイヤーを1回のGPUテクスチャ転送で合成
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.drawImage(ov, 0, 0);

    // スライド比較時のワイプ境界バー＆◀▶ハンドル
    if (state.layout === "wipe") {
      c.setTransform(W / LW, 0, 0, H / g.LH, 0, 0);
      drawWipeBar(c, g, splitX, th);
    }

    // 文字ドラッグ中のガイド線（プレビュードラッグ中のみ描画）
    if (opt.preview && drag && drag.kind === "text") {
      c.setTransform(W / LW, 0, 0, H / g.LH, 0, 0);
      if (state.textPos[drag.key].dx === 0) {
        c.strokeStyle = "rgba(53,194,138,0.75)";
        c.lineWidth = 3;
        c.setLineDash([12, 10]);
        c.beginPath(); c.moveTo(LW / 2, 0); c.lineTo(LW / 2, g.LH); c.stroke();
      }
      const tb = textBoxes[drag.key];
      if (tb) {
        c.strokeStyle = "rgba(255,255,255,0.65)";
        c.lineWidth = 3;
        c.setLineDash([10, 8]);
        rr(c, tb.x, tb.y, tb.w, tb.h, 16);
        c.stroke();
      }
    }

    // 動画ラスト2秒の予約・LINE誘導カット フェードイン合成
    if (endAlpha > 0) {
      const ec = getEndCardCanvas(W, H, opt);
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.globalAlpha = endAlpha;
      c.drawImage(ec, 0, 0);
      c.globalAlpha = 1;
    }
    c.restore();
  }

  // ---------- プレビュー ----------
  const pv = $("preview"), pctx = pv.getContext("2d", { alpha: false });

  function clearLoopTimer() {
    if (loopTimer) {
      clearTimeout(loopTimer);
      loopTimer = null;
    }
  }
  function isVideoAtEnd(p) {
    const v = p.el;
    if (!v) return true;
    if (v.ended) return true;
    const d = v.duration;
    return isFinite(d) && d > 0 && v.currentTime >= d - 0.04;
  }
  let ringWasVisible = false;
  function tick() {
    if (!state.exporting) {
      const vids = videos();
      if (state.playing && !scrubbingTrim && !syncingVideos && !loopTimer) {
        if (vids.length > 0 && !vids.some(p => p.scanning) && vids.every(isVideoAtEnd)) {
          loopTimer = setTimeout(() => {
            loopTimer = null;
            if (state.playing && !state.exporting && !scrubbingTrim) restartVideos();
          }, 180);
        }
      }

      // 変更がないアイドル時や、120Hz画面での30fps動画のフレーム間では再描画を完全にスキップしGPU/CPU負荷をゼロにする
      let needDraw = previewDirty;
      const ringNow = state.faceBlur && Date.now() < blurRingUntil;
      if (ringWasVisible && !ringNow) needDraw = true;
      ringWasVisible = ringNow;

      if (state.layout === "wipe" && state.playing && !state.wipeManual &&
          !(drag && drag.kind === "wipe") && !(state.endCard.enabled && state.endCard.previewing)) {
        needDraw = true;
      }

      for (let i = 0; i < vids.length; i++) {
        const p = vids[i];
        const uh = shouldUseHold(p);
        if (uh !== p.drawnHold) {
          needDraw = true;
        } else if (!uh && p.el) {
          if (p.frameSeq !== p.drawnFrameSeq || Math.abs(p.el.currentTime - p.drawnTime) >= 0.004) {
            needDraw = true;
          }
        }
      }

      if (needDraw) {
        render(pctx, pv.width, pv.height, { preview: true, guide: state.guide });
        previewDirty = false;
        for (let i = 0; i < vids.length; i++) {
          const p = vids[i];
          const uh = shouldUseHold(p);
          p.drawnHold = uh;
          if (!uh && p.el) {
            p.drawnFrameSeq = p.frameSeq;
            p.drawnTime = p.el.currentTime;
          }
        }
      }
    }
    requestAnimationFrame(tick);
  }

  // ---------- メディア読み込み・デコーダ管理・動き始め同期 ----------
  function setMsg(text, kind) { const m = $("msg"); m.textContent = text || ""; m.className = "msg " + (kind || ""); }
  function videos() { return Object.values(state.panels).filter(p => p.type === "video"); }

  function captureHoldFrame(p) {
    if (!p || p.type !== "video" || !p.el) return;
    const vw = p.el.videoWidth, vh = p.el.videoHeight;
    if (!vw || !vh || p.el.readyState < 2) return;
    const scale = Math.min(1, 270 / vw);
    const cw = Math.max(2, Math.round(vw * scale));
    const ch = Math.max(2, Math.round(vh * scale));
    if (!p.holdCanvas) p.holdCanvas = document.createElement("canvas");
    if (p.holdCanvas.width !== cw || p.holdCanvas.height !== ch) {
      p.holdCanvas.width = cw;
      p.holdCanvas.height = ch;
    }
    try {
      p.holdCanvas.getContext("2d").drawImage(p.el, 0, 0, cw, ch);
      p.hasHold = true;
    } catch (e) {}
  }

  function destroyPanelMedia(p) {
    if (!p) return;
    p.scanId++;
    if (p.blur) p.blur.trackId++;
    p.scanning = false;
    p.warming = false;
    p.warmed = false;
    p.scanPromise = null;
    if (p.audioSrc) {
      try { p.audioSrc.disconnect(); } catch (e) {}
      p.audioSrc = null;
    }
    if (p.type === "video" && p.el) {
      try {
        p.el.onloadeddata = null;
        p.el.onerror = null;
        p.el.ondurationchange = null;
        p.el.pause();
        p.el.removeAttribute("src");
        p.el.load(); // iPadのハードウェアデコーダ（VTDecompressionSession）を即時解放
        p.el.remove();
      } catch (e) {}
    }
    if (p.url) {
      URL.revokeObjectURL(p.url);
      p.url = null;
    }
    p.holdCanvas = null;
    p.hasHold = false;
  }

  function maxTrimFor(p) {
    if (!p || p.type !== "video" || !p.el) return 0;
    const dur = p.el.duration;
    if (!isFinite(dur) || dur <= 0.6) return 0;
    return Math.max(0, Math.round((dur - 0.5) * 10) / 10);
  }

  function shortName(s) {
    if (!s) return "";
    return s.length > 20 ? s.slice(0, 10) + "…" + s.slice(-8) : s;
  }

  function refreshTrimUI() {
    ["before", "after"].forEach((w) => {
      const p = state.panels[w];
      const W = cap(w);
      const box = $("trimBox" + W);
      const slider = $("trim" + W);
      const label = $("trimVal" + W);
      if (p.type !== "video") {
        box.hidden = true;
        return;
      }
      box.hidden = false;
      const maxT = maxTrimFor(p);
      slider.max = String(maxT);
      p.trimStart = clamp(Math.round((p.trimStart || 0) * 10) / 10, 0, maxT);
      slider.value = String(p.trimStart);
      label.textContent = p.scanning ? "解析中…" : `${p.trimStart.toFixed(1)}秒`;
    });
    $("btnResync").hidden = videos().length === 0;
    $("chkAutoSync").checked = state.autoSync;
  }

  function refreshPick() {
    ["before", "after"].forEach(w => {
      const p = state.panels[w], el = $("name" + cap(w));
      if (p.scanning) {
        el.textContent = "🚶 動き始めを解析中…";
      } else if (p.type === "video" && p.trimStart > 0) {
        el.textContent = `🚶 ${p.trimStart.toFixed(1)}秒〜 ｜ ${shortName(p.name)}`;
      } else {
        el.textContent = p.name || "タップして選ぶ";
      }
      el.closest(".pick").classList.toggle("done", !!p.el);
    });
    refreshBgmUI();
    refreshTrimUI();
  }

  function waitIdleSeek(v, maxMs) {
    if (!v || !v.seeking) return Promise.resolve();
    return new Promise((res) => {
      let done = false;
      const f = () => { if (!done) { done = true; v.removeEventListener("seeked", f); res(); } };
      v.addEventListener("seeked", f);
      setTimeout(f, maxMs || 450);
    });
  }

  function waitCanPlay(v, maxMs) {
    if (!v || v.readyState >= 3) return Promise.resolve();
    return new Promise((res) => {
      let done = false;
      const f = () => {
        if (done) return;
        done = true;
        v.removeEventListener("canplay", f);
        v.removeEventListener("canplaythrough", f);
        res();
      };
      v.addEventListener("canplay", f);
      v.addEventListener("canplaythrough", f);
      setTimeout(f, maxMs || 750);
    });
  }

  function pumpGpuFrame(v) {
    if (!v || v.readyState < 2) return;
    try { warmCtx.drawImage(v, 0, 0, 280, 280); } catch (e) {}
  }

  function seekTo(v, sec) {
    return waitIdleSeek(v, 400).then(() => new Promise((res) => {
      const target = Math.max(0, sec || 0);
      if (Math.abs(v.currentTime - target) < 0.005 && !v.seeking && v.readyState >= 2) {
        res();
        return;
      }
      let done = false;
      const f = () => { if (!done) { done = true; v.removeEventListener("seeked", f); res(); } };
      v.addEventListener("seeked", f);
      try { v.currentTime = target; } catch (e) { f(); return; }
      setTimeout(f, 650);
    }));
  }

  /**
   * 無音再生しながら実際にデコード・提示されたフレーム数を監視し、
   * 毎フレームGPUキャンバスへdrawImageしてAVPlayerItemVideoOutputとMetalテクスチャ経路を温める
   */
  function playAndPumpFrames(v, opts, isCancelled) {
    const minFrames = (opts && opts.minFrames) || 2;
    const minAdvance = (opts && opts.minAdvance) || 0.05;
    const timeoutMs = (opts && opts.timeoutMs) || 450;
    const pauseAtEnd = !opts || opts.pauseAtEnd !== false;

    const prevMuted = v.muted;
    v.muted = true;
    const startCt = v.currentTime;
    let lastRafCt = startCt;
    let vfcFrames = 0;
    let rafFrames = 0;

    return new Promise((resolve) => {
      let settled = false;
      let rafId = 0;
      let vfcId = 0;
      const hasRVFC = typeof v.requestVideoFrameCallback === "function";

      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (rafId) cancelAnimationFrame(rafId);
        if (hasRVFC && vfcId && typeof v.cancelVideoFrameCallback === "function") {
          try { v.cancelVideoFrameCallback(vfcId); } catch (e) {}
        }
        if (pauseAtEnd) {
          try { v.pause(); } catch (e) {}
        }
        v.muted = prevMuted;
        resolve({
          frames: Math.max(vfcFrames, rafFrames),
          advanced: Math.max(0, v.currentTime - startCt)
        });
      };

      const isSatisfied = () => {
        const frames = Math.max(vfcFrames, rafFrames);
        const adv = v.currentTime - startCt;
        return v.ended || (frames >= minFrames && adv >= minAdvance);
      };

      const timer = setTimeout(done, timeoutMs);

      const onVfc = () => {
        if (settled) return;
        vfcFrames++;
        pumpGpuFrame(v);
        if ((isCancelled && isCancelled()) || isSatisfied()) {
          done();
          return;
        }
        vfcId = v.requestVideoFrameCallback(onVfc);
      };

      const onRaf = () => {
        if (settled) return;
        if (isCancelled && isCancelled()) {
          done();
          return;
        }
        const ct = v.currentTime;
        if (Math.abs(ct - lastRafCt) >= 0.014) {
          lastRafCt = ct;
          rafFrames++;
          if (!vfcFrames) pumpGpuFrame(v);
        }
        if (isSatisfied()) {
          done();
          return;
        }
        rafId = requestAnimationFrame(onRaf);
      };

      const startWatchers = () => {
        if (settled) return;
        if (hasRVFC) vfcId = v.requestVideoFrameCallback(onVfc);
        rafId = requestAnimationFrame(onRaf);
      };

      const pPlay = v.play();
      if (pPlay && typeof pPlay.then === "function") {
        pPlay.then(startWatchers).catch(done);
      } else {
        startWatchers();
      }
    });
  }

  /**
   * play()直後、実際に最初のライブフレームが出力されて映像ストリームが走り出すまで待機する
   */
  function waitLivePlaybackFrame(v, prevCt, maxWaitMs, isCancelled) {
    if (!v) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      let rafId = 0;
      let vfcId = 0;
      const hasRVFC = typeof v.requestVideoFrameCallback === "function";

      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (rafId) cancelAnimationFrame(rafId);
        if (hasRVFC && vfcId && typeof v.cancelVideoFrameCallback === "function") {
          try { v.cancelVideoFrameCallback(vfcId); } catch (e) {}
        }
        pumpGpuFrame(v);
        resolve();
      };

      const timer = setTimeout(done, maxWaitMs || 220);

      if (hasRVFC) {
        vfcId = v.requestVideoFrameCallback(() => done());
      }
      const check = () => {
        if (settled) return;
        if ((isCancelled && isCancelled()) || v.ended || (v.currentTime - prevCt) >= 0.014) {
          done();
          return;
        }
        rafId = requestAnimationFrame(check);
      };
      rafId = requestAnimationFrame(check);
    });
  }

  /**
   * 初回再生時のみ1回だけGPUテクスチャ経路（AVPlayerItemVideoOutput / Metal）を並列ウォームアップする。
   * 2周目以降のループ再生や微調整時には余計なプリ再生・逆シークを一切行わず即座に並列スタートさせる。
   */
  async function quickWarmOnce(p, targetSec, isCancelled) {
    const v = p.el;
    if (!v || p.warmed) return;
    p.warming = true;
    markDirty();
    try {
      await waitCanPlay(v, 450);
      if (isCancelled && isCancelled()) return;
      await seekTo(v, targetSec);
      if (isCancelled && isCancelled()) return;
      pumpGpuFrame(v);
      captureHoldFrame(p);
      await playAndPumpFrames(v, {
        minFrames: 2,
        minAdvance: 0.035,
        timeoutMs: 220,
        pauseAtEnd: true
      }, isCancelled);
      if (isCancelled && isCancelled()) { v.pause(); return; }
      await seekTo(v, targetSec);
      p.warmed = true;
    } finally {
      p.warming = false;
      markDirty();
    }
  }

  function autoDetectPanel(which) {
    const p = state.panels[which];
    if (!p || p.type !== "video" || !p.el || !p.url || !MOTION) return Promise.resolve(0);
    const token = ++p.scanId;
    clearLoopTimer();
    syncToken++;
    syncingVideos = false;
    // スキャン中は全動画を一時停止し、再生用<video>はCPU読み出し(getImageData)で汚染せず専用一時デコーダで解析する
    videos().forEach(vp => {
      if (!vp.scanning && vp.el && !vp.el.seeking) captureHoldFrame(vp);
      if (vp.el) vp.el.pause();
    });
    p.scanning = true;
    refreshPick();
    markDirty();

    const job = MOTION.detectStart(
      p.url,
      p.el.duration || 0,
      () => !Object.values(state.panels).includes(p) || p.scanId !== token
    ).then((sec) => {
      if (!Object.values(state.panels).includes(p) || p.scanId !== token) return 0;
      syncingVideos = true;
      p.scanning = false;
      p.autoDetected = true;
      const clamped = clamp(Math.round((sec || 0) * 10) / 10, 0, maxTrimFor(p));
      p.autoTrimSec = clamped;
      if (state.autoSync) {
        p.trimStart = clamped;
      }
      refreshPick();
      markDirty();
      if (!state.exporting && !scrubbingTrim && !videos().some(vp => vp.scanning)) {
        restartVideos();
      } else if (!videos().some(vp => vp.scanning)) {
        syncingVideos = false;
      }
      return clamped;
    }).catch(() => {
      if (Object.values(state.panels).includes(p) && p.scanId === token) {
        syncingVideos = true;
        p.scanning = false;
        refreshPick();
        markDirty();
        if (!state.exporting && !scrubbingTrim && !videos().some(vp => vp.scanning)) {
          restartVideos();
        } else if (!videos().some(vp => vp.scanning)) {
          syncingVideos = false;
        }
      }
      return 0;
    });
    p.scanPromise = job;
    return job;
  }

  function attachVideoFrameTracker(p, v) {
    v.addEventListener("seeked", markDirty);
    if (typeof v.requestVideoFrameCallback === "function") {
      const step = () => {
        if (p.el !== v) return;
        p.frameSeq++;
        v.requestVideoFrameCallback(step);
      };
      v.requestVideoFrameCallback(step);
    }
  }

  function loadFile(which, file) {
    if (!file) return;
    const p = state.panels[which];
    const isVideo = file.type.startsWith("video/");
    const isImage = file.type.startsWith("image/");
    if (!isVideo && !isImage) { setMsg("画像または動画ファイルを選んでください。", "err"); return; }

    // 新しい動画のデコーダ確保前に、既存パネルの旧デコーダ解放と他動画の一時停止を行って同時デコーダ競合を防ぐ
    if (isVideo) {
      clearLoopTimer();
      syncToken++;
      videos().forEach(vp => {
        if (!vp.scanning && !vp.warming && vp.el && !vp.el.seeking) captureHoldFrame(vp);
        if (vp.el) vp.el.pause();
      });
      if (p.el) {
        destroyPanelMedia(p);
        Object.assign(p, newPanel());
        refreshPick();
        markDirty();
      }
    }

    const url = URL.createObjectURL(file);
    const done = (el, type) => {
      const keepBlurEnabled = p.blur ? p.blur.enabled : true;
      const keepBlurScale = p.blur ? p.blur.scale : 1;
      destroyPanelMedia(p);
      Object.assign(p, {
        type, el, url, name: file.name, zoom: 1, ox: 0, oy: 0,
        trimStart: 0, autoTrimSec: 0, autoDetected: false,
        scanning: false, scanPromise: null, audioSrc: null,
        holdCanvas: null, hasHold: false, warmed: false, warming: false,
        frameSeq: 0, drawnFrameSeq: -1, drawnTime: -1, drawnHold: null,
        blur: Object.assign(newBlur(), { enabled: keepBlurEnabled, scale: keepBlurScale })
      });
      if (type === "video") {
        attachVideoFrameTracker(p, el);
        pumpGpuFrame(el);
        captureHoldFrame(p);
      }
      $("zoom" + cap(which)).value = 1;
      refreshPick();
      refreshBlurStatusUI();
      setMsg("");
      markDirty();
      if (state.faceBlur && p.blur.enabled) {
        p.blur.trackPromise = runFaceTrack(which, false);
      }
      if (type === "video") {
        if (state.autoSync && MOTION) {
          autoDetectPanel(which);
        } else {
          restartVideos();
        }
      } else if (videos().length) {
        restartVideos();
      }
    };
    if (isVideo) {
      const v = document.createElement("video");
      v.muted = true; v.loop = false; v.playsInline = true; v.preload = "auto";
      v.width = 2;
      v.height = 2;
      v.style.cssText = "width:2px;height:2px;display:block;contain:strict";
      v.setAttribute("playsinline", "");
      v.setAttribute("webkit-playsinline", "");
      mediaPool.appendChild(v);
      v.ondurationchange = () => refreshTrimUI();
      let loadedOnce = false;
      v.onloadeddata = () => {
        if (loadedOnce) return;
        loadedOnce = true;
        v.onloadeddata = null;
        done(v, "video");
      };
      v.onerror = () => {
        try { v.onloadeddata = null; v.removeAttribute("src"); v.load(); v.remove(); } catch (e) {}
        URL.revokeObjectURL(url);
        setMsg("この動画は読み込めませんでした（形式を確認してください）。", "err");
        markDirty();
        if (videos().length) restartVideos();
      };
      v.src = url;
    } else {
      const img = new Image();
      img.onload = () => done(img, "image");
      img.onerror = () => { URL.revokeObjectURL(url); setMsg("この画像は読み込めませんでした。", "err"); };
      img.src = url;
    }
  }

  function clearPanel(which) {
    const p = state.panels[which];
    destroyPanelMedia(p);
    state.panels[which] = newPanel();
    refreshPick();
    refreshBlurStatusUI();
    $("zoom" + cap(which)).value = 1;
    markDirty();
  }

  async function restartVideos() {
    clearLoopTimer();
    const myToken = ++syncToken;
    const vids = videos();
    if (!vids.length) {
      syncingVideos = false;
      markDirty();
      return;
    }
    if (vids.some(p => p.scanning)) {
      vids.forEach(p => { if (p.el) p.el.pause(); });
      syncingVideos = false;
      markDirty();
      return;
    }
    vids.forEach(p => {
      if (!syncingVideos && p.el && !p.el.seeking && p.el.readyState >= 2) {
        captureHoldFrame(p);
      }
      if (p.el) p.el.pause();
    });
    syncingVideos = true;

    const cancelled = () => myToken !== syncToken || state.exporting || scrubbingTrim;
    const abortCleanly = () => {
      if (myToken === syncToken) {
        syncingVideos = false;
        markDirty();
      }
    };

    const starts = vids.map(p => clamp(p.trimStart || 0, 0, maxTrimFor(p)));

    // 初回のみ並列ウォームアップ、2周目以降は並列シークのみで即スタート（1秒フリーズを完全解消）
    await Promise.all(vids.map(async (p, idx) => {
      if (cancelled()) return;
      const start = starts[idx];
      if (state.playing && !p.warmed) {
        await quickWarmOnce(p, start, cancelled);
      } else {
        await seekTo(p.el, start);
      }
      if (!cancelled()) captureHoldFrame(p);
    }));

    if (cancelled()) { abortCleanly(); return; }
    if (state.playing) {
      const startCts = vids.map(p => (p.el ? p.el.currentTime : 0));
      await Promise.all(vids.map(p => p.el.play().catch(() => {})));
      await Promise.all(vids.map((p, idx) => waitLivePlaybackFrame(p.el, startCts[idx], 85, cancelled)));
    }
    if (cancelled()) { abortCleanly(); return; }
    syncingVideos = false;
    markDirty();
  }

  function setPlaying(on) {
    state.playing = on;
    if (on) state.wipeManual = false;
    $("btnPlay").textContent = on ? "⏸ 停止" : "▶ 再生";
    clearLoopTimer();
    const vids = videos();
    if (!on) {
      syncToken++;
      syncingVideos = false;
      vids.forEach(p => p.el.pause());
      markDirty();
      return;
    }
    if (vids.length > 0 && vids.every(isVideoAtEnd)) {
      restartVideos();
      return;
    }
    vids.forEach(p => p.el.play().catch(() => {}));
    markDirty();
  }

  // ---------- プレビュー操作（ドラッグ/ホイール/ドロップ） ----------
  function logical(e) {
    const g = getGeom();
    const r = pv.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width * LW, y: (e.clientY - r.top) / r.height * g.LH };
  }
  function hitPanel(pt) {
    const g = getGeom();
    if (pt.y < g.panelY || pt.y > g.bottomY) return null;
    if (state.layout === "split-v") {
      return pt.y < (g.panelY + g.panelH / 2) ? "before" : "after";
    }
    if (state.layout === "wipe") {
      return pt.x < (getWipeRatio({ preview: true }) * LW) ? "before" : "after";
    }
    return pt.x < LW / 2 ? "before" : "after";
  }
  function hitMarker(pt) {
    const list = state.posture.markers;
    if (!list.length) return null;
    const g = getGeom();
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i];
      const mx = clamp(m.nx, 0.04, 0.96) * LW;
      const my = g.panelY + clamp(m.ny, 0.04, 0.96) * g.panelH;
      const rad = 74 * clamp(m.scale || 1, 0.7, 1.8);
      if (Math.hypot(pt.x - mx, pt.y - my) <= rad) return m;
    }
    return null;
  }
  function hitWipe(pt) {
    if (state.layout !== "wipe") return false;
    const g = getGeom();
    if (pt.y < g.panelY || pt.y > g.bottomY) return false;
    const splitX = getWipeRatio({ preview: true }) * LW;
    const hy = g.panelY + g.panelH * 0.5;
    return Math.hypot(pt.x - splitX, pt.y - hy) <= 64 || Math.abs(pt.x - splitX) <= 28;
  }
  function hitPostureLine(pt) {
    if (!state.posture.lines) return null;
    const g = getGeom();
    if (pt.y < g.panelY - 26 || pt.y > g.bottomY + 26) return null;
    const y1 = g.panelY + state.posture.y1 * g.panelH;
    const y2 = g.panelY + state.posture.y2 * g.panelH;
    const d1 = Math.abs(pt.y - y1);
    const d2 = Math.abs(pt.y - y2);
    if (Math.min(d1, d2) > 32) return null;
    return d1 <= d2 ? "y1" : "y2";
  }
  function getPreviewVisRects() {
    const g = getGeom();
    if (state.layout === "wipe") {
      const splitX = Math.round(LW * getWipeRatio({ preview: true }));
      return {
        before: { x: 0, y: g.panelY, w: splitX, h: g.panelH },
        after:  { x: splitX, y: g.panelY, w: LW - splitX, h: g.panelH }
      };
    }
    return {
      before: getPanelFrame("before"),
      after:  getPanelFrame("after")
    };
  }
  function hitFaceBlur(pt) {
    if (!state.faceBlur || !FACE) return null;
    const vis = getPreviewVisRects();
    for (const w of ["before", "after"]) {
      const vr = vis[w];
      if (pt.x < vr.x || pt.x > vr.x + vr.w || pt.y < vr.y || pt.y > vr.y + vr.h) continue;
      const bg = computeBlurGeom(w, vr);
      if (!bg) continue;
      const rx = Math.max(46, bg.rx * 1.15);
      const ry = Math.max(50, bg.ry * 1.15);
      const nd = ((pt.x - bg.cx) / rx) ** 2 + ((pt.y - bg.cy) / ry) ** 2;
      if (nd <= 1) return { which: w, bg };
    }
    return null;
  }
  function hitText(pt) {
    let best = null, bestDist = Infinity;
    for (const k of ["symptom", "age", "clinic", "sub"]) {
      const b = textBoxes[k];
      if (!b) continue;
      if (pt.x >= b.x && pt.x <= b.x + b.w && pt.y >= b.y && pt.y <= b.y + b.h) {
        const d = Math.abs(pt.y - (b.y + b.h / 2));
        if (d < bestDist) { bestDist = d; best = k; }
      }
    }
    return best;
  }
  const pointers = new Map();
  let drag = null, pinch = null, tapStart = null;

  pv.addEventListener("pointerdown", (e) => {
    const pt = logical(e);
    pv.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, pt);
    if (state.endCard.enabled && state.endCard.previewing) {
      drag = null;
      pinch = null;
      return;
    }
    if (pointers.size === 1) {
      const mk = hitMarker(pt);
      if (mk) {
        state.posture.selectedId = mk.id;
        drag = { kind: "marker", marker: mk, last: pt };
        markDirty();
        pinch = null;
        return;
      }
      if (hitWipe(pt)) {
        state.wipeManual = true;
        state.wipePos = clamp(pt.x / LW, 0.08, 0.92);
        drag = { kind: "wipe" };
        markDirty();
        pinch = null;
        return;
      }
      const pLine = hitPostureLine(pt);
      if (pLine) {
        drag = { kind: "pline", key: pLine };
        markDirty();
        pinch = null;
        return;
      }
      const fb = hitFaceBlur(pt);
      if (fb) {
        blurRingUntil = Date.now() + 3000;
        drag = { kind: "blur", which: fb.which, last: pt };
        markDirty();
        pinch = null;
        return;
      }
      const tKey = hitText(pt);
      if (tKey) {
        drag = {
          kind: "text",
          key: tKey,
          last: pt,
          rawDx: state.textPos[tKey].dx,
          rawDy: state.textPos[tKey].dy,
          moved: false
        };
        markDirty();
      } else {
        const which = hitPanel(pt);
        drag = which ? { kind: "panel", which, last: pt } : null;
      }
      pinch = null;
    } else if (pointers.size === 2 && drag && drag.kind === "panel") {
      const [a, b] = [...pointers.values()];
      pinch = { which: drag.which, dist: Math.hypot(a.x - b.x, a.y - b.y), zoom: state.panels[drag.which].zoom };
    }
  });
  pv.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) return;
    const pt = logical(e);
    pointers.set(e.pointerId, pt);
    if (pinch && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      setZoom(pinch.which, pinch.zoom * Math.hypot(a.x - b.x, a.y - b.y) / pinch.dist);
      return;
    }
    if (!drag) return;
    const g = getGeom();
    if (drag.kind === "marker") {
      const m = drag.marker;
      m.nx = clamp(m.nx + (pt.x - drag.last.x) / LW, 0.04, 0.96);
      m.ny = clamp(m.ny + (pt.y - drag.last.y) / g.panelH, 0.04, 0.96);
      drag.last = pt;
      markDirty();
      return;
    }
    if (drag.kind === "wipe") {
      state.wipeManual = true;
      state.wipePos = clamp(pt.x / LW, 0.08, 0.92);
      markDirty();
      return;
    }
    if (drag.kind === "pline") {
      state.posture[drag.key] = clamp((pt.y - g.panelY) / g.panelH, 0.04, 0.96);
      markDirty();
      return;
    }
    if (drag.kind === "blur") {
      const p = state.panels[drag.which];
      const bg = computeBlurGeom(drag.which, null);
      if (p && bg && bg.dw > 0 && bg.dh > 0) {
        const dmx = (pt.x - drag.last.x) / bg.dw;
        const dmy = (pt.y - drag.last.y) / bg.dh;
        if (p.blur.mode === "fixed") {
          p.blur.fixedX = clamp(p.blur.fixedX + dmx, 0.03, 0.97);
          p.blur.fixedY = clamp(p.blur.fixedY + dmy, 0.03, 0.97);
        } else {
          p.blur.offsetX = clamp((p.blur.offsetX || 0) + dmx, -0.85, 0.85);
          p.blur.offsetY = clamp((p.blur.offsetY || 0) + dmy, -0.85, 0.85);
        }
        blurRingUntil = Date.now() + 2800;
      }
      drag.last = pt;
      markDirty();
      return;
    }
    if (drag.kind === "text") {
      const b = textBaseFor(drag.key);
      drag.rawDx = clamp(drag.rawDx + (pt.x - drag.last.x), 80 - b.x, LW - 80 - b.x);
      drag.rawDy = clamp(drag.rawDy + (pt.y - drag.last.y), 45 - b.y, g.LH - 45 - b.y);
      state.textPos[drag.key].dx = Math.abs(drag.rawDx) < 24 ? 0 : Math.round(drag.rawDx);
      state.textPos[drag.key].dy = Math.round(drag.rawDy);
      drag.last = pt;
      drag.moved = true;
      syncTextSliders();
      markDirty();
      return;
    }
    const p = state.panels[drag.which];
    const pf = getPanelFrame(drag.which);
    const { rx, ry } = panelRange(p, pf.w, pf.h);
    if (rx > 0) p.ox = clamp(p.ox + (pt.x - drag.last.x) / rx, -1, 1);
    if (ry > 0) p.oy = clamp(p.oy + (pt.y - drag.last.y) / ry, -1, 1);
    drag.last = pt;
    markDirty();
  });
  const endPtr = (e) => {
    const hadOverlayDrag = !!(drag && (drag.kind === "text" || drag.kind === "blur"));
    if (drag && drag.kind === "text" && drag.moved && pointers.size <= 1) saveSettings();
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (!pointers.size) drag = null;
    if (hadOverlayDrag) markDirty();
  };
  pv.addEventListener("pointerdown", (e) => {
    const pt = logical(e);
    if ((state.endCard.enabled && state.endCard.previewing) ||
        hitMarker(pt) || hitWipe(pt) || hitPostureLine(pt) || hitFaceBlur(pt) || hitText(pt)) {
      tapStart = null;
      return;
    }
    tapStart = pt;
  }, true);
  pv.addEventListener("pointerup", (e) => {
    const pt = logical(e), which = hitPanel(pt);
    if (tapStart && which && pointers.size === 1 && !state.panels[which].el &&
        Math.hypot(pt.x - tapStart.x, pt.y - tapStart.y) < 15) $("file" + cap(which)).click();
    tapStart = null;
  });
  pv.addEventListener("pointerup", endPtr);
  pv.addEventListener("pointercancel", endPtr);
  pv.addEventListener("wheel", (e) => {
    const pt = logical(e);
    if (state.endCard.enabled && state.endCard.previewing) return;
    const mk = hitMarker(pt);
    if (mk) {
      e.preventDefault();
      mk.scale = clamp((mk.scale || 1) * (e.deltaY < 0 ? 1.07 : 0.93), 0.55, 2.0);
      markDirty();
      return;
    }
    const fb = hitFaceBlur(pt);
    if (fb) {
      e.preventDefault();
      const p = state.panels[fb.which];
      p.blur.scale = clamp(Math.round(p.blur.scale * (e.deltaY < 0 ? 1.06 : 0.94) * 20) / 20, 0.55, 2.3);
      const szEl = $("blurSize" + cap(fb.which));
      if (szEl) szEl.value = String(p.blur.scale);
      blurRingUntil = Date.now() + 2200;
      markDirty();
      return;
    }
    const which = hitPanel(pt); if (!which) return;
    e.preventDefault();
    setZoom(which, state.panels[which].zoom * (e.deltaY < 0 ? 1.05 : 0.95));
  }, { passive: false });
  pv.addEventListener("dragover", (e) => e.preventDefault());
  pv.addEventListener("drop", (e) => {
    e.preventDefault();
    const pt = logical(e);
    const which = hitPanel(pt) || (pt.x < LW / 2 ? "before" : "after");
    loadFile(which, e.dataTransfer.files[0]);
  });

  function setZoom(which, z) {
    const p = state.panels[which];
    p.zoom = clamp(z, 1, 3);
    $("zoom" + cap(which)).value = p.zoom;
    const pf = getPanelFrame(which);
    const { rx, ry } = panelRange(p, pf.w, pf.h);   // ズーム縮小時のはみ出し補正
    if (rx === 0) p.ox = 0; if (ry === 0) p.oy = 0;
    markDirty();
  }

  // ---------- 書き出し＆各種SNS投稿 ----------
  function lim() { return pro ? CFG.LIMITS.pro : CFG.LIMITS.free; }
  function exportSize() {
    const sp = getSpec();
    const hq = pro && $("selQuality").value === "1080";
    return hq ? { w: sp.proW, h: sp.proH } : { w: sp.freeW, h: sp.freeH };
  }
  function currentExportMode() {
    return (videos().length || state.bgm.enabled || state.endCard.enabled) ? "video" : "image";
  }
  function serializeBlurKey(p) {
    if (!state.faceBlur || !p.blur || !p.blur.enabled) return "0";
    const b = p.blur;
    return `${b.trackId},${b.mode},${b.scale},${b.fixedX.toFixed(4)},${b.fixedY.toFixed(4)},${b.baseR.toFixed(4)},${(b.offsetX || 0).toFixed(4)},${(b.offsetY || 0).toFixed(4)},${b.keyframes.length},${b.status}`;
  }
  function exportSignature(modeOverride) {
    const mode = modeOverride || currentExportMode();
    const { w, h } = exportSize();
    const b = state.panels.before, a = state.panels.after;
    return [
      mode, w, h, pro ? 1 : 0,
      state.aspect,
      state.layout,
      (mode === "image" && state.layout === "wipe") ? state.wipePos.toFixed(4) : "",
      $("selAudio") ? $("selAudio").value : "none",
      state.theme,
      state.theme === "custom" ? `${state.custom.bg},${state.custom.text},${state.custom.accent}` : "",
      logoUrl || "",
      state.symptom, state.age, state.clinic, state.sub,
      state.disclaimer.enabled ? state.disclaimer.text : "",
      serializePostureKey(),
      serializeBlurKey(b),
      serializeBlurKey(a),
      (mode === "video" && state.endCard.enabled)
        ? `1|${state.endCard.area}|${state.endCard.offer}|${state.endCard.cta}`
        : "0",
      state.textPos.symptom.dx, state.textPos.symptom.dy,
      state.textPos.age.dx, state.textPos.age.dy,
      state.textPos.clinic.dx, state.textPos.clinic.dy,
      state.textPos.sub.dx, state.textPos.sub.dy,
      mode === "video" ? `${state.bgm.enabled ? 1 : 0},${state.bgm.seed},${state.bgm.volume},${state.bgm.photoSec}` : "",
      b.type || "", b.url || "", b.zoom, b.ox, b.oy, b.trimStart,
      a.type || "", a.url || "", a.zoom, a.ox, a.oy, a.trimStart
    ].join("\x1f");
  }
  function isExportFresh() {
    if (!lastExport) return false;
    return lastExport.sig === exportSignature(currentExportMode());
  }
  function storeLastExport(blob, filename, mime, kind, sig, downloaded) {
    let file = null;
    try {
      file = new File([blob], filename, { type: mime, lastModified: Date.now() });
    } catch (e) {}
    lastExport = { blob, file, filename, mime, kind, sig, downloaded: !!downloaded };
    setPendingSns(null);
    lastSnsUiReady = null;
    refreshSnsUI();
    return lastExport;
  }
  function setSnsButtonsDisabled(disabled) {
    document.querySelectorAll("[data-sns]").forEach((b) => { b.disabled = disabled; });
    const nb = $("btnNativeShare");
    if (nb) nb.disabled = disabled;
  }
  function download(blob, filename) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  const stamp = () => { const d = new Date(), z = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}`; };

  async function ensureFaceTrackingReady() {
    if (!state.faceBlur || !FACE) return;
    const jobs = [];
    ["before", "after"].forEach((w) => {
      const p = state.panels[w];
      if (!p || !p.el || !p.blur || !p.blur.enabled) return;
      if (p.blur.status === "idle" && p.blur.mode !== "fixed") {
        p.blur.trackPromise = runFaceTrack(w, false);
      }
      if (p.blur.status === "tracking" && p.blur.trackPromise) {
        jobs.push(p.blur.trackPromise);
      }
    });
    if (jobs.length) {
      setMsg("顔ぼかしの追従位置を準備しています…");
      await Promise.race([
        Promise.all(jobs),
        new Promise((r) => setTimeout(r, 4500))
      ]);
    }
  }

  async function savePng(opts) {
    const doDownload = !(opts && opts.download === false);
    if (!state.panels.before.el && !state.panels.after.el) {
      setMsg("先にビフォー／アフターの画像か動画を追加してください。", "err");
      return null;
    }
    if (!checkProGateBeforeExport()) return null;
    if (pro && apiBase()) {
      await verifyActiveLicense({ silent: false, force: false });
      if (!checkProGateBeforeExport()) return null;
    }
    await ensureFaceTrackingReady();
    const { w, h } = exportSize();
    const sig = exportSignature("image");
    const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
    render(cv.getContext("2d"), w, h, { staticWipe: true });
    const blob = await new Promise((res) => cv.toBlob(res, "image/png"));
    if (!blob) {
      setMsg("PNGの作成に失敗しました。", "err");
      return null;
    }
    const filename = `before-after-${stamp()}.png`;
    const exp = storeLastExport(blob, filename, "image/png", "image", sig, doDownload);
    if (doDownload) {
      download(blob, filename);
      setMsg("PNGを保存しました。下のSNSボタンからそのまま投稿できます。", "ok");
    }
    return exp;
  }

  function pickMime() {
    const list = [
      'video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1', 'video/mp4',
      'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'
    ];
    return list.find(t => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || "";
  }
  async function saveVideo(opts) {
    if (state.exporting) return null;
    const doDownload = !(opts && opts.download === false);
    if (!state.panels.before.el && !state.panels.after.el) {
      setMsg("先にビフォー／アフターの写真か動画を追加してください。", "err");
      return null;
    }
    if (!checkProGateBeforeExport()) return null;
    const vids = videos();
    if (!vids.length && !state.bgm.enabled && !state.endCard.enabled) {
      return await savePng(opts);
    }
    if (!window.MediaRecorder) {
      setMsg("このブラウザは動画書き出しに非対応です。Chrome / Edge / Safari 最新版をお使いください。", "err");
      return null;
    }

    syncToken++;
    syncingVideos = false;
    clearLoopTimer();
    stopBgmPreview();

    const mime = pickMime();
    const ext = mime.includes("mp4") ? "mp4" : "webm";

    // iPad Safari対策：最初のawaitより前（タップ同期タイミング）にAudioContextを確保
    const which = $("selAudio").value;
    const ap = which !== "none" ? state.panels[which] : null;
    const wantOrigAudio = !!(ap && ap.type === "video");
    const wantBgm = !!state.bgm.enabled;
    let audioCtx = null, dest = null, audioNode = null, audioEl = null, bgmRec = null;
    if (wantOrigAudio || wantBgm) {
      try {
        audioCtx = BGM.ensureContext();
        dest = audioCtx.createMediaStreamDestination();
      } catch (e) {
        console.warn(e);
      }
    }

    if (state.endCard.previewing) {
      state.endCard.previewing = false;
      refreshEndCardPreviewBtn();
    }
    state.exporting = true;
    vids.forEach(p => { if (p.el) p.el.pause(); });
    $("btnSave").disabled = true; $("btnPng").disabled = true;
    setSnsButtonsDisabled(true);
    $("progressBox").hidden = false; $("progressBar").style.width = "0%";
    let resultExp = null;

    try {
      // 書き出し前にライセンスの有効状態を再照合（解約・未払い時は自動で無料プランへ切り戻す）
      if (pro && apiBase()) {
        await verifyActiveLicense({ silent: false, force: false });
        if (!checkProGateBeforeExport()) return null;
      }
      await ensureFaceTrackingReady();

      const pendingScans = vids.map(p => p.scanning && p.scanPromise).filter(Boolean);
      if (pendingScans.length) {
        setMsg("動き始めの位置を解析しています…");
        await Promise.all(pendingScans);
      }

      const { w, h } = exportSize();
      const maxSec = lim().maxSeconds;
      const sig = exportSignature("video");
      const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
      const cctx = cv.getContext("2d", { alpha: false });

      let baseDur;
      if (vids.length) {
        const longest = Math.max(...vids.map(p => {
          const d = p.el.duration || 0;
          const ts = clamp(p.trimStart || 0, 0, maxTrimFor(p));
          return isFinite(d) && d > 0 ? Math.max(0.5, d - ts) : 0;
        }));
        baseDur = Math.min(maxSec, isFinite(longest) && longest > 0 ? longest : maxSec);
      } else {
        baseDur = Math.min(maxSec, state.bgm.photoSec || 8);
      }
      const wantEndCard = !!state.endCard.enabled;
      const dur = wantEndCard
        ? Math.min(maxSec, Math.max(3.2, baseDur + END_CARD_ADD_SEC))
        : baseDur;
      const endCardStart = wantEndCard ? Math.max(0.8, dur - END_CARD_ADD_SEC) : Infinity;
      const calcEndAlpha = (tSec) => {
        if (!wantEndCard || tSec <= endCardStart) return 0;
        const u = clamp((tSec - endCardStart) / 0.42, 0, 1);
        return 1 - Math.pow(1 - u, 3);
      };

      // 録画開始前に各動画を並列シーク（未ウォームアップの場合のみ初回温め）
      if (vids.length) {
        setMsg("スタート位置を準備しています…");
        await Promise.all(vids.map(async (p) => {
          const ts = clamp(p.trimStart || 0, 0, maxTrimFor(p));
          if (!p.warmed) {
            await quickWarmOnce(p, ts, () => false);
          } else {
            await seekTo(p.el, ts);
          }
          captureHoldFrame(p);
        }));
      }

      setMsg(`書き出し中…（約${Math.ceil(dur)}秒）このタブを開いたままにしてください。`);

      const stream = cv.captureStream(30);
      if (audioCtx && dest) {
        if (audioCtx.state === "suspended") await audioCtx.resume();
        if (wantOrigAudio) {
          try {
            if (!ap.audioSrc) ap.audioSrc = audioCtx.createMediaElementSource(ap.el);
            ap.audioSrc.connect(dest);
            audioNode = ap.audioSrc; audioEl = ap.el;
            ap.el.muted = false;
          } catch (e) {
            setMsg("元動画の音声取り込みに失敗したため、元音声なしで書き出します。");
          }
        }
        const tracks = dest.stream.getAudioTracks();
        if (tracks[0]) stream.addTrack(tracks[0]);
      }

      const rec = new MediaRecorder(stream, Object.assign(
        { videoBitsPerSecond: pro ? 10_000_000 : 6_000_000 },
        mime ? { mimeType: mime } : {}
      ));
      const chunks = [];
      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      const stopped = new Promise((res) => { rec.onstop = res; });

      // 書き出し用オーバーレイ＆エンドカードのキャッシュを録画開始前に事前生成し、録画中の文字計測スパイクをゼロ化
      if (wantEndCard) getEndCardCanvas(w, h, {});
      render(cctx, w, h, { wipeTime: 0, endCardAlpha: 0 });
      pctx.drawImage(cv, 0, 0, pv.width, pv.height);

      if (vids.length) {
        const startCts = vids.map(p => (p.el ? p.el.currentTime : 0));
        await Promise.all(vids.map(p => p.el.play().catch(() => {})));
        await Promise.all(vids.map((p, idx) => waitLivePlaybackFrame(p.el, startCts[idx], 85, () => false)));
        render(cctx, w, h, { wipeTime: 0, endCardAlpha: 0 });
      }
      if (wantBgm && audioCtx && dest) {
        bgmRec = BGM.start(audioCtx, dest, {
          seed: state.bgm.seed,
          volume: state.bgm.volume,
          durationSec: dur
        });
      }
      // 1秒細切れフラッシュ(rec.start(1000))によるMP4エンコーダの周期的スパイクを防ぎ、連続ストリームで記録
      rec.start();
      const t0 = performance.now();
      let lastExportDraw = t0 - 40;
      let lastProg = -1;
      let exportedFrames = 0;
      await new Promise((resolve) => {
        const loop = () => {
          const now = performance.now();
          const t = (now - t0) / 1000;
          // 120Hz/60Hz端末でも captureStream(30) に合わせた約30fps間隔でのみ合成し、エンコーダのGPU/CPU帯域を確保
          if (now - lastExportDraw >= 31 || t >= dur) {
            lastExportDraw = now;
            render(cctx, w, h, { wipeTime: t, endCardAlpha: calcEndAlpha(t) });
            if ((exportedFrames++ & 1) === 0) {
              pctx.drawImage(cv, 0, 0, pv.width, pv.height);
            }
          }
          if (now - lastProg >= 120) {
            lastProg = now;
            $("progressBar").style.width = Math.min(100, t / dur * 100) + "%";
          }
          if (t >= dur) return resolve();
          requestAnimationFrame(loop);
        };
        loop();
      });
      $("progressBar").style.width = "100%";
      rec.stop();
      await stopped;

      const cleanMime = (rec.mimeType || mime || "video/webm").split(";")[0];
      const blob = new Blob(chunks, { type: cleanMime });
      const filename = `before-after-${stamp()}.${ext}`;
      resultExp = storeLastExport(blob, filename, cleanMime, "video", sig, doDownload);
      if (doDownload) {
        download(blob, filename);
        setMsg(ext === "mp4"
          ? (wantBgm ? "BGM付きのMP4動画を保存しました。下のSNSボタンからそのまま投稿できます。" : "MP4を保存しました。下のSNSボタンからそのまま投稿できます。")
          : "WebMで保存しました（Instagramに投稿できない場合はMP4へ変換が必要です。READMEを参照）。", "ok");
      }
    } catch (err) {
      console.error(err);
      setMsg("書き出しに失敗しました：" + (err && err.message ? err.message : err), "err");
    } finally {
      if (bgmRec) bgmRec.stop();
      if (audioNode) { try { audioNode.disconnect(); } catch (e) {} }
      if (audioEl) audioEl.muted = true;
      state.exporting = false;
      markDirty();
      $("btnSave").disabled = false; $("btnPng").disabled = false;
      setSnsButtonsDisabled(false);
      setTimeout(() => { $("progressBox").hidden = true; }, 1200);
      restartVideos();
    }
    return resultExp;
  }

  function runCurrentExport(opts) {
    return currentExportMode() === "video" ? saveVideo(opts) : savePng(opts);
  }

  // ---------- SNS投稿文自動生成・共有シート／投稿画面起動 ----------
  const SNS_META = {
    youtube: {
      label: "YouTube",
      buildUrl: () => "https://www.youtube.com/upload",
      pcGuide: "📋 投稿文をコピーし、YouTubeアップロード画面を開きました。保存された動画をドラッグ＆ドロップし、説明欄に貼り付けてください。"
    },
    instagram: {
      label: "Instagram",
      buildUrl: () => "https://www.instagram.com/",
      pcGuide: "📋 投稿文をコピーし、Instagramを開きました。画面の「＋（作成）」へ保存された動画をドラッグ＆ドロップし、投稿文を貼り付けてください。"
    },
    facebook: {
      label: "Facebook",
      buildUrl: (_caption, kind) => kind === "image"
        ? "https://www.facebook.com/"
        : "https://www.facebook.com/reels/create/",
      pcGuide: "📋 投稿文をコピーし、Facebook投稿画面を開きました。保存されたファイルをドラッグ＆ドロップし、投稿文を貼り付けてください。"
    },
    x: {
      label: "X",
      buildUrl: (caption) => "https://x.com/intent/post?text=" + encodeURIComponent(caption),
      pcGuide: "📋 投稿文入りのX投稿画面を開きました。保存された動画・画像を画面へドラッグ＆ドロップして投稿してください。"
    },
    threads: {
      label: "Threads",
      buildUrl: (caption) => "https://www.threads.net/intent/post?text=" + encodeURIComponent(caption),
      pcGuide: "📋 投稿文入りのThreads投稿画面を開きました。保存された動画・画像を画面へドラッグ＆ドロップして投稿してください。"
    }
  };

  function isMobileOrTablet() {
    const ua = navigator.userAgent || "";
    if (/Android|iPhone|iPad|iPod/i.test(ua)) return true;
    if (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1) return true;
    return false;
  }
  function canShareFile(file) {
    try {
      return !!(file && typeof navigator !== "undefined" && typeof navigator.share === "function" &&
        typeof navigator.canShare === "function" && navigator.canShare({ files: [file] }));
    } catch (e) {
      return false;
    }
  }
  const supportsFileShare = (() => {
    try {
      const probe = new File([new Uint8Array([0])], "probe.mp4", { type: "video/mp4" });
      return canShareFile(probe);
    } catch (e) {
      return false;
    }
  })();

  function toHashtagToken(raw) {
    return String(raw || "")
      .replace(/[^\p{L}\p{N}_ー]+/gu, "")
      .trim();
  }
  function buildAutoCaption() {
    const sym = (state.symptom || "").trim();
    const age = (state.age || "").trim();
    const clinic = (state.clinic || "").trim();
    const sub = (state.sub || "").trim();
    const footer = (state.snsFooter || "").trim();

    const lines = [sym ? `【${sym}のビフォーアフター】` : "【施術ビフォーアフター】"];
    const meta = [age, sub].filter(Boolean).join("／");
    if (meta) lines.push(meta);

    lines.push("");
    lines.push(sym
      ? `同じような「${sym}」でお悩みの方はぜひ一度ご相談ください✨`
      : "お身体の不調や姿勢のお悩みはお気軽にご相談ください✨");
    if (clinic) lines.push(`📍 ${clinic}`);

    if (footer) {
      lines.push("");
      lines.push(footer);
    }

    const tags = [];
    const addTag = (t) => {
      const clean = toHashtagToken(t);
      if (clean && !tags.includes(clean)) tags.push(clean);
    };
    if (sym) {
      sym.split(/[・/／,、\s\u3000&＆＋+()（）【】「」『』]+/).forEach(addTag);
    }
    if (clinic) addTag(clinic);
    ["ビフォーアフター", "整体", "姿勢改善"].forEach(addTag);

    lines.push("");
    lines.push(tags.slice(0, 8).map(t => "#" + t).join(" "));
    return lines.join("\n");
  }
  function syncAutoCaption() {
    const el = $("snsCaption");
    if (!el || captionEdited) return;
    el.value = buildAutoCaption();
  }
  function getCaptionText() {
    const el = $("snsCaption");
    const val = el ? el.value.trim() : "";
    return val || buildAutoCaption();
  }

  function copyTextFallbackSync(text) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed;left:0;top:0;opacity:0;pointer-events:none";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      ta.setSelectionRange(0, text.length);
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return !!ok;
    } catch (e) {
      return false;
    }
  }
  // ユーザージェスチャー（window.open / navigator.share）を失わないよう await せず即座にコピーを発火
  function copyTextImmediate(text) {
    if (!text) return false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(() => { copyTextFallbackSync(text); });
        return true;
      }
    } catch (e) {}
    return copyTextFallbackSync(text);
  }
  async function copyTextAsync(text) {
    if (!text) return false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) {}
    return copyTextFallbackSync(text);
  }

  function setPendingSns(target) {
    pendingSnsTarget = target || null;
    document.querySelectorAll("[data-sns]").forEach((b) => {
      b.classList.toggle("pending-ready", b.dataset.sns === pendingSnsTarget);
    });
    const nb = $("btnNativeShare");
    if (nb) nb.classList.toggle("pending-ready", pendingSnsTarget === "native");
  }

  function initSnsUI() {
    const nb = $("btnNativeShare");
    const hint = $("snsHint");
    const mobile = isMobileOrTablet();
    if (nb) {
      if (supportsFileShare) {
        nb.hidden = false;
        nb.textContent = mobile
          ? "📲 スマホアプリ／カメラロールへ直接送る"
          : "📲 AirDrop／共有メニューでスマホへ送る";
      } else {
        nb.hidden = true;
      }
    }
    if (hint) {
      hint.textContent = (mobile && supportsFileShare)
        ? "ボタンを押すと共有シートが開き、選んだSNSアプリへ動画を直接渡せます（投稿文も自動コピーされます）。"
        : "ボタンを押すと投稿文を自動コピーして各SNSの投稿画面を開きます。保存された動画・画像をドラッグ＆ドロップして投稿してください。";
    }
    refreshSnsUI();
  }

  function refreshSnsUI() {
    const badge = $("snsReadyBadge");
    if (!badge) return;
    const ready = isExportFresh();
    if (!ready && pendingSnsTarget) setPendingSns(null);
    if (ready === lastSnsUiReady) return;
    lastSnsUiReady = ready;
    badge.classList.toggle("ready", ready);
    badge.textContent = ready ? "✅ 準備OK（ワンタップで投稿）" : "自動書き出し＋投稿文コピー";
  }

  function openSnsWebPage(platform, exp, caption) {
    const meta = SNS_META[platform];
    if (!meta) return;
    const url = meta.buildUrl(caption, exp ? exp.kind : currentExportMode());
    window.open(url, "_blank", "noopener,noreferrer");
    copyTextImmediate(caption);
    if (exp && !exp.downloaded) {
      download(exp.blob, exp.filename);
      exp.downloaded = true;
    }
    setPendingSns(null);
    setMsg(meta.pcGuide, "ok");
  }

  async function shareViaNativeSheet(exp, caption, targetLabel) {
    if (!exp || !exp.file || !canShareFile(exp.file)) return "unsupported";
    copyTextImmediate(caption);
    try {
      await navigator.share({ files: [exp.file] });
      setPendingSns(null);
      setMsg(targetLabel
        ? `📲 共有シートを開きました（投稿文もコピー済みです。「${targetLabel}」を選んで貼り付けてください）。`
        : "📲 共有シートを開きました（投稿文もクリップボードにコピー済みです）。", "ok");
      return "shared";
    } catch (err) {
      if (err && err.name === "AbortError") {
        setPendingSns(null);
        setMsg("📋 投稿文はコピー済みです。もう一度ボタンを押すと共有シートを開けます。", "ok");
        return "aborted";
      }
      if (err && err.name === "NotAllowedError") {
        return "gesture_expired";
      }
      return "failed";
    }
  }

  async function handleSnsAction(platform) {
    const meta = SNS_META[platform];
    if (!meta) return;
    if (state.exporting) {
      setMsg("現在書き出し中です。完了するまで少しお待ちください。");
      return;
    }
    if (!state.panels.before.el && !state.panels.after.el) {
      setMsg("先に「1. 写真・動画を選ぶ」でビフォー／アフターの画像か動画を追加してください。", "err");
      return;
    }
    if (!checkProGateBeforeExport()) return;

    const caption = getCaptionText();
    const mobileShare = isMobileOrTablet() && supportsFileShare;

    if (isExportFresh()) {
      if (mobileShare && lastExport.file && canShareFile(lastExport.file)) {
        const res = await shareViaNativeSheet(lastExport, caption, meta.label);
        if (res === "unsupported" || res === "failed") {
          openSnsWebPage(platform, lastExport, caption);
        }
        return;
      }
      openSnsWebPage(platform, lastExport, caption);
      return;
    }

    const tStart = performance.now();
    const exp = await runCurrentExport({ download: !mobileShare });
    if (!exp) return;

    if (mobileShare && exp.file && canShareFile(exp.file)) {
      const res = await shareViaNativeSheet(exp, caption, meta.label);
      if (res === "gesture_expired") {
        setPendingSns(platform);
        setMsg(`✅ 動画の準備完了＆投稿文をコピーしました！光っている「${meta.label}」をもう一度タップするとアプリへ送れます。`, "ok");
      } else if (res === "unsupported" || res === "failed") {
        if (!exp.downloaded) { download(exp.blob, exp.filename); exp.downloaded = true; }
        setPendingSns(platform);
        setMsg(`✅ 保存＆投稿文をコピーしました！もう一度「${meta.label}」をタップすると投稿画面が開きます。`, "ok");
      }
      return;
    }

    await copyTextAsync(caption);
    if (performance.now() - tStart < 1500) {
      openSnsWebPage(platform, exp, caption);
    } else {
      setPendingSns(platform);
      setMsg(`✅ 動画を保存＆投稿文をコピーしました！光っている「${meta.label}」ボタンをもう一度押すと投稿画面が開きます。`, "ok");
    }
  }

  async function handleNativeShare() {
    if (state.exporting) {
      setMsg("現在書き出し中です。完了するまで少しお待ちください。");
      return;
    }
    if (!state.panels.before.el && !state.panels.after.el) {
      setMsg("先に「1. 写真・動画を選ぶ」でビフォー／アフターの画像か動画を追加してください。", "err");
      return;
    }
    if (!checkProGateBeforeExport()) return;
    const caption = getCaptionText();
    if (isExportFresh() && lastExport.file && canShareFile(lastExport.file)) {
      const res = await shareViaNativeSheet(lastExport, caption, "");
      if (res === "unsupported" || res === "failed") {
        if (!lastExport.downloaded) { download(lastExport.blob, lastExport.filename); lastExport.downloaded = true; }
        setMsg("共有メニューを開けなかったため、ファイルを保存しました。", "err");
      }
      return;
    }
    const exp = await runCurrentExport({ download: false });
    if (!exp) return;
    const res = await shareViaNativeSheet(exp, caption, "");
    if (res === "gesture_expired") {
      setPendingSns("native");
      setMsg("✅ 準備完了＆投稿文をコピーしました！光っている共有ボタンをもう一度押すと開きます。", "ok");
    } else if (res === "unsupported" || res === "failed") {
      if (!exp.downloaded) { download(exp.blob, exp.filename); exp.downloaded = true; }
      setMsg("ファイルを保存し、投稿文をコピーしました。", "ok");
    }
  }

  // ---------- イベント登録 ----------
  function bind() {
    $("brandName").textContent = CFG.BRAND;
    [["inSymptom", "symptom"], ["inAge", "age"], ["inClinic", "clinic"], ["inSub", "sub"]].forEach(([id, key]) =>
      $(id).addEventListener("input", (e) => {
        state[key] = e.target.value.trim();
        if (key === "clinic") saveSettings();
        syncAutoCaption();
        markDirty();
      }));

    // ⑥ サイズ比率 ＆ ④ 比較レイアウト切替
    document.querySelectorAll("[data-aspect]").forEach((b) => {
      b.onclick = () => setAspect(b.dataset.aspect);
    });
    document.querySelectorAll("[data-layout]").forEach((b) => {
      b.onclick = () => setLayout(b.dataset.layout);
    });

    // ① 顔ぼかし（AI自動追従 ＋ 指定位置追従 ＋ 手動固定）
    $("chkFaceBlur").onchange = (e) => {
      state.faceBlur = e.target.checked;
      blurRingUntil = Date.now() + 2800;
      refreshBlurStatusUI();
      refreshProTrialUI();
      markDirty();
      if (state.faceBlur) {
        ["before", "after"].forEach((w) => {
          const p = state.panels[w];
          if (p.el && p.blur.enabled && p.blur.status === "idle") {
            p.blur.trackPromise = runFaceTrack(w, false);
          }
        });
      }
    };
    ["before", "after"].forEach((w) => {
      const W = cap(w);
      $("chkBlur" + W).onchange = (e) => {
        const p = state.panels[w];
        p.blur.enabled = e.target.checked;
        blurRingUntil = Date.now() + 2200;
        refreshBlurStatusUI();
        markDirty();
        if (state.faceBlur && p.blur.enabled && p.el && p.blur.status === "idle") {
          p.blur.trackPromise = runFaceTrack(w, false);
        }
      };
      $("selBlurMode" + W).onchange = (e) => {
        const p = state.panels[w];
        const nextMode = e.target.value;
        if (nextMode === "fixed") {
          if (FACE) {
            const curT = (p.type === "video" && p.el) ? p.el.currentTime : 0;
            const cur = FACE.sampleAtTime(p.blur, curT);
            p.blur.fixedX = cur.mx;
            p.blur.fixedY = cur.my;
            p.blur.baseR = cur.mr;
            p.blur.offsetX = 0;
            p.blur.offsetY = 0;
          }
          p.blur.mode = "fixed";
          p.blur.status = "fixed";
          blurRingUntil = Date.now() + 2600;
          refreshBlurStatusUI();
          markDirty();
        } else if (nextMode === "patch") {
          p.blur.mode = "patch";
          if (p.el) p.blur.trackPromise = runFaceTrack(w, true);
          else refreshBlurStatusUI();
        } else {
          p.blur.mode = "auto";
          if (p.el) p.blur.trackPromise = runFaceTrack(w, false);
          else refreshBlurStatusUI();
        }
      };
      $("blurSize" + W).oninput = (e) => {
        state.panels[w].blur.scale = clamp(parseFloat(e.target.value) || 1, 0.55, 2.3);
        blurRingUntil = Date.now() + 1800;
        markDirty();
      };
      $("btnRetrack" + W).onclick = () => {
        const p = state.panels[w];
        if (!p.el) {
          setMsg("先に写真・動画を追加してから「今の丸の位置から追従」を押してください。", "err");
          return;
        }
        p.blur.enabled = true;
        p.blur.trackPromise = runFaceTrack(w, true);
      };
    });

    // ② 姿勢チェック基準線・注目スタンプ（赤丸・矢印）
    $("chkPostureGrid").onchange = (e) => {
      state.posture.grid = e.target.checked;
      refreshProTrialUI();
      markDirty();
    };
    $("chkPostureLines").onchange = (e) => {
      state.posture.lines = e.target.checked;
      refreshProTrialUI();
      markDirty();
    };
    $("btnAddCircle").onclick = () => addMarker("circle");
    $("btnAddArrow").onclick = () => addMarker("arrow");
    $("btnRotateMarker").onclick = rotateSelectedMarker;
    $("btnClearMarkers").onclick = clearAllMarkers;

    // ③ 動画ラスト2秒の予約・LINE誘導カット（リール特化・QRなし）
    $("chkEndCard").onchange = (e) => {
      state.endCard.enabled = e.target.checked;
      if (!state.endCard.enabled) state.endCard.previewing = false;
      $("endCardBody").hidden = !state.endCard.enabled;
      refreshEndCardPreviewBtn();
      refreshBgmUI();
      refreshProTrialUI();
      markDirty();
    };
    [["inEndArea", "area"], ["inEndOffer", "offer"], ["inEndCta", "cta"]].forEach(([id, key]) => {
      $(id).addEventListener("input", (e) => {
        state.endCard[key] = e.target.value;
        saveSettings();
        markDirty();
      });
    });
    $("btnPreviewEndCard").onclick = () => {
      state.endCard.previewing = !state.endCard.previewing;
      refreshEndCardPreviewBtn();
      markDirty();
    };

    // ⑤ 免責ミニテロップ・症状別テンプレート保存・SNS固定フッター
    $("chkDisclaimer").onchange = (e) => {
      state.disclaimer.enabled = e.target.checked;
      $("disclaimerBody").hidden = !state.disclaimer.enabled;
      refreshProTrialUI();
      markDirty();
    };
    $("inDisclaimer").addEventListener("input", (e) => {
      state.disclaimer.text = e.target.value;
      saveSettings();
      markDirty();
    });
    $("btnSavePreset").onclick = saveCurrentPreset;
    $("inPresetName").addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); saveCurrentPreset(); }
    });
    $("inSnsFooter").addEventListener("input", (e) => {
      state.snsFooter = e.target.value;
      state.preferredSnsFooter = state.snsFooter;
      saveSettings();
      syncAutoCaption();
      refreshProTrialUI();
    });

    // 無料プランお試しバー・モーダル内ワンタップ解除
    $("btnTrialUpgrade").onclick = () => openModal();
    $("btnTrialReset").onclick = resetProOnlyFeatures;
    $("btnModalResetTrial").onclick = resetProOnlyFeatures;

    document.querySelectorAll("[data-pick]").forEach(b => b.onclick = () => $("file" + cap(b.dataset.pick)).click());
    const finishScrub = () => {
      if (!scrubbingTrim) return;
      scrubbingTrim = false;
      restartVideos();
    };
    ["before", "after"].forEach(w => {
      const W = cap(w);
      $("file" + W).onchange = (e) => { loadFile(w, e.target.files[0]); e.target.value = ""; };
      $("zoom" + W).oninput = (e) => setZoom(w, parseFloat(e.target.value));
      const trimEl = $("trim" + W);
      trimEl.oninput = (e) => {
        const p = state.panels[w];
        if (p.type !== "video") return;
        p.scanId++;
        p.scanning = false;
        syncToken++;
        syncingVideos = false;
        scrubbingTrim = true;
        clearLoopTimer();
        videos().forEach(vp => vp.el.pause());
        p.trimStart = clamp(Math.round((parseFloat(e.target.value) || 0) * 10) / 10, 0, maxTrimFor(p));
        try { p.el.currentTime = p.trimStart; } catch (err) {}
        refreshPick();
        markDirty();
      };
      ["change", "pointerup", "pointercancel", "touchend"].forEach(ev => trimEl.addEventListener(ev, finishScrub));
    });
    document.querySelectorAll("[data-trim]").forEach(b => b.onclick = () => {
      const [w, raw] = b.dataset.trim.split(":");
      const p = state.panels[w];
      if (!p || p.type !== "video") return;
      p.scanId++;
      p.scanning = false;
      const delta = parseFloat(raw);
      p.trimStart = delta === 0
        ? 0
        : clamp(Math.round((p.trimStart + delta) * 10) / 10, 0, maxTrimFor(p));
      scrubbingTrim = false;
      refreshPick();
      restartVideos();
    });
    $("chkAutoSync").onchange = (e) => {
      state.autoSync = e.target.checked;
      saveSettings();
      if (state.autoSync) {
        let needRestart = false;
        ["before", "after"].forEach(w => {
          const p = state.panels[w];
          if (p.type !== "video") return;
          if (p.autoDetected) {
            p.trimStart = clamp(p.autoTrimSec || 0, 0, maxTrimFor(p));
            needRestart = true;
          } else {
            autoDetectPanel(w);
          }
        });
        refreshPick();
        if (needRestart) restartVideos();
      } else {
        ["before", "after"].forEach(w => {
          const p = state.panels[w];
          p.scanId++;
          p.scanning = false;
          p.trimStart = 0;
        });
        refreshPick();
        restartVideos();
      }
    };
    $("btnResync").onclick = () => {
      if (!state.autoSync) {
        state.autoSync = true;
        $("chkAutoSync").checked = true;
        saveSettings();
      }
      ["before", "after"].forEach(w => {
        if (state.panels[w].type === "video") autoDetectPanel(w);
      });
    };
    document.querySelectorAll("[data-reset]").forEach(b => b.onclick = () => {
      const p = state.panels[b.dataset.reset]; p.ox = 0; p.oy = 0; setZoom(b.dataset.reset, 1);
    });
    document.querySelectorAll("[data-clear]").forEach(b => b.onclick = () => clearPanel(b.dataset.clear));
    $("btnSwap").onclick = () => {
      const t = state.panels.before; state.panels.before = state.panels.after; state.panels.after = t;
      refreshPick();
      refreshBlurStatusUI();
      ["before", "after"].forEach(w => {
        $("zoom" + cap(w)).value = state.panels[w].zoom;
      });
      markDirty();
    };

    ["cBg", "cText", "cAccent"].forEach(id => $(id).addEventListener("input", (e) => {
      state.custom[{ cBg: "bg", cText: "text", cAccent: "accent" }[id]] = e.target.value;
      saveSettings();
      renderThemes();
    }));

    Object.entries(TEXT_SLIDERS).forEach(([k, sliderId]) => {
      $(sliderId).addEventListener("input", (e) => {
        const g = getGeom();
        const b = textBaseFor(k);
        state.textPos[k].dy = clamp(parseInt(e.target.value, 10) || b.y, 45, g.LH - 45) - b.y;
        saveSettings();
        markDirty();
      });
    });
    $("btnCenterTextX").onclick = () => {
      Object.keys(TEXT_SLIDERS).forEach((k) => { state.textPos[k].dx = 0; });
      saveSettings();
      markDirty();
    };
    $("btnResetTextPos").onclick = () => {
      state.textPos = newTextPos();
      syncTextSliders();
      saveSettings();
      markDirty();
    };

    $("chkBgm").onchange = (e) => {
      state.bgm.enabled = e.target.checked;
      if (!state.bgm.enabled) stopBgmPreview();
      saveSettings();
      refreshBgmUI();
    };
    $("btnBgmPreview").onclick = toggleBgmPreview;
    $("btnBgmNext").onclick = nextBgmTrack;
    $("bgmVol").oninput = (e) => {
      state.bgm.volume = clamp(parseFloat(e.target.value) || 0.7, 0.1, 1);
      if (bgmPreview) bgmPreview.setVolume(state.bgm.volume);
      saveSettings();
      refreshSnsUI();
    };
    $("selPhotoSec").onchange = (e) => {
      state.bgm.photoSec = parseInt(e.target.value, 10) || 8;
      saveSettings();
      refreshSnsUI();
    };
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        stopBgmPreview();
      } else if (pro && apiBase() && !state.exporting) {
        verifyActiveLicense({ silent: false, force: false });
      }
    });

    $("btnLogo").onclick = () => { if (requirePro("ロゴ挿入")) $("fileLogo").click(); };
    $("fileLogo").onchange = (e) => {
      const f = e.target.files[0]; e.target.value = "";
      if (!f) return;
      if (!f.type.startsWith("image/")) { setMsg("ロゴには画像ファイルを選んでください。", "err"); return; }
      const nextUrl = URL.createObjectURL(f);
      const img = new Image();
      img.onload = () => {
        if (!img.naturalWidth || !img.naturalHeight) {
          URL.revokeObjectURL(nextUrl);
          setMsg("このロゴ画像はサイズを取得できませんでした（PNGまたはJPEGをお試しください）。", "err");
          return;
        }
        if (logoUrl) URL.revokeObjectURL(logoUrl);
        logoUrl = nextUrl;
        state.logo = img;
        $("btnLogoClear").hidden = false;
        setMsg("");
        markDirty();
      };
      img.onerror = () => {
        URL.revokeObjectURL(nextUrl);
        setMsg("このロゴ画像は読み込めませんでした。", "err");
      };
      img.src = nextUrl;
    };
    $("btnLogoClear").onclick = clearLogo;

    $("selQuality").onchange = (e) => {
      const sp = getSpec();
      if (e.target.value === "1080" && !requirePro(`${sp.proW}×${sp.proH} 高画質`)) e.target.value = "720";
      refreshQualityLabels();
      refreshSnsUI();
    };
    $("selAudio").onchange = () => refreshSnsUI();

    $("btnPlay").onclick = () => setPlaying(!state.playing);
    $("btnRestart").onclick = restartVideos;
    $("chkGuide").onchange = (e) => { state.guide = e.target.checked; markDirty(); };
    $("btnPng").onclick = () => savePng();
    $("btnSave").onclick = () => runCurrentExport();

    document.querySelectorAll("[data-sns]").forEach((btn) => {
      btn.onclick = () => handleSnsAction(btn.dataset.sns);
    });
    $("btnNativeShare").onclick = handleNativeShare;
    $("snsCaption").addEventListener("input", () => { captionEdited = true; });
    $("btnCopyCaption").onclick = async () => {
      const ok = await copyTextAsync(getCaptionText());
      setMsg(ok ? "📋 投稿文とハッシュタグをコピーしました。" : "投稿文を選択してコピーしてください。", ok ? "ok" : "");
    };
    $("btnResetCaption").onclick = () => {
      captionEdited = false;
      syncAutoCaption();
      setMsg("🔄 入力内容から投稿文とハッシュタグを再生成しました。", "ok");
    };

    $("btnUpgrade").onclick = () => openModal();
    $("btnPlanBarUpgrade").onclick = () => openModal();
    $("modalClose").onclick = () => { $("modal").hidden = true; };
    $("modal").addEventListener("click", (e) => { if (e.target === $("modal")) $("modal").hidden = true; });
    $("btnBuy").addEventListener("click", (e) => { if (!CFG.PAYMENT_URL) e.preventDefault(); });

    const doActivate = async () => {
      const key = $("inKey").value;
      if (!key.trim()) {
        $("keyMsg").textContent = "ライセンスキーを入力してください。";
        $("keyMsg").className = "msg err";
        return;
      }
      const btn = $("btnActivate");
      btn.disabled = true;
      $("keyMsg").textContent = "ライセンスを確認しています…";
      $("keyMsg").className = "msg";
      try {
        await activateLicenseKey(key);
        $("inKey").value = "";
        $("keyMsg").textContent = "";
        $("proMsg").textContent = "⭐ 有料プランを有効化しました！";
        $("proMsg").className = "msg ok";
        setMsg("⭐ 有料プランを有効化しました（透かしなし・全プロ機能が解放されました）。", "ok");
      } catch (e) {
        $("keyMsg").textContent = e.message || "有効化に失敗しました。";
        $("keyMsg").className = "msg err";
      } finally {
        btn.disabled = false;
      }
    };
    $("btnActivate").onclick = doActivate;
    $("inKey").addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); doActivate(); }
    });

    const doRecoverKey = async () => {
      const emailInput = $("inRecoverEmail");
      const msgEl = $("recoverMsg");
      const btn = $("btnRecoverKey");
      if (!emailInput || !msgEl || !btn) return;
      const email = emailInput.value.trim();
      msgEl.hidden = false;
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        msgEl.textContent = "購入時にご登録のメールアドレスを正しく入力してください。";
        msgEl.className = "msg err";
        return;
      }
      if (!apiBase()) {
        msgEl.textContent = "現在メール自動再送サーバーに接続できません。公式LINE窓口へお問い合わせください。";
        msgEl.className = "msg err";
        return;
      }
      btn.disabled = true;
      msgEl.textContent = "ご登録情報を確認してメールを送信しています…";
      msgEl.className = "msg";
      try {
        const res = await postLicenseApi("/api/recover-key", { email }, 10000);
        const d = res.data || {};
        if (res.okHttp && d.ok) {
          emailInput.value = "";
          msgEl.textContent = d.message || "ご登録メールアドレス宛にライセンスキーと有効化リンクを再送しました。";
          msgEl.className = "msg ok";
        } else {
          msgEl.textContent = d.message || "再送手続きに失敗しました。しばらく時間をおいて再度お試しください。";
          msgEl.className = "msg err";
        }
      } catch (e) {
        msgEl.textContent = "通信エラーが発生しました。電波状況をご確認のうえ再度お試しください。";
        msgEl.className = "msg err";
      } finally {
        btn.disabled = false;
      }
    };
    if ($("btnRecoverKey")) $("btnRecoverKey").onclick = doRecoverKey;
    if ($("inRecoverEmail")) {
      $("inRecoverEmail").addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); doRecoverKey(); }
      });
    }

    $("btnToggleKey").onclick = () => {
      showFullKey = !showFullKey;
      syncModalView();
    };
    $("btnCopyKey").onclick = copySavedLicenseKey;
    $("btnDeactivate").onclick = deactivateCurrentDevice;
  }

  loadSettings();
  bind();
  initLicense();
  if (document.fonts) {
    const bumpFont = () => { fontEpoch++; markDirty(); };
    if (document.fonts.load) document.fonts.load('900 40px "Noto Sans JP"').then(bumpFont).catch(() => {});
    if (document.fonts.ready) document.fonts.ready.then(bumpFont).catch(() => {});
  }
  requestAnimationFrame(tick);
})();
