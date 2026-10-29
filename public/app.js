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

  // ---------- 状態 ----------
  const newPanel = () => ({ type: null, el: null, url: null, name: "", zoom: 1, ox: 0, oy: 0 });
  const state = {
    symptom: "", age: "", clinic: "", sub: "",
    theme: "dark",
    custom: { bg: "#111111", text: "#ffffff", accent: "#ff5a5f" },
    guide: false, playing: true, exporting: false,
    logo: null,
    panels: { before: newPanel(), after: newPanel() }
  };

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
    if (!pro) {
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
        state.theme = key; renderThemes();
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
  function render(c, W, H, opt) {
    opt = opt || {};
    const th = theme();
    c.save();
    c.setTransform(W / LW, 0, 0, H / LH, 0, 0);
    c.clearRect(0, 0, LW, LH);

    // 背景
    c.fillStyle = th.bg; c.fillRect(0, 0, LW, LH);

    // 上部：症状・年齢
    c.textAlign = "center"; c.textBaseline = "middle";
    const symptom = state.symptom || (opt.preview ? "症状を入力" : "");
    if (symptom) {
      c.fillStyle = state.symptom ? th.text : "rgba(160,160,160,0.7)";
      fit(c, symptom, 960, 132, 52, 900);
      c.fillText(symptom, LW / 2, 125);
    }
    const age = state.age || (opt.preview ? "年齢・属性" : "");
    if (age) {
      const sz = fit(c, age, 800, 64, 34, 700);
      const tw = c.measureText(age).width + 80, ph = sz + 40;
      c.fillStyle = state.age ? th.accent : "rgba(160,160,160,0.35)";
      rr(c, (LW - tw) / 2, 250 - ph / 2 + 4, tw, ph, ph / 2); c.fill();
      c.fillStyle = "#fff"; c.textAlign = "center"; c.textBaseline = "middle";
      c.fillText(age, LW / 2, 254);
    }

    // 中央：左右比較
    const B = state.panels.before, A = state.panels.after;
    drawMedia(c, B, 0, PANEL_Y, PANEL_W, PANEL_H, th, opt.preview, "BEFORE");
    drawMedia(c, A, PANEL_W + GAP, PANEL_Y, PANEL_W, PANEL_H, th, opt.preview, "AFTER");
    c.fillStyle = th.bg; c.fillRect(PANEL_W, PANEL_Y, GAP, PANEL_H);
    badge(c, "BEFORE", 24, PANEL_Y + 24, "rgba(70,76,88,0.92)", "#fff");
    badge(c, "AFTER", PANEL_W + GAP + 24, PANEL_Y + 24, th.accent, "#fff");

    // 下部：院名（ロゴは左）
    const clinic = state.clinic || (opt.preview ? "院名を入力" : "");
    if (clinic) {
      c.textAlign = "center"; c.textBaseline = "middle";
      let cx = LW / 2, maxW = 960;
      let logoW = 0, logoH = 0;
      if (state.logo && pro) {
        logoH = 120; logoW = state.logo.naturalWidth / state.logo.naturalHeight * logoH;
        logoW = Math.min(logoW, 260); maxW = 960 - logoW - 30;
      }
      fit(c, clinic, maxW, 88, 38, 900);
      const tw = c.measureText(clinic).width;
      const total = tw + (logoW ? logoW + 30 : 0);
      const left = (LW - total) / 2;
      if (logoW) {
        const lh = logoW / (state.logo.naturalWidth / state.logo.naturalHeight);
        c.drawImage(state.logo, left, 1590 - lh / 2, logoW, lh);
      }
      c.textAlign = "left";
      c.fillStyle = state.clinic ? th.text : "rgba(160,160,160,0.7)";
      c.fillText(clinic, left + (logoW ? logoW + 30 : 0), 1592);
    } else if (state.logo && pro) {
      const lh = 120, lw = Math.min(state.logo.naturalWidth / state.logo.naturalHeight * lh, 400);
      c.drawImage(state.logo, (LW - lw) / 2, 1590 - lh / 2, lw, lh);
    }
    if (state.sub) {
      c.textAlign = "center"; c.textBaseline = "middle";
      c.fillStyle = th.text; c.globalAlpha = 0.8;
      fit(c, state.sub, 940, 48, 28, 500);
      c.fillText(state.sub, LW / 2, 1700);
      c.globalAlpha = 1;
    }

    // 透かし（無料）
    if (!pro && !opt.noWatermark) {
      c.textAlign = "center"; c.textBaseline = "middle";
      c.font = `500 30px ${FONT}`;
      c.fillStyle = th.text; c.globalAlpha = 0.5;
      c.fillText(CFG.WATERMARK_TEXT, LW / 2, 1868);
      c.globalAlpha = 1;
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
  const pointers = new Map();
  let drag = null, pinch = null, tapStart = null;

  pv.addEventListener("pointerdown", (e) => {
    pv.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, logical(e));
    const which = hitPanel(logical(e));
    if (pointers.size === 1) { drag = which ? { which, last: logical(e) } : null; pinch = null; }
    else if (pointers.size === 2 && drag) {
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
    const p = state.panels[drag.which];
    const { rx, ry } = panelRange(p, PANEL_W, PANEL_H);
    if (rx > 0) p.ox = clamp(p.ox + (pt.x - drag.last.x) / rx, -1, 1);
    if (ry > 0) p.oy = clamp(p.oy + (pt.y - drag.last.y) / ry, -1, 1);
    drag.last = pt;
  });
  const endPtr = (e) => { pointers.delete(e.pointerId); if (pointers.size < 2) pinch = null; if (!pointers.size) drag = null; };
  pv.addEventListener("pointerdown", (e) => { tapStart = logical(e); }, true);
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

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
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
    const vids = videos();
    if (!vids.length) { setMsg("動画で保存するには、ビフォーかアフターに動画を追加してください。画像だけの場合はPNG保存をご利用ください。", "err"); return; }
    if (!window.MediaRecorder) { setMsg("このブラウザは動画書き出しに非対応です。Chrome / Edge / Safari 最新版をお使いください。", "err"); return; }

    const { w, h } = exportSize();
    const maxSec = lim().maxSeconds;
    const longest = Math.max(...vids.map(p => p.el.duration || 0));
    const dur = Math.min(maxSec, isFinite(longest) && longest > 0 ? longest : maxSec);
    const mime = pickMime();
    const ext = mime.includes("mp4") ? "mp4" : "webm";
    const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
    const cctx = cv.getContext("2d");

    state.exporting = true;
    $("btnSave").disabled = true; $("btnPng").disabled = true;
    $("progressBox").hidden = false; $("progressBar").style.width = "0%";
    setMsg(`書き出し中…（約${Math.ceil(dur)}秒）このタブを開いたままにしてください。`);

    let audioCtx = null, audioNode = null, audioEl = null;
    try {
      // 音声
      const which = $("selAudio").value;
      const ap = which !== "none" ? state.panels[which] : null;
      const stream = cv.captureStream(30);
      if (ap && ap.type === "video") {
        try {
          if (!ap.audioSrc) {
            const AC = window.AudioContext || window.webkitAudioContext;
            ap.audioSrc = new AC().createMediaElementSource(ap.el);
          }
          audioCtx = ap.audioSrc.context;
          if (audioCtx.state === "suspended") await audioCtx.resume();
          const dest = audioCtx.createMediaStreamDestination();
          ap.audioSrc.connect(dest);
          audioNode = ap.audioSrc; audioEl = ap.el;
          ap.el.muted = false;
          stream.addTrack(dest.stream.getAudioTracks()[0]);
        } catch (e) { setMsg("音声の取り込みに失敗したため、音声なしで書き出します。"); }
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
        ? "MP4を保存しました。"
        : "WebMで保存しました（Instagramに投稿できない場合はMP4へ変換が必要です。READMEを参照）。", "ok");
    } catch (err) {
      console.error(err);
      setMsg("書き出しに失敗しました：" + (err && err.message ? err.message : err), "err");
    } finally {
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
      state.custom[{ cBg: "bg", cText: "text", cAccent: "accent" }[id]] = e.target.value; renderThemes();
    }));

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
    $("btnSave").onclick = () => (videos().length ? saveVideo() : savePng());

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

  bind();
  initLicense();
  if (document.fonts && document.fonts.load) { document.fonts.load('900 40px "Noto Sans JP"'); }
  requestAnimationFrame(tick);
})();
