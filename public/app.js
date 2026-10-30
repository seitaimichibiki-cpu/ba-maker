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
  const cap = (s) => s[0].toUpperCase() + s.slice(1);

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
  const MOTION = window.BAM_MOTION;

  // iPad SafariでデコーダとVSyncをフル稼働させるためのビューポート内背面コンテナ（画面外-9999pxだとWebKitがフレーム供給を間引くため0,0に配置）
  const mediaPool = document.createElement("div");
  mediaPool.setAttribute("aria-hidden", "true");
  mediaPool.style.cssText = "position:fixed;left:0;top:0;width:4px;height:4px;overflow:hidden;opacity:0.01;pointer-events:none;z-index:-1";
  document.body.appendChild(mediaPool);

  // WebKitのGPU（IOSurface / Metal VideoTextureCopierCV）最小加速サイズ（257x257超）を満たすウォームアップ専用キャンバス
  const warmCanvas = document.createElement("canvas");
  warmCanvas.width = 280;
  warmCanvas.height = 280;
  const warmCtx = warmCanvas.getContext("2d", { alpha: false });

  // ---------- 状態 ----------
  const newPanel = () => ({
    type: null, el: null, url: null, name: "", zoom: 1, ox: 0, oy: 0,
    trimStart: 0, autoTrimSec: 0, autoDetected: false,
    scanning: false, scanId: 0, scanPromise: null, audioSrc: null,
    holdCanvas: null, hasHold: false, warmed: false, warming: false
  });
  const state = {
    symptom: "", age: "", clinic: "", sub: "",
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

  let bgmPreview = null;
  let loopTimer = null;
  let scrubbingTrim = false;
  let syncingVideos = false;
  let syncToken = 0;

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
        clinic: state.clinic,
        theme: state.preferredTheme || state.theme,
        custom: state.custom,
        textPos: state.textPos,
        bgm: state.bgm,
        autoSync: state.autoSync
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
        if (d && typeof d.autoSync === "boolean") {
          state.autoSync = d.autoSync;
        }
      }
    } catch (e) {}
    $("inClinic").value = state.clinic;
    $("bgmVol").value = state.bgm.volume;
    $("selPhotoSec").value = String(state.bgm.photoSec);
    $("chkAutoSync").checked = state.autoSync;
    syncTextSliders();
    refreshBgmUI();
    refreshTrimUI();
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

  function syncModalView() {
    $("modalFreeView").hidden = pro;
    $("modalProView").hidden = !pro;
    $("priceLabel").textContent = CFG.PRO_PRICE_LABEL;
    $("priceNote").textContent = CFG.PRO_PRICE_NOTE;

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

    if (pro) {
      const maxD = (licMeta && licMeta.maxDevices) || CFG.MAX_DEVICES || 2;
      const curD = (licMeta && licMeta.deviceCount) || 1;
      const rawSaved = normKey(localStorage.getItem(LS_KEY) || "");
      $("proStatusBadge").textContent = (licMeta && licMeta.cancelAtPeriodEnd)
        ? "有効（期間終了で自動終了）"
        : "有効（認証済み）";
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

    const bar = $("planBar");
    if (bar) {
      bar.className = "plan-bar " + (pro ? "pro" : "free");
      $("planBarText").textContent = pro
        ? "⭐ 有料プラン適用中：透かしなし・1080×1920 フルHD"
        : "無料プラン：720p画質・院名下に透かしが入ります";
      $("btnPlanBarUpgrade").hidden = pro;
    }

    $("optHQ").textContent = pro ? "1080×1920（フルHD・高画質）" : "🔒 1080×1920（有料）";
    $("btnLogo").textContent = pro ? "🖼 ロゴを追加" : "🔒 ロゴを追加（有料）";

    if (pro) {
      if (upgradeQuality) $("selQuality").value = "1080";
      if (state.preferredTheme && THEMES[state.preferredTheme]) {
        state.theme = state.preferredTheme;
      }
    } else {
      if (THEMES[state.theme].pro) state.theme = "dark";
      $("selQuality").value = "720";
      state.logo = null;
      $("btnLogoClear").hidden = true;
    }

    const lim = pro ? CFG.LIMITS.pro : CFG.LIMITS.free;
    $("limitHint").textContent =
      `現在のプラン：${lim.width}×${lim.height} ／ 動画は最大${lim.maxSeconds}秒` +
      (pro ? " ／ 透かしなし" : " ／ 院名下に透かしあり") +
      "。MP4で保存できない環境ではWebMで保存されます。";
    renderThemes();
    syncModalView();
  }

  function buildMetaFromApi(key, data) {
    return {
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
      const useHold = p.type === "video" && p.hasHold &&
        !scrubbingTrim &&
        (p.scanning || p.warming || syncingVideos || p.el.seeking || p.el.readyState < 2);
      if (useHold && p.warming && p.el && p.el.readyState >= 2) {
        // プレビュー本体のGPUコンテキストでも<video>→Metalテクスチャ変換を事前稼働させ、同一フレーム内でホールド画像により上書きする
        try { ctx.drawImage(p.el, x, y, 32, 32); } catch (e) {}
      }
      ctx.drawImage(useHold ? p.holdCanvas : p.el, dx, dy, dw, dh);
      if (placeholder && (p.scanning || p.warming)) {
        ctx.fillStyle = "rgba(0,0,0,0.58)";
        rr(ctx, x + 36, y + h / 2 - 44, w - 72, 88, 22);
        ctx.fill();
        ctx.fillStyle = "#fff";
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.font = `700 30px ${FONT}`;
        ctx.fillText(p.scanning ? "🚶 動き始めを解析中…" : "▶ 再生を準備中…", x + w / 2, y + h / 2 + 2);
      }
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
    let clinicHalfH = -30;
    if (clinic) {
      c.textAlign = "center"; c.textBaseline = "middle";
      let maxW = 960, logoW = 0, logoH = 0;
      if (state.logo && pro) {
        logoH = 120; logoW = state.logo.naturalWidth / state.logo.naturalHeight * logoH;
        logoW = Math.min(logoW, 260); maxW = 960 - logoW - 30;
      }
      const sz = fit(c, clinic, maxW, 88, 38, 900);
      clinicHalfH = Math.max(sz / 2, logoW ? 60 : 40);
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
      clinicHalfH = 60;
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
      c.fillStyle = th.text; c.globalAlpha = 0.8;
      const sz = fit(c, state.sub, 940, 48, 28, 500);
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

    // 透かし（無料プラン：院名の下に表示）
    if (!pro && !opt.noWatermark) {
      c.save();
      c.font = `700 34px ${FONT}`;
      const wmText = CFG.WATERMARK_TEXT || "BAメーカー 無料版";
      const tw = c.measureText(wmText).width;
      const pw = tw + 56, ph = 58;
      const wmX = clamp(cx, pw / 2 + 24, LW - pw / 2 - 24);
      let wmY = cy + clinicHalfH + 48;
      if (subBoxY !== null && Math.abs(subBoxY - wmY) < 60) {
        wmY = subBoxY + subHalfH + 46;
      }
      if (wmY + ph / 2 > LH - 28) {
        wmY = Math.max(ph / 2 + 28, cy - Math.max(44, clinicHalfH) - 48);
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
  function tick() {
    if (!state.exporting) {
      if (state.playing && !scrubbingTrim && !syncingVideos && !loopTimer) {
        const vids = videos();
        if (vids.length > 0 && !vids.some(p => p.scanning) && vids.every(isVideoAtEnd)) {
          loopTimer = setTimeout(() => {
            loopTimer = null;
            if (state.playing && !state.exporting && !scrubbingTrim) restartVideos();
          }, 350);
        }
      }
      render(pctx, pv.width, pv.height, { preview: true, guide: state.guide });
    }
    requestAnimationFrame(tick);
  }

  // ---------- メディア読み込み・デコーダ管理・動き始め同期 ----------
  function setMsg(text, kind) { const m = $("msg"); m.textContent = text || ""; m.className = "msg " + (kind || ""); }
  function videos() { return Object.values(state.panels).filter(p => p.type === "video"); }
  const nextFrame = () => new Promise((res) => requestAnimationFrame(res));

  function captureHoldFrame(p) {
    if (!p || p.type !== "video" || !p.el) return;
    const vw = p.el.videoWidth, vh = p.el.videoHeight;
    if (!vw || !vh || p.el.readyState < 2) return;
    const scale = Math.min(1, 540 / vw);
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
   * 1周目（初回再生）のみ発生するWebKitのAVPlayerItemVideoOutput接続・Metalシェーダ初期化・
   * デコーダ先読みバッファ空欠によるカクつきを防ぐため、初回は非表示のまま7フレーム以上実再生＋GPU転送を行い、
   * 2周目以降のループ再生と完全に同じ「温まった状態」を作ってからホットポーズで待機させる
   */
  async function primeVideoForStart(p, targetSec, isCancelled) {
    const v = p.el;
    if (!v) return;
    v.pause();
    await waitIdleSeek(v, 450);
    if (isCancelled && isCancelled()) return;

    if (!p.warmed) {
      p.warming = true;
      try {
        await waitCanPlay(v, 800);
        if (isCancelled && isCancelled()) return;

        await seekTo(v, targetSec);
        if (isCancelled && isCancelled()) return;
        pumpGpuFrame(v);
        captureHoldFrame(p);

        const dur0 = isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
        const avail = dur0 > 0 ? Math.max(0.06, dur0 - targetSec - 0.05) : 0.3;
        const warmAdvance = Math.min(0.24, avail * 0.7);
        const warmRes = await playAndPumpFrames(v, {
          minFrames: warmAdvance >= 0.18 ? 7 : 3,
          minAdvance: warmAdvance,
          timeoutMs: 950,
          pauseAtEnd: true
        }, isCancelled);
        if (isCancelled && isCancelled()) { v.pause(); return; }
        if (warmRes.frames >= 3 || warmRes.advanced >= 0.1) {
          p.warmed = true;
        }
      } finally {
        p.warming = false;
      }
    }

    const dur = isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
    const lead = targetSec >= 0.11 ? 0.10 : 0;
    const preSec = clamp(targetSec - lead, 0, dur > 0.15 ? dur - 0.12 : 0);

    await seekTo(v, preSec);
    if (isCancelled && isCancelled()) { v.pause(); return; }
    await waitCanPlay(v, 350);
    if (isCancelled && isCancelled()) { v.pause(); return; }

    const startCt = v.currentTime;
    const goalAdvance = dur > 0 && (dur - startCt) < 0.12 ? 0.02 : (lead > 0 ? 0.085 : 0.045);
    await playAndPumpFrames(v, {
      minFrames: lead > 0 ? 3 : 2,
      minAdvance: goalAdvance,
      timeoutMs: 450,
      pauseAtEnd: true
    }, isCancelled);
  }

  function autoDetectPanel(which) {
    const p = state.panels[which];
    if (!p || p.type !== "video" || !p.el || !MOTION) return Promise.resolve(0);
    const token = ++p.scanId;
    clearLoopTimer();
    syncToken++;
    syncingVideos = false;
    // スキャン中は全動画を一時停止し、デコーダ帯域をスキャンに集中させる
    videos().forEach(vp => {
      if (!vp.scanning && vp.el && !vp.el.seeking) captureHoldFrame(vp);
      if (vp.el) vp.el.pause();
    });
    p.scanning = true;
    refreshPick();

    const job = MOTION.detectStart(
      p.el,
      p.el.duration || 0,
      () => !Object.values(state.panels).includes(p) || p.scanId !== token
    ).then((sec) => {
      if (!Object.values(state.panels).includes(p) || p.scanId !== token) return 0;
      // スキャン終了位置（途中フレーム）が一瞬描画されないよう同期ロックを先に立てる
      syncingVideos = true;
      p.scanning = false;
      p.autoDetected = true;
      const clamped = clamp(Math.round((sec || 0) * 10) / 10, 0, maxTrimFor(p));
      p.autoTrimSec = clamped;
      if (state.autoSync) {
        p.trimStart = clamped;
      }
      refreshPick();
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
      }
    }

    const url = URL.createObjectURL(file);
    const done = (el, type) => {
      destroyPanelMedia(p);
      Object.assign(p, {
        type, el, url, name: file.name, zoom: 1, ox: 0, oy: 0,
        trimStart: 0, autoTrimSec: 0, autoDetected: false,
        scanning: false, scanPromise: null, audioSrc: null,
        holdCanvas: null, hasHold: false, warmed: false, warming: false
      });
      if (type === "video") {
        pumpGpuFrame(el);
        captureHoldFrame(p);
      }
      $("zoom" + cap(which)).value = 1;
      refreshPick();
      setMsg("");
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
    $("zoom" + cap(which)).value = 1;
  }

  async function restartVideos() {
    clearLoopTimer();
    const myToken = ++syncToken;
    const vids = videos();
    if (!vids.length) {
      syncingVideos = false;
      return;
    }
    if (vids.some(p => p.scanning)) {
      vids.forEach(p => { if (p.el) p.el.pause(); });
      syncingVideos = false;
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
      if (myToken === syncToken) syncingVideos = false;
    };

    for (const p of vids) {
      if (cancelled()) { abortCleanly(); return; }
      const start = clamp(p.trimStart || 0, 0, maxTrimFor(p));
      if (state.playing) {
        await primeVideoForStart(p, start, cancelled);
      } else {
        await seekTo(p.el, start);
      }
      if (cancelled()) { abortCleanly(); return; }
      captureHoldFrame(p);
    }

    if (cancelled()) { abortCleanly(); return; }
    if (state.playing) {
      const startCts = vids.map(p => (p.el ? p.el.currentTime : 0));
      await Promise.all(vids.map(p => p.el.play().catch(() => {})));
      await Promise.all(vids.map((p, idx) => waitLivePlaybackFrame(p.el, startCts[idx], 220, cancelled)));
    }
    if (cancelled()) { abortCleanly(); return; }
    syncingVideos = false;
  }

  function setPlaying(on) {
    state.playing = on;
    $("btnPlay").textContent = on ? "⏸ 停止" : "▶ 再生";
    clearLoopTimer();
    const vids = videos();
    if (!on) {
      syncToken++;
      syncingVideos = false;
      vids.forEach(p => p.el.pause());
      return;
    }
    if (vids.length > 0 && vids.every(isVideoAtEnd)) {
      restartVideos();
      return;
    }
    vids.forEach(p => p.el.play().catch(() => {}));
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

  async function savePng() {
    if (!state.panels.before.el && !state.panels.after.el) { setMsg("先にビフォー／アフターの画像か動画を追加してください。", "err"); return; }
    if (pro && apiBase()) {
      await verifyActiveLicense({ silent: false, force: false });
    }
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
  async function saveVideo() {
    if (state.exporting) return;
    syncToken++;
    syncingVideos = false;
    clearLoopTimer();
    stopBgmPreview();
    if (!state.panels.before.el && !state.panels.after.el) {
      setMsg("先にビフォー／アフターの写真か動画を追加してください。", "err");
      return;
    }
    const vids = videos();
    if (!vids.length && !state.bgm.enabled) {
      await savePng();
      return;
    }
    if (!window.MediaRecorder) {
      setMsg("このブラウザは動画書き出しに非対応です。Chrome / Edge / Safari 最新版をお使いください。", "err");
      return;
    }

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

    state.exporting = true;
    vids.forEach(p => { if (p.el) p.el.pause(); });
    $("btnSave").disabled = true; $("btnPng").disabled = true;
    $("progressBox").hidden = false; $("progressBar").style.width = "0%";

    try {
      // 書き出し前にライセンスの有効状態を再照合（解約・未払い時は自動で無料プラン＝720p・透かしありへ切り戻す）
      if (pro && apiBase()) {
        await verifyActiveLicense({ silent: false, force: false });
      }
      const { w, h } = exportSize();
      const maxSec = lim().maxSeconds;
      const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
      const cctx = cv.getContext("2d", { alpha: false });

      const pendingScans = vids.map(p => p.scanning && p.scanPromise).filter(Boolean);
      if (pendingScans.length) {
        setMsg("動き始めの位置を解析しています…");
        await Promise.all(pendingScans);
      }

      let dur;
      if (vids.length) {
        const longest = Math.max(...vids.map(p => {
          const d = p.el.duration || 0;
          const ts = clamp(p.trimStart || 0, 0, maxTrimFor(p));
          return isFinite(d) && d > 0 ? Math.max(0.5, d - ts) : 0;
        }));
        dur = Math.min(maxSec, isFinite(longest) && longest > 0 ? longest : maxSec);
      } else {
        dur = Math.min(maxSec, state.bgm.photoSec || 8);
      }

      // 録画開始前に各動画を順番にプリロール（デコーダ温め）し、スタート直後のカクつきを防止
      if (vids.length) {
        setMsg("スタート位置を滑らかに準備しています…");
        for (const p of vids) {
          const ts = clamp(p.trimStart || 0, 0, maxTrimFor(p));
          await primeVideoForStart(p, ts, () => false);
          captureHoldFrame(p);
        }
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

      render(cctx, w, h, {});
      pctx.drawImage(cv, 0, 0, pv.width, pv.height);

      // プリロール済みのホットポーズ状態から全動画を先に再生開始し、実際に初フレームが流れ出してから録画開始
      if (vids.length) {
        const startCts = vids.map(p => (p.el ? p.el.currentTime : 0));
        await Promise.all(vids.map(p => p.el.play().catch(() => {})));
        await Promise.all(vids.map((p, idx) => waitLivePlaybackFrame(p.el, startCts[idx], 220, () => false)));
        render(cctx, w, h, {});
      }
      if (wantBgm && audioCtx && dest) {
        bgmRec = BGM.start(audioCtx, dest, {
          seed: state.bgm.seed,
          volume: state.bgm.volume,
          durationSec: dur
        });
      }
      rec.start(1000);
      const t0 = performance.now();
      let lastProg = -1;
      let frameIdx = 0;
      await new Promise((resolve) => {
        const loop = () => {
          const now = performance.now();
          const t = (now - t0) / 1000;
          render(cctx, w, h, {});
          if ((frameIdx++ & 1) === 0) {
            pctx.drawImage(cv, 0, 0, pv.width, pv.height);
          }
          if (now - lastProg >= 100) {
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
      $(id).addEventListener("input", (e) => {
        state[key] = e.target.value.trim();
        if (key === "clinic") saveSettings();
      }));

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
      ["before", "after"].forEach(w => {
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
      if (document.hidden) {
        stopBgmPreview();
      } else if (pro && apiBase() && !state.exporting) {
        verifyActiveLicense({ silent: false, force: false });
      }
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
        setMsg("⭐ 有料プランを有効化しました（透かしなし・1080×1920フルHD）。", "ok");
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
  if (document.fonts && document.fonts.load) { document.fonts.load('900 40px "Noto Sans JP"'); }
  requestAnimationFrame(tick);
})();
