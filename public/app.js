(() => {
  "use strict";
  const CFG = window.BAM_CONFIG;
  const $ = (id) => document.getElementById(id);

  // ---------- 定数（論理座標は 1080x1920 固定） ----------
  const LW = 1080, LH = 1920;
  const TOP_H = 360;                 // 上部帯（症状・年齢）
  const BOTTOM_Y = 1500;             // 下部帯の開始位置（院名）
  const GAP = 6;                     // 左右の仕切り
  const PANEL_Y = TOP_H, PANEL_H = BOTTOM_Y - TOP_H;
  const PANEL_W = (LW - GAP) / 2;
  const FONT = '"Noto Sans JP","Hiragino Sans","Hiragino Kaku Gothic ProN",Meiryo,sans-serif';

  const THEMES = {
    dark:  { name: "ダーク",   pro: false, bg: "#111111", text: "#ffffff", accent: "#ff5a5f" },
    white: { name: "ホワイト", pro: false, bg: "#ffffff", text: "#1a1a1a", accent: "#e8454b" },
    gold:  { name: "ゴールド", pro: true,  bg: "#1b1608", text: "#fff6dc", accent: "#e6b422" },
    mint:  { name: "ミント",   pro: true,  bg: "#0e2a26", text: "#eafff9", accent: "#2fd1a8" },
    navy:  { name: "ネイビー", pro: true,  bg: "#0c1b3a", text: "#f0f5ff", accent: "#4da3ff" },
    custom:{ name: "自由配色", pro: true,  bg: "#111111", text: "#ffffff", accent: "#ff5a5f" }
  };

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  const TEXT_BASE = {
    symptom: { x: LW / 2, y: 125,  slider: "posSymptomY" },
    age:     { x: LW / 2, y: 250,  slider: "posAgeY" },
    clinic:  { x: LW / 2, y: 1590, slider: "posClinicY" },
    sub:     { x: LW / 2, y: 1700, slider: "posSubY" }
  };
  const newTextPos = () => ({
    symptom: { dx: 0, dy: 0 },
    age:     { dx: 0, dy: 0 },
    clinic:  { dx: 0, dy: 0 },
    sub:     { dx: 0, dy: 0 }
  });

  const BGM = window.BAM_BGM;

  // ---------- 状態 ----------
  const newPanel = () => ({ type: null, el: null, url: null, name: "", zoom: 1, ox: 0, oy: 0 });
  const state = {
    symptom: "", age: "", clinic: "", sub: "",
    theme: "dark",
    preferredTheme: "dark",
    custom: { bg: "#111111", text: "#ffffff", accent: "#ff5a5f" },
    textPos: newTextPos(),
    bgm: { enabled: true, seed: 1, volume: 0.7, photoSec: 8 },
    guide: false, playing: true, exporting: false,
    logo: null,
    panels: { before: newPanel(), after: newPanel() }
  };

  let bgmPreview = null;

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
    const willVideo = Object.values(state.panels).some(p => p.type === "video") || state.bgm.enabled;
    $("btnSave").textContent = willVideo
      ? (state.bgm.enabled ? "💾 動画で保存する（🎵BGM付き）" : "💾 動画で保存する")
      : "💾 画像（PNG）で保存する";
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

  function textXY(key) {
    const b = TEXT_BASE[key], p = state.textPos[key];
    return {
      x: clamp(b.x + p.dx, 80, LW - 80),
      y: clamp(b.y + p.dy, 60, LH - 60)
    };
  }
  function syncTextSliders() {
    Object.entries(TEXT_BASE).forEach(([k, b]) => {
      const el = $(b.slider);
      if (el) el.value = Math.round(textXY(k).y);
    });
  }

  // ---------- 設定の保存・復元 ----------
  const LS_SETTINGS = "bam_settings_v1";
  const isHex = (v) => typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v);

  function saveSettings() {
    try {
      localStorage.setItem(LS_SETTINGS, JSON.stringify({
        theme: state.preferredTheme || state.theme,
        custom: state.custom,
        textPos: state.textPos,
        bgm: state.bgm
      }));
    } catch (e) {}
  }

  function loadSettings() {
    try {
      const raw = localStorage.getItem(LS_SETTINGS);
      if (raw) {
        const d = JSON.parse(raw);
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
          Object.keys(TEXT_BASE).forEach((k) => {
            const tp = d.textPos[k], b = TEXT_BASE[k];
            if (tp && typeof tp.dx === "number" && isFinite(tp.dx)) {
              state.textPos[k].dx = clamp(Math.round(tp.dx), 80 - b.x, LW - 80 - b.x);
            }
            if (tp && typeof tp.dy === "number" && isFinite(tp.dy)) {
              state.textPos[k].dy = clamp(Math.round(tp.dy), 60 - b.y, LH - 60 - b.y);
            }
          });
        }
        if (d && d.bgm) {
          if (typeof d.bgm.enabled === "boolean") state.bgm.enabled = d.bgm.enabled;
          if (typeof d.bgm.seed === "number" && d.bgm.seed >= 1) state.bgm.seed = Math.floor(d.bgm.seed);
          if (typeof d.bgm.volume === "number" && isFinite(d.bgm.volume)) state.bgm.volume = clamp(d.bgm.volume, 0.1, 1);
          if ([5, 8, 10, 15].includes(Number(d.bgm.photoSec))) state.bgm.photoSec = Number(d.bgm.photoSec);
        }
      }
    } catch (e) {}
    $("bgmVol").value = state.bgm.volume;
    $("selPhotoSec").value = String(state.bgm.photoSec);
    syncTextSliders();
    refreshBgmUI();
  }

  // ---------- ライセンス ----------
  const LS_KEY = "bam_license";
  let pro = false;

  async function sha256(str) {
    if (!(window.crypto && crypto.subtle)) throw new Error("HTTPS（またはlocalhost）で開いてください");
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
  }
  const normKey = (k) => k.trim().toUpperCase().replace(/\s+/g, "");

  async function checkLicense(key) {
    try { return CFG.LICENSE_HASHES.includes(await sha256(normKey(key))); }
    catch (e) { return false; }
  }

  function applyPlan() {
    $("planBadge").textContent = pro ? "⭐ 有料プラン" : "無料プラン";
    $("planBadge").className = "badge " + (pro ? "pro" : "free");
    $("btnUpgrade").hidden = pro;
    $("optHQ").textContent = pro ? "1080×1920（高画質）" : "🔒 1080×1920（有料）";
    $("btnLogo").textContent = pro ? "ロゴを追加" : "🔒 ロゴを追加（有料）";
    $("btnDeactivate").hidden = !pro;
    if (pro && state.preferredTheme && THEMES[state.preferredTheme]) {
      state.theme = state.preferredTheme;
    } else if (!pro) {
      if (THEMES[state.theme].pro) state.theme = "dark";
      $("selQuality").value = "720";
      state.logo = null;
      $("btnLogoClear").hidden = true;
    }
    const lim = pro ? CFG.LIMITS.pro : CFG.LIMITS.free;
    $("limitHint").textContent =
      `現在のプラン：${lim.width}×${lim.height} ／ 動画は最大${lim.maxSeconds}秒` +
      (pro ? "" : " ／ 透かしあり") +
      "。MP4で保存できない環境ではWebMで保存されます。";
    renderThemes();
  }

  async function initLicense() {
    const saved = localStorage.getItem(LS_KEY);
    pro = saved ? await checkLicense(saved) : false;
    if (saved && !pro) localStorage.removeItem(LS_KEY);
    applyPlan();
  }

  // ---------- モーダル ----------
  function openModal(reason) {
    $("priceLabel").textContent = CFG.PRO_PRICE_LABEL;
    $("priceNote").textContent = CFG.PRO_PRICE_NOTE;
    const buy = $("btnBuy");
    if (CFG.PAYMENT_URL) { buy.href = CFG.PAYMENT_URL; buy.removeAttribute("aria-disabled"); }
    else { buy.removeAttribute("href"); }
    $("buyNote").textContent = CFG.PAYMENT_URL
      ? "お申し込み後、ライセンスキーをお送りします。下の欄に入力すると有効になります。"
      : "※購入ページは準備中です（管理者が config.js の PAYMENT_URL を設定してください）。";
    $("keyMsg").textContent = reason ? reason : "";
    $("keyMsg").className = "msg";
    $("modal").hidden = false;
  }
  function requirePro(feature) {
    if (pro) return true;
    openModal(`「${feature}」は有料プランの機能です。`);
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
    while (size > min) {
      ctx.font = `${weight} ${size}px ${FONT}`;
      if (ctx.measureText(text).width <= maxW) return size;
      size -= 2;
    }
    ctx.font = `${weight} ${min}px ${FONT}`;
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
  function drawMedia(ctx, p, x, y, w, h, th, placeholder, label) {
    ctx.save();
    ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
    const s = mediaSize(p);
    if (s) {
      const sc = Math.max(w / s.w, h / s.h) * p.zoom;
      const dw = s.w * sc, dh = s.h * sc;
      const { rx, ry } = panelRange(p, w, h);
      const dx = x + (w - dw) / 2 + p.ox * rx;
      const dy = y + (h - dh) / 2 + p.oy * ry;
      ctx.drawImage(p.el, dx, dy, dw, dh);
    } else {
      ctx.fillStyle = "rgba(128,128,128,0.18)";
      ctx.fillRect(x, y, w, h);
      if (placeholder) {
        ctx.fillStyle = "rgba(160,160,160,0.9)";
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.font = `700 48px ${FONT}`;
        ctx.fillText(label, x + w / 2, y + h / 2 - 30);
        ctx.font = `500 34px ${FONT}`;
        ctx.fillText("画像・動画を追加", x + w / 2, y + h / 2 + 34);
      }
    }
    ctx.restore();
  }
  function badge(ctx, text, x, y, color, textColor) {
    ctx.font = `900 54px ${FONT}`;
    const w = ctx.measureText(text).width + 56, h = 84;
    ctx.fillStyle = color;
    rr(ctx, x, y, w, h, 18); ctx.fill();
    ctx.fillStyle = textColor;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(text, x + w / 2, y + h / 2 + 3);
  }

  // ---------- メイン描画（preview / export 共通） ----------
  const textBoxes = { symptom: null, age: null, clinic: null, sub: null };

  function render(c, W, H, opt) {
    opt = opt || {};
    const th = theme();
    c.save();
    c.setTransform(W / LW, 0, 0, H / LH, 0, 0);
    c.clearRect(0, 0, LW, LH);

    // 背景
    c.fillStyle = th.bg; c.fillRect(0, 0, LW, LH);

    // 中央：左右比較（文字を写真上に重ねられるよう先に描画）
    const B = state.panels.before, A = state.panels.after;
    drawMedia(c, B, 0, PANEL_Y, PANEL_W, PANEL_H, th, opt.preview, "BEFORE");
    drawMedia(c, A, PANEL_W + GAP, PANEL_Y, PANEL_W, PANEL_H, th, opt.preview, "AFTER");
    c.fillStyle = th.bg; c.fillRect(PANEL_W, PANEL_Y, GAP, PANEL_H);
    badge(c, "BEFORE", 24, PANEL_Y + 24, "rgba(70,76,88,0.92)", "#fff");
    badge(c, "AFTER", PANEL_W + GAP + 24, PANEL_Y + 24, th.accent, "#fff");

    // 上部テキスト：症状・年齢
    c.textAlign = "center"; c.textBaseline = "middle";
    const symptom = state.symptom || (opt.preview ? "症状を入力" : "");
    if (symptom) {
      const { x: sx, y: sy } = textXY("symptom");
      c.fillStyle = state.symptom ? th.text : "rgba(160,160,160,0.7)";
      const sz = fit(c, symptom, 960, 132, 52, 900);
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
      const sz = fit(c, age, 800, 64, 34, 700);
      const tw = c.measureText(age).width + 80, ph = sz + 40;
      c.fillStyle = state.age ? th.accent : "rgba(160,160,160,0.35)";
      rr(c, ax - tw / 2, ay - ph / 2 + 4, tw, ph, ph / 2); c.fill();
      c.fillStyle = "#fff"; c.textAlign = "center"; c.textBaseline = "middle";
      c.fillText(age, ax, ay + 4);
      if (opt.preview) {
        textBoxes.age = { x: ax - tw / 2 - 16, y: ay - ph / 2 - 12, w: tw + 32, h: ph + 24 };
      }
    } else if (opt.preview) {
      textBoxes.age = null;
    }

    // 下部テキスト：院名（ロゴは左）・補足
    const clinic = state.clinic || (opt.preview ? "院名を入力" : "");
    const { x: cx, y: cy } = textXY("clinic");
    if (clinic) {
      c.textAlign = "center"; c.textBaseline = "middle";
      let maxW = 960, logoW = 0, logoH = 0;
      if (state.logo && pro) {
        logoH = 120; logoW = state.logo.naturalWidth / state.logo.naturalHeight * logoH;
        logoW = Math.min(logoW, 260); maxW = 960 - logoW - 30;
      }
      const sz = fit(c, clinic, maxW, 88, 38, 900);
      const tw = c.measureText(clinic).width;
      const total = tw + (logoW ? logoW + 30 : 0);
      const left = cx - total / 2;
      if (logoW) {
        const lh = logoW / (state.logo.naturalWidth / state.logo.naturalHeight);
        c.drawImage(state.logo, left, cy - lh / 2, logoW, lh);
      }
      c.textAlign = "left";
      c.fillStyle = state.clinic ? th.text : "rgba(160,160,160,0.7)";
      c.fillText(clinic, left + (logoW ? logoW + 30 : 0), cy + 2);
      if (opt.preview) {
        const bh = Math.max(sz + 36, logoW ? 130 : 96);
        const bw = Math.max(240, total + 48);
        textBoxes.clinic = { x: cx - bw / 2, y: cy - bh / 2, w: bw, h: bh };
      }
    } else if (state.logo && pro) {
      const lh = 120, lw = Math.min(state.logo.naturalWidth / state.logo.naturalHeight * lh, 400);
      c.drawImage(state.logo, cx - lw / 2, cy - lh / 2, lw, lh);
      if (opt.preview) {
        textBoxes.clinic = { x: cx - lw / 2 - 20, y: cy - lh / 2 - 16, w: lw + 40, h: lh + 32 };
      }
    } else if (opt.preview) {
      textBoxes.clinic = null;
    }

    if (state.sub) {
      const { x: sx, y: sy } = textXY("sub");
      c.textAlign = "center"; c.textBaseline = "middle";
      c.fillStyle = th.text; c.globalAlpha = 0.8;
      const sz = fit(c, state.sub, 940, 48, 28, 500);
      c.fillText(state.sub, sx, sy);
      c.globalAlpha = 1;
      if (opt.preview) {
        const tw = Math.max(200, c.measureText(state.sub).width);
        textBoxes.sub = { x: sx - tw / 2 - 24, y: sy - sz / 2 - 20, w: tw + 48, h: sz + 40 };
      }
    } else if (opt.preview) {
      textBoxes.sub = null;
    }

    // 透かし（無料）
    if (!pro && !opt.noWatermark) {
      c.textAlign = "center"; c.textBaseline = "middle";
      c.font = `500 30px ${FONT}`;
      c.fillStyle = th.text; c.globalAlpha = 0.5;
      c.fillText(CFG.WATERMARK_TEXT, LW / 2, 1868);
      c.globalAlpha = 1;
    }

    // 文字ドラッグ中のガイド線（プレビューのみ）
    if (opt.preview && drag && drag.kind === "text") {
      c.save();
      if (state.textPos[drag.key].dx === 0) {
        c.strokeStyle = "rgba(53,194,138,0.75)";
        c.lineWidth = 3;
        c.setLineDash([12, 10]);
        c.beginPath(); c.moveTo(LW / 2, 0); c.lineTo(LW / 2, LH); c.stroke();
      }
      const tb = textBoxes[drag.key];
      if (tb) {
        c.strokeStyle = "rgba(255,255,255,0.65)";
        c.lineWidth = 3;
        c.setLineDash([10, 8]);
        rr(c, tb.x, tb.y, tb.w, tb.h, 16);
        c.stroke();
      }
      c.restore();
    }

    // 安全域ガイド（プレビューのみ）
    if (opt.guide) {
      c.fillStyle = "rgba(255,0,0,0.18)";
      c.fillRect(0, 0, LW, 120);
      c.fillRect(0, 1640, LW, LH - 1640);
      c.fillRect(960, 1000, 120, 640);
      c.fillStyle = "#fff"; c.font = `500 28px ${FONT}`; c.textAlign = "center";
      c.fillText("Instagram UIで隠れやすい範囲（目安）", LW / 2, 1880);
    }
    c.restore();
  }

  // ---------- プレビュー ----------
  const pv = $("preview"), pctx = pv.getContext("2d");
  function tick() {
    render(pctx, pv.width, pv.height, { preview: true, guide: state.guide });
    requestAnimationFrame(tick);
  }

  // ---------- メディア読み込み ----------
  function setMsg(text, kind) { const m = $("msg"); m.textContent = text || ""; m.className = "msg " + (kind || ""); }
  function refreshPick() {
    ["before", "after"].forEach(w => {
      const p = state.panels[w], el = $("name" + cap(w));
      el.textContent = p.name || "タップして選ぶ";
      el.closest(".pick").classList.toggle("done", !!p.el);
    });
    refreshBgmUI();
  }
  function videos() { return Object.values(state.panels).filter(p => p.type === "video"); }

  function loadFile(which, file) {
    if (!file) return;
    const p = state.panels[which];
    const isVideo = file.type.startsWith("video/");
    const isImage = file.type.startsWith("image/");
    if (!isVideo && !isImage) { setMsg("画像または動画ファイルを選んでください。", "err"); return; }
    const url = URL.createObjectURL(file);
    const done = (el, type) => {
      if (p.url) URL.revokeObjectURL(p.url);
      Object.assign(p, { type, el, url, name: file.name, zoom: 1, ox: 0, oy: 0 });
      $("zoom" + cap(which)).value = 1;
      refreshPick();
      setMsg("");
      if (type === "video") restartVideos();
    };
    if (isVideo) {
      const v = document.createElement("video");
      v.muted = true; v.loop = true; v.playsInline = true; v.preload = "auto";
      v.onloadeddata = () => done(v, "video");
      v.onerror = () => setMsg("この動画は読み込めませんでした（形式を確認してください）。", "err");
      v.src = url;
    } else {
      const img = new Image();
      img.onload = () => done(img, "image");
      img.onerror = () => setMsg("この画像は読み込めませんでした。", "err");
      img.src = url;
    }
  }
  const cap = (s) => s[0].toUpperCase() + s.slice(1);

  function clearPanel(which) {
    const p = state.panels[which];
    if (p.type === "video") p.el.pause();
    if (p.url) URL.revokeObjectURL(p.url);
    state.panels[which] = newPanel();
    refreshPick();
    $("zoom" + cap(which)).value = 1;
  }

  function restartVideos() {
    videos().forEach(p => {
      p.el.currentTime = 0;
      if (state.playing) p.el.play().catch(() => {});
    });
  }
  function setPlaying(on) {
    state.playing = on;
    $("btnPlay").textContent = on ? "⏸ 停止" : "▶ 再生";
    videos().forEach(p => on ? p.el.play().catch(() => {}) : p.el.pause());
  }

  // ---------- プレビュー操作（ドラッグ/ホイール/ドロップ） ----------
  function logical(e) {
    const r = pv.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width * LW, y: (e.clientY - r.top) / r.height * LH };
  }
  function hitPanel(pt) {
    if (pt.y < PANEL_Y || pt.y > PANEL_Y + PANEL_H) return null;
    return pt.x < PANEL_W + GAP / 2 ? "before" : "after";
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
    if (pointers.size === 1) {
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
    if (drag.kind === "text") {
      const b = TEXT_BASE[drag.key];
      drag.rawDx = clamp(drag.rawDx + (pt.x - drag.last.x), 80 - b.x, LW - 80 - b.x);
      drag.rawDy = clamp(drag.rawDy + (pt.y - drag.last.y), 60 - b.y, LH - 60 - b.y);
      state.textPos[drag.key].dx = Math.abs(drag.rawDx) < 24 ? 0 : Math.round(drag.rawDx);
      state.textPos[drag.key].dy = Math.round(drag.rawDy);
      drag.last = pt;
      drag.moved = true;
      syncTextSliders();
      return;
    }
    const p = state.panels[drag.which];
    const { rx, ry } = panelRange(p, PANEL_W, PANEL_H);
    if (rx > 0) p.ox = clamp(p.ox + (pt.x - drag.last.x) / rx, -1, 1);
    if (ry > 0) p.oy = clamp(p.oy + (pt.y - drag.last.y) / ry, -1, 1);
    drag.last = pt;
  });
  const endPtr = (e) => {
    if (drag && drag.kind === "text" && drag.moved && pointers.size <= 1) saveSettings();
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (!pointers.size) drag = null;
  };
  pv.addEventListener("pointerdown", (e) => {
    const pt = logical(e);
    tapStart = hitText(pt) ? null : pt;
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
    const which = hitPanel(logical(e)); if (!which) return;
    e.preventDefault();
    setZoom(which, state.panels[which].zoom * (e.deltaY < 0 ? 1.05 : 0.95));
  }, { passive: false });
  pv.addEventListener("dragover", (e) => e.preventDefault());
  pv.addEventListener("drop", (e) => {
    e.preventDefault();
    const which = hitPanel(logical(e)) || (logical(e).x < LW / 2 ? "before" : "after");
    loadFile(which, e.dataTransfer.files[0]);
  });

  function setZoom(which, z) {
    const p = state.panels[which];
    p.zoom = clamp(z, 1, 3);
    $("zoom" + cap(which)).value = p.zoom;
    const { rx, ry } = panelRange(p, PANEL_W, PANEL_H);   // ズーム縮小時のはみ出し補正
    if (rx === 0) p.ox = 0; if (ry === 0) p.oy = 0;
  }

  // ---------- 書き出し ----------
  function lim() { return pro ? CFG.LIMITS.pro : CFG.LIMITS.free; }
  function exportSize() {
    const hq = pro && $("selQuality").value === "1080";
    return hq ? { w: CFG.LIMITS.pro.width, h: CFG.LIMITS.pro.height } : { w: CFG.LIMITS.free.width, h: CFG.LIMITS.free.height };
  }
  function download(blob, filename) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  const stamp = () => { const d = new Date(), z = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}`; };

  function savePng() {
    if (!state.panels.before.el && !state.panels.after.el) { setMsg("先にビフォー／アフターの画像か動画を追加してください。", "err"); return; }
    const { w, h } = exportSize();
    const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
    render(cv.getContext("2d"), w, h, {});
    cv.toBlob((b) => { download(b, `before-after-${stamp()}.png`); setMsg("PNGを保存しました。", "ok"); }, "image/png");
  }

  function pickMime() {
    const list = [
      'video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1', 'video/mp4',
      'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'
    ];
    return list.find(t => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || "";
  }
  function seekZero(v) {
    return new Promise((res) => {
      let done = false; const f = () => { if (!done) { done = true; v.removeEventListener("seeked", f); res(); } };
      v.addEventListener("seeked", f); v.currentTime = 0; setTimeout(f, 800);
    });
  }

  async function saveVideo() {
    if (state.exporting) return;
    stopBgmPreview();
    if (!state.panels.before.el && !state.panels.after.el) {
      setMsg("先にビフォー／アフターの写真か動画を追加してください。", "err");
      return;
    }
    const vids = videos();
    if (!vids.length && !state.bgm.enabled) {
      savePng();
      return;
    }
    if (!window.MediaRecorder) {
      setMsg("このブラウザは動画書き出しに非対応です。Chrome / Edge / Safari 最新版をお使いください。", "err");
      return;
    }

    const { w, h } = exportSize();
    const maxSec = lim().maxSeconds;
    let dur;
    if (vids.length) {
      const longest = Math.max(...vids.map(p => p.el.duration || 0));
      dur = Math.min(maxSec, isFinite(longest) && longest > 0 ? longest : maxSec);
    } else {
      dur = Math.min(maxSec, state.bgm.photoSec || 8);
    }
    const mime = pickMime();
    const ext = mime.includes("mp4") ? "mp4" : "webm";
    const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
    const cctx = cv.getContext("2d");

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

    state.exporting = true;
    $("btnSave").disabled = true; $("btnPng").disabled = true;
    $("progressBox").hidden = false; $("progressBar").style.width = "0%";
    setMsg(`書き出し中…（約${Math.ceil(dur)}秒）このタブを開いたままにしてください。`);

    try {
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

      // 頭出し
      vids.forEach(p => p.el.pause());
      await Promise.all(vids.map(p => seekZero(p.el)));

      const rec = new MediaRecorder(stream, Object.assign(
        { videoBitsPerSecond: pro ? 10_000_000 : 6_000_000 },
        mime ? { mimeType: mime } : {}
      ));
      const chunks = [];
      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      const stopped = new Promise((res) => { rec.onstop = res; });

      render(cctx, w, h, {});
      if (wantBgm && audioCtx && dest) {
        bgmRec = BGM.start(audioCtx, dest, {
          seed: state.bgm.seed,
          volume: state.bgm.volume,
          durationSec: dur
        });
      }
      rec.start(250);
      await Promise.all(vids.map(p => p.el.play().catch(() => {})));
      const t0 = performance.now();
      await new Promise((resolve) => {
        const loop = () => {
          const t = (performance.now() - t0) / 1000;
          render(cctx, w, h, {});
          $("progressBar").style.width = Math.min(100, t / dur * 100) + "%";
          if (t >= dur) return resolve();
          requestAnimationFrame(loop);
        };
        loop();
      });
      rec.stop();
      await stopped;

      const blob = new Blob(chunks, { type: (rec.mimeType || mime || "video/webm").split(";")[0] });
      download(blob, `before-after-${stamp()}.${ext}`);
      setMsg(ext === "mp4"
        ? (wantBgm ? "BGM付きのMP4動画を保存しました。" : "MP4を保存しました。")
        : "WebMで保存しました（Instagramに投稿できない場合はMP4へ変換が必要です。READMEを参照）。", "ok");
    } catch (err) {
      console.error(err);
      setMsg("書き出しに失敗しました：" + (err && err.message ? err.message : err), "err");
    } finally {
      if (bgmRec) bgmRec.stop();
      if (audioNode) { try { audioNode.disconnect(); } catch (e) {} }
      if (audioEl) audioEl.muted = true;
      state.exporting = false;
      $("btnSave").disabled = false; $("btnPng").disabled = false;
      setTimeout(() => { $("progressBox").hidden = true; }, 1200);
      restartVideos();
    }
  }

  // ---------- イベント登録 ----------
  function bind() {
    $("brandName").textContent = CFG.BRAND;
    [["inSymptom", "symptom"], ["inAge", "age"], ["inClinic", "clinic"], ["inSub", "sub"]].forEach(([id, key]) =>
      $(id).addEventListener("input", (e) => { state[key] = e.target.value.trim(); }));

    document.querySelectorAll("[data-pick]").forEach(b => b.onclick = () => $("file" + cap(b.dataset.pick)).click());
    ["before", "after"].forEach(w => {
      $("file" + cap(w)).onchange = (e) => { loadFile(w, e.target.files[0]); e.target.value = ""; };
      $("zoom" + cap(w)).oninput = (e) => setZoom(w, parseFloat(e.target.value));
    });
    document.querySelectorAll("[data-reset]").forEach(b => b.onclick = () => {
      const p = state.panels[b.dataset.reset]; p.ox = 0; p.oy = 0; setZoom(b.dataset.reset, 1);
    });
    document.querySelectorAll("[data-clear]").forEach(b => b.onclick = () => clearPanel(b.dataset.clear));
    $("btnSwap").onclick = () => {
      const t = state.panels.before; state.panels.before = state.panels.after; state.panels.after = t;
      ["before", "after"].forEach(w => {
        refreshPick();
        $("zoom" + cap(w)).value = state.panels[w].zoom;
      });
    };

    ["cBg", "cText", "cAccent"].forEach(id => $(id).addEventListener("input", (e) => {
      state.custom[{ cBg: "bg", cText: "text", cAccent: "accent" }[id]] = e.target.value;
      saveSettings();
      renderThemes();
    }));

    Object.entries(TEXT_BASE).forEach(([k, b]) => {
      $(b.slider).addEventListener("input", (e) => {
        state.textPos[k].dy = clamp(parseInt(e.target.value, 10) || b.y, 60, LH - 60) - b.y;
        saveSettings();
      });
    });
    $("btnCenterTextX").onclick = () => {
      Object.keys(TEXT_BASE).forEach((k) => { state.textPos[k].dx = 0; });
      saveSettings();
    };
    $("btnResetTextPos").onclick = () => {
      state.textPos = newTextPos();
      syncTextSliders();
      saveSettings();
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
    };
    $("selPhotoSec").onchange = (e) => {
      state.bgm.photoSec = parseInt(e.target.value, 10) || 8;
      saveSettings();
    };
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) stopBgmPreview();
    });

    $("btnLogo").onclick = () => { if (requirePro("ロゴ挿入")) $("fileLogo").click(); };
    $("fileLogo").onchange = (e) => {
      const f = e.target.files[0]; if (!f) return;
      const img = new Image();
      img.onload = () => { state.logo = img; $("btnLogoClear").hidden = false; };
      img.src = URL.createObjectURL(f); e.target.value = "";
    };
    $("btnLogoClear").onclick = () => { state.logo = null; $("btnLogoClear").hidden = true; };

    $("selQuality").onchange = (e) => { if (e.target.value === "1080" && !requirePro("1080×1920 高画質")) e.target.value = "720"; };

    $("btnPlay").onclick = () => setPlaying(!state.playing);
    $("btnRestart").onclick = restartVideos;
    $("chkGuide").onchange = (e) => { state.guide = e.target.checked; };
    $("btnPng").onclick = savePng;
    $("btnSave").onclick = () => ((videos().length || state.bgm.enabled) ? saveVideo() : savePng());

    $("btnUpgrade").onclick = () => openModal();
    $("modalClose").onclick = () => { $("modal").hidden = true; };
    $("modal").addEventListener("click", (e) => { if (e.target === $("modal")) $("modal").hidden = true; });
    $("btnBuy").addEventListener("click", (e) => { if (!CFG.PAYMENT_URL) e.preventDefault(); });
    $("btnActivate").onclick = async () => {
      const key = $("inKey").value;
      if (!key.trim()) { $("keyMsg").textContent = "ライセンスキーを入力してください。"; $("keyMsg").className = "msg err"; return; }
      try {
        if (await checkLicense(key)) {
          localStorage.setItem(LS_KEY, normKey(key)); pro = true; applyPlan();
          $("keyMsg").textContent = "有料プランを有効化しました。"; $("keyMsg").className = "msg ok";
        } else { $("keyMsg").textContent = "ライセンスキーが正しくありません。"; $("keyMsg").className = "msg err"; }
      } catch (e) { $("keyMsg").textContent = e.message; $("keyMsg").className = "msg err"; }
    };
    $("btnDeactivate").onclick = () => { localStorage.removeItem(LS_KEY); pro = false; applyPlan(); $("keyMsg").textContent = "解除しました。"; };
  }

  loadSettings();
  bind();
  initLicense();
  if (document.fonts && document.fonts.load) { document.fonts.load('900 40px "Noto Sans JP"'); }
  requestAnimationFrame(tick);
})();
