(function () {
  "use strict";

  const CFG = window.BAM_CONFIG || {};
  const LS_KEY = "bam_license";
  const LS_DEVICE = "bam_device_v1";
  const $ = (id) => document.getElementById(id);

  const normKey = (k) => String(k || "").trim().toUpperCase().replace(/\s+/g, "");
  const apiBase = () => String(CFG.LICENSE_API_URL || "").trim().replace(/\/+$/, "");

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
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

  function fmtDateTime(isoOrUnix) {
    if (!isoOrUnix) return "—";
    const d = typeof isoOrUnix === "number" ? new Date(isoOrUnix * 1000) : new Date(isoOrUnix);
    if (isNaN(d.getTime())) return "—";
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) {}
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed;left:0;top:0;opacity:0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch (e) {
      return false;
    }
  }

  let dashData = null;
  let currentFilter = "all";
  let searchQuery = "";
  let lastIssued = null;
  const openEditKeys = new Set();

  function showNotice(el, text, kind) {
    if (!el) return;
    el.textContent = text;
    el.className = "msg " + (kind || "");
    el.hidden = !text;
  }

  function denyAndRedirect() {
    $("adminApp").hidden = true;
    $("btnRefreshAdmin").hidden = true;
    $("adminGate").hidden = false;
    $("adminGateMsg").textContent = "⛔ 管理者ページへのアクセス権限がありません。エディタへ戻ります…";
    setTimeout(() => {
      window.location.replace("index.html");
    }, 350);
  }

  async function callAdminApi(payload) {
    const authKey = normKey(localStorage.getItem(LS_KEY) || "");
    if (!authKey || !apiBase()) {
      return { unauthorized: true };
    }
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), 12000) : 0;
    try {
      const res = await fetch(apiBase() + "/api/admin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...payload,
          authKey,
          deviceId: getDeviceId(),
          deviceLabel: getDeviceLabel()
        }),
        signal: ctrl ? ctrl.signal : undefined
      });
      let data = null;
      try { data = await res.json(); } catch (e) {}
      if (res.status === 401 || res.status === 403) {
        return { unauthorized: true, status: res.status, data };
      }
      return { okHttp: res.ok, status: res.status, data };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function classifyRecord(r) {
    if (r.isOwnerAdmin) return "owner";
    if (r.status === "active") {
      return r.isStripe ? "paid" : "manual";
    }
    if (r.revokedReason === "payment_failed") return "failed";
    return "inactive";
  }

  function badgeInfo(r) {
    const cat = classifyRecord(r);
    if (cat === "owner") return { cls: "owner", label: "🛡 管理者専用キー" };
    if (cat === "paid") {
      return r.cancelAtPeriodEnd
        ? { cls: "paid", label: "🟢 課金中（期間末解約予約）" }
        : { cls: "paid", label: "🟢 有効（Stripe定期課金）" };
    }
    if (cat === "manual") return { cls: "manual", label: "🎁 有効（手動・モニター枠）" };
    if (cat === "failed") return { cls: "failed", label: "⚠️ 決済失敗（自動利用停止中）" };
    if (r.revokedReason === "admin_revoked") return { cls: "inactive", label: "⏸ 手動利用停止中" };
    return { cls: "inactive", label: "⚪ 解約済み（自動停止）" };
  }

  function eventLabel(type) {
    const map = {
      checkout_completed: "💳 新規決済",
      payment_failed: "⚠️ 決済失敗→自動停止",
      payment_recovered: "✅ 再決済→自動再開",
      subscription_canceled: "⚪ 解約完了→自動停止",
      subscription_updated: "🔄 契約状態変更",
      admin_issue: "🎁 手動キー発行",
      admin_revoke: "⏸ 手動利用停止",
      admin_reactivate: "▶ 手動再有効化",
      admin_reset_devices: "📱 端末枠リセット",
      admin_remove_device: "📱 端末個別解除",
      admin_update: "📝 情報更新",
      admin_resend: "✉️ メール再送",
      admin_delete: "🗑 キー削除"
    };
    return map[type] || type;
  }

  function renderDashboard() {
    if (!dashData) return;
    const s = dashData.summary || {};
    $("kpiPaidCount").textContent = `${s.activePaidCount || 0}件`;
    $("kpiMrr").textContent = `想定月額売上：¥${Number(s.mrrYen || 0).toLocaleString("ja-JP")} / 月`;
    $("kpiFailedCount").textContent = `${s.paymentFailedCount || 0}件`;
    $("kpiFailedCard").className = "adm-kpi" + ((s.paymentFailedCount || 0) > 0 ? " warn" : "");
    $("kpiManualCount").textContent = `${s.activeManualCount || 0}件`;
    $("kpiCanceledCount").textContent = `${s.canceledCount || 0}件`;
    $("kpiCancelSched").textContent = `期間末解約予約：${s.cancelScheduledCount || 0}件`;
    $("kpiDevicesCount").textContent = `${s.totalBoundDevices || 0}台`;

    const sys = dashData.systemInfo || {};
    const pills = [
      { ok: !!sys.webhookSecretConfigured, text: "Stripe Webhook署名検証" },
      { ok: !!sys.autoSuspendOnPaymentFailure, text: "決済失敗時の自動利用停止：有効" },
      { ok: !!sys.autoRecoverOnInvoicePaid, text: "再決済時の自動復旧：有効" },
      { ok: !!sys.emailConfigured, text: "Gmail自動メール送信" },
      { ok: !!sys.stripeSecretConfigured, text: "決済直後0秒有効化API" }
    ];
    $("sysPills").innerHTML = pills.map((p) =>
      `<span class="adm-pill ${p.ok ? "ok" : "err"}">${p.ok ? "●" : "×"} ${esc(p.text)}</span>`
    ).join("");

    if (CFG.PAYMENT_URL) $("lnkStripePayment").href = CFG.PAYMENT_URL;
    else $("lnkStripePayment").hidden = true;
    if (CFG.CUSTOMER_PORTAL_URL) $("lnkStripePortal").href = CFG.CUSTOMER_PORTAL_URL;
    else $("lnkStripePortal").hidden = true;

    renderRecords();
    renderLogs();
  }

  function getFilteredRecords() {
    const all = (dashData && Array.isArray(dashData.records)) ? dashData.records : [];
    const q = searchQuery.trim().toLowerCase();
    return all.filter((r) => {
      const cat = classifyRecord(r);
      if (currentFilter === "paid" && cat !== "paid") return false;
      if (currentFilter === "failed" && cat !== "failed") return false;
      if (currentFilter === "manual" && cat !== "manual" && cat !== "owner") return false;
      if (currentFilter === "inactive" && cat !== "inactive") return false;
      if (!q) return true;
      const hay = `${r.key} ${r.email || ""} ${r.note || ""} ${r.customerId || ""} ${r.subscriptionId || ""}`.toLowerCase();
      return hay.includes(q);
    });
  }

  function renderRecords() {
    const list = getFilteredRecords();
    const curDev = (dashData && dashData.currentDeviceId) || "";
    const box = $("admList");

    if (!list.length) {
      box.innerHTML = `<div class="slot" style="text-align:center;color:var(--sub);font-size:13px;padding:20px">該当するライセンスがありません。</div>`;
      return;
    }

    box.innerHTML = list.map((r) => {
      const cat = classifyRecord(r);
      const b = badgeInfo(r);
      const isEditing = openEditKeys.has(r.key);
      const devs = Array.isArray(r.devices) ? r.devices : [];

      const devHtml = devs.length
        ? devs.map((d) => {
            const isSelfDev = r.isOwnerAdmin && d.id === curDev;
            return `<span class="adm-dev-chip" title="最終アクセス: ${esc(fmtDateTime(d.lastSeenAt))}">
              📱 ${esc(d.label || "端末")} <small style="color:var(--sub)">(${esc(fmtDateTime(d.lastSeenAt))}${isSelfDev ? "・この端末" : ""})</small>
              ${isSelfDev ? "" : `<button type="button" data-act="remove-dev" data-key="${esc(r.key)}" data-dev="${esc(d.id)}" title="この端末枠を解除">×</button>`}
            </span>`;
          }).join("")
        : `<span style="font-size:12px;color:var(--sub)">登録端末なし（0 / ${r.maxDevices}台）</span>`;

      const mailText = r.emailSentAt
        ? `送信済（${fmtDateTime(r.emailSentAt)}）`
        : (r.email ? "⚠️ 未送信" : "—（メール未設定）");

      const extraAlert = r.revokedReason === "payment_failed"
        ? `<div style="font-size:12px;color:#ff9498;font-weight:700;margin-top:4px">⚠️ カード決済失敗により自動利用停止中（発生: ${esc(fmtDateTime(r.paymentFailedAt || r.updatedAt))}）— 顧客がカード更新して再決済が通ると自動復旧します。</div>`
        : (r.cancelAtPeriodEnd && r.currentPeriodEnd
            ? `<div style="font-size:12px;color:#f5c04a;margin-top:4px">⏳ ${esc(fmtDateTime(r.currentPeriodEnd))} に自動終了予定</div>`
            : "");

      const canToggleStatus = !r.isOwnerAdmin;
      const canDelete = !r.isOwnerAdmin && !(r.status === "active" && r.subscriptionId);

      return `<div class="adm-item ${cat === "failed" ? "failed" : ""} ${r.isOwnerAdmin ? "owner" : ""}">
        <div class="adm-item-top">
          <div class="adm-badges">
            <span class="adm-st ${b.cls}">${esc(b.label)}</span>
            <code class="adm-key-code">${esc(r.key)}</code>
          </div>
          <div style="font-size:11.5px;color:var(--sub)">発行：${esc(fmtDateTime(r.createdAt))}</div>
        </div>

        <div class="adm-meta-grid">
          <div><span>メール：</span><strong>${r.email ? esc(r.email) : "（未設定）"}</strong></div>
          <div><span>院名・メモ：</span><strong>${r.note ? esc(r.note) : "—"}</strong></div>
          <div><span>端末登録：</span><strong>${r.deviceCount} / ${r.maxDevices} 台</strong></div>
          <div><span>案内メール：</span>${esc(mailText)}</div>
        </div>
        ${extraAlert}

        <div class="adm-devs">${devHtml}</div>

        <div class="adm-actions">
          <button type="button" class="btn tiny" data-act="copy-key" data-key="${esc(r.key)}">📋 キーをコピー</button>
          <button type="button" class="btn tiny" data-act="copy-url" data-url="${esc(r.activateUrl)}">🔗 ワンタップ有効化URLをコピー</button>
          <button type="button" class="btn tiny" data-act="toggle-edit" data-key="${esc(r.key)}">📝 メモ・宛先・台数編集</button>
          <button type="button" class="btn tiny" data-act="resend" data-key="${esc(r.key)}" data-email="${esc(r.email || "")}">✉️ メール再送</button>
          ${devs.length > 0 ? `<button type="button" class="btn tiny" data-act="reset-devs" data-key="${esc(r.key)}" data-owner="${r.isOwnerAdmin ? "1" : "0"}">📱 ${r.isOwnerAdmin ? "他端末をリセット" : "端末枠リセット"}</button>` : ""}
          ${canToggleStatus ? (
            r.status === "active"
              ? `<button type="button" class="btn tiny adm-btn-danger" data-act="revoke" data-key="${esc(r.key)}">⏸ 利用停止にする</button>`
              : `<button type="button" class="btn tiny adm-btn-ok" data-act="reactivate" data-key="${esc(r.key)}">▶ 再有効化する</button>`
          ) : ""}
          ${canDelete ? `<button type="button" class="btn tiny adm-btn-danger" data-act="delete" data-key="${esc(r.key)}">🗑 削除</button>` : ""}
        </div>

        <div class="adm-edit-box" id="edit_${esc(r.key)}" ${isEditing ? "" : "hidden"}>
          <div class="adm-edit-grid">
            <label>メールアドレス
              <input type="email" id="edMail_${esc(r.key)}" value="${esc(r.email || "")}" placeholder="clinic@example.com">
            </label>
            <label>院名・管理メモ
              <input type="text" id="edNote_${esc(r.key)}" value="${esc(r.note || "")}" maxlength="100" placeholder="〇〇整体院様">
            </label>
            <label>上限台数
              <input type="number" id="edMax_${esc(r.key)}" min="1" max="50" value="${Number(r.maxDevices || 2)}">
            </label>
            <button type="button" class="btn small primary" data-act="save-edit" data-key="${esc(r.key)}">💾 保存</button>
          </div>
        </div>
      </div>`;
    }).join("");
  }

  function renderLogs() {
    const logs = (dashData && Array.isArray(dashData.auditLogs)) ? dashData.auditLogs : [];
    const box = $("admLogList");
    if (!logs.length) {
      box.innerHTML = `<div style="font-size:12.5px;color:var(--sub);padding:8px 0">まだイベント履歴はありません（今後の決済・自動停止・管理操作がここに記録されます）。</div>`;
      return;
    }
    box.innerHTML = logs.map((l) => `
      <div class="adm-log-row">
        <span class="adm-log-time">${esc(fmtDateTime(l.at))}</span>
        <span class="adm-log-tag ${esc(l.type)}">${esc(eventLabel(l.type))}</span>
        ${l.key ? `<code style="font-size:12px;color:#f5c04a">${esc(l.rawKey || l.key)}</code>` : ""}
        ${l.email ? `<span style="color:#92d4ff">${esc(l.email)}</span>` : ""}
        <span>${esc(l.detail || "")}</span>
      </div>
    `).join("");
  }

  async function loadDashboard(showRefreshToast) {
    const btn = $("btnRefreshAdmin");
    btn.disabled = true;
    let res;
    try {
      res = await callAdminApi({ action: "dashboard" });
    } catch (e) {
      btn.disabled = false;
      if (!dashData) {
        $("adminGateMsg").textContent = "⚠️ 認証サーバーに接続できませんでした。通信環境をご確認のうえ再読み込みしてください。";
      } else {
        showNotice($("admActionMsg"), "通信エラーが発生しました。再度お試しください。", "err");
      }
      return;
    }
    btn.disabled = false;

    if (res.unauthorized || !res.okHttp || !res.data || !res.data.ok) {
      denyAndRedirect();
      return;
    }

    dashData = res.data;
    $("adminGate").hidden = true;
    $("adminApp").hidden = false;
    $("btnRefreshAdmin").hidden = false;
    $("adminLastSync").textContent = `最終更新：${fmtDateTime(new Date().toISOString())}`;
    renderDashboard();
    if (showRefreshToast) {
      showNotice($("admActionMsg"), "最新の契約・決済状態に更新しました。", "ok");
    }
  }

  function exportCsv() {
    const rows = (dashData && Array.isArray(dashData.records)) ? dashData.records : [];
    const header = ["ステータス", "区分", "ライセンスキー", "メールアドレス", "院名・メモ", "登録端末数", "上限台数", "メール送信日時", "決済失敗日時", "発行日時"];
    const escCsv = (v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
    const lines = [header.map(escCsv).join(",")];
    for (const r of rows) {
      lines.push([
        badgeInfo(r).label,
        r.isOwnerAdmin ? "管理者" : (r.isStripe ? "Stripe定期課金" : "手動発行"),
        r.key,
        r.email || "",
        r.note || "",
        r.deviceCount,
        r.maxDevices,
        fmtDateTime(r.emailSentAt),
        fmtDateTime(r.paymentFailedAt),
        fmtDateTime(r.createdAt)
      ].map(escCsv).join(","));
    }
    const blob = new Blob(["\uFEFF" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const today = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `ba-maker-licenses-${today}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  // イベント登録
  if (CFG.BRAND && $("brandName")) {
    $("brandName").textContent = CFG.BRAND;
  }

  $("btnRefreshAdmin").addEventListener("click", () => loadDashboard(true));
  $("btnExportCsv").addEventListener("click", exportCsv);

  $("admTabs").addEventListener("click", (e) => {
    const tab = e.target.closest(".adm-tab");
    if (!tab) return;
    currentFilter = tab.dataset.filter || "all";
    document.querySelectorAll("#admTabs .adm-tab").forEach((b) => {
      b.classList.toggle("active", b === tab);
    });
    renderRecords();
  });

  $("inAdmSearch").addEventListener("input", (e) => {
    searchQuery = e.target.value || "";
    renderRecords();
  });

  $("formIssue").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("inIssueEmail").value.trim();
    const note = $("inIssueNote").value.trim();
    const maxDevices = Number($("inIssueMaxDev").value) || 2;
    const sendEmail = $("chkIssueSendMail").checked;
    const btn = $("btnIssueSubmit");
    btn.disabled = true;
    showNotice($("issueMsg"), "ライセンスキーを発行しています…", "");

    try {
      const res = await callAdminApi({ action: "issue", email, note, maxDevices, sendEmail });
      btn.disabled = false;
      if (res.unauthorized) { denyAndRedirect(); return; }
      if (!res.okHttp || !res.data || !res.data.ok) {
        showNotice($("issueMsg"), (res.data && res.data.message) || "発行に失敗しました。", "err");
        return;
      }
      const issuedRec = res.data.record;
      lastIssued = {
        key: issuedRec.key,
        url: res.data.activateUrl
      };
      await loadDashboard(false);
      if (dashData && Array.isArray(dashData.records) && !dashData.records.some((x) => x.key === issuedRec.key)) {
        dashData.records.unshift({
          key: issuedRec.key,
          activateUrl: res.data.activateUrl,
          isOwnerAdmin: false,
          isStripe: false,
          email: issuedRec.email || "",
          note: issuedRec.note || "",
          status: issuedRec.status || "active",
          revokedReason: null,
          cancelAtPeriodEnd: false,
          currentPeriodEnd: null,
          deviceCount: Array.isArray(issuedRec.devices) ? issuedRec.devices.length : 0,
          maxDevices: issuedRec.maxDevices || maxDevices,
          devices: Array.isArray(issuedRec.devices) ? issuedRec.devices : [],
          emailSentAt: issuedRec.emailSentAt || null,
          paymentFailedAt: null,
          lastPaidAt: null,
          canceledAt: null,
          subscriptionId: null,
          customerId: null,
          createdAt: issuedRec.createdAt || new Date().toISOString(),
          updatedAt: issuedRec.updatedAt || new Date().toISOString()
        });
        if (dashData.summary) {
          dashData.summary.totalLicenses = (dashData.summary.totalLicenses || 0) + 1;
          dashData.summary.activeManualCount = (dashData.summary.activeManualCount || 0) + 1;
        }
        renderDashboard();
      }
      $("issuedKeyCode").textContent = lastIssued.key;
      const mr = res.data.emailResult || {};
      $("issuedMailNote").textContent = email
        ? (sendEmail
            ? (mr.sent ? `✉️ ${email} 宛にワンタップ有効化メールを自動送信しました。` : `⚠️ キーは発行されましたがメール送信に失敗しました（${mr.reason || "error"}）。上のリンクをコピーしてご案内ください。`)
            : `※メール自動送信オフで発行しました。上のボタンからキーまたはリンクをコピーしてご案内ください。`)
        : "※メールアドレス未指定で発行しました。上のボタンからキーまたはワンタップ有効化リンクをコピーしてLINE等でお渡しください。";
      $("issuedBox").hidden = false;
      $("inIssueEmail").value = "";
      $("inIssueNote").value = "";
      showNotice($("issueMsg"), "", "");
    } catch (err) {
      btn.disabled = false;
      showNotice($("issueMsg"), "通信エラーのため発行できませんでした。", "err");
    }
  });

  $("btnCopyIssuedKey").addEventListener("click", async () => {
    if (!lastIssued) return;
    if (await copyText(lastIssued.key)) {
      showNotice($("issueMsg"), `📋 ライセンスキー（${lastIssued.key}）をコピーしました。`, "ok");
    }
  });

  $("btnCopyIssuedUrl").addEventListener("click", async () => {
    if (!lastIssued) return;
    if (await copyText(lastIssued.url)) {
      showNotice($("issueMsg"), "🔗 ワンタップ有効化リンクをコピーしました（そのままLINE等に貼り付けできます）。", "ok");
    }
  });

  $("admList").addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const act = btn.dataset.act;
    const key = btn.dataset.key || "";

    if (act === "copy-key") {
      if (await copyText(key)) {
        showNotice($("admActionMsg"), `📋 キー（${key}）をコピーしました。`, "ok");
      }
      return;
    }
    if (act === "copy-url") {
      const url = btn.dataset.url || "";
      if (await copyText(url)) {
        showNotice($("admActionMsg"), "🔗 ワンタップ有効化URLをコピーしました。", "ok");
      }
      return;
    }
    if (act === "toggle-edit") {
      if (openEditKeys.has(key)) openEditKeys.delete(key);
      else openEditKeys.add(key);
      renderRecords();
      return;
    }
    if (act === "save-edit") {
      const email = ($("edMail_" + key) && $("edMail_" + key).value.trim()) || "";
      const note = ($("edNote_" + key) && $("edNote_" + key).value.trim()) || "";
      const maxDevices = Number(($("edMax_" + key) && $("edMax_" + key).value) || 2);
      btn.disabled = true;
      const res = await callAdminApi({ action: "update", key, email, note, maxDevices });
      btn.disabled = false;
      if (res.unauthorized) { denyAndRedirect(); return; }
      if (!res.okHttp) {
        showNotice($("admActionMsg"), (res.data && res.data.message) || "保存に失敗しました。", "err");
        return;
      }
      openEditKeys.delete(key);
      showNotice($("admActionMsg"), `✅ ${key} の契約情報を更新しました。`, "ok");
      await loadDashboard(false);
      return;
    }
    if (act === "resend") {
      const curEmail = btn.dataset.email || "";
      const nextEmail = window.prompt("ライセンス案内メールの送信先アドレスを確認・入力してください：", curEmail);
      if (nextEmail === null) return;
      const trimmed = nextEmail.trim();
      if (!trimmed) {
        showNotice($("admActionMsg"), "メールアドレスを入力してください。", "err");
        return;
      }
      btn.disabled = true;
      const res = await callAdminApi({ action: "resend", key, email: trimmed });
      btn.disabled = false;
      if (res.unauthorized) { denyAndRedirect(); return; }
      const mr = (res.data && res.data.emailResult) || {};
      if (res.okHttp && mr.sent) {
        showNotice($("admActionMsg"), `✉️ ${trimmed} 宛にライセンス案内メールを再送しました。`, "ok");
      } else {
        showNotice($("admActionMsg"), `⚠️ メール送信に失敗しました（${(res.data && res.data.message) || mr.reason || "error"}）。`, "err");
      }
      await loadDashboard(false);
      return;
    }
    if (act === "reset-devs") {
      const isOwner = btn.dataset.owner === "1";
      const msg = isOwner
        ? "現在操作中のこの端末を除き、他の登録端末枠をすべてリセットしますか？"
        : `キー（${key}）に登録されている全端末枠をリセット（0台）にしますか？`;
      if (!window.confirm(msg)) return;
      btn.disabled = true;
      const res = await callAdminApi({ action: "reset_devices", key });
      btn.disabled = false;
      if (res.unauthorized) { denyAndRedirect(); return; }
      showNotice($("admActionMsg"), `📱 ${key} の端末登録枠をリセットしました。`, "ok");
      await loadDashboard(false);
      return;
    }
    if (act === "remove-dev") {
      const targetDeviceId = btn.dataset.dev || "";
      btn.disabled = true;
      const res = await callAdminApi({ action: "remove_device", key, targetDeviceId });
      btn.disabled = false;
      if (res.unauthorized) { denyAndRedirect(); return; }
      if (!res.okHttp) {
        showNotice($("admActionMsg"), (res.data && res.data.message) || "端末解除に失敗しました。", "err");
        return;
      }
      showNotice($("admActionMsg"), `📱 ${key} から端末1台を解除しました。`, "ok");
      await loadDashboard(false);
      return;
    }
    if (act === "revoke") {
      if (!window.confirm(`キー（${key}）を利用停止にしますか？\n（対象ユーザーの端末は自動的に無料プランへ切り戻されます）`)) return;
      btn.disabled = true;
      const res = await callAdminApi({ action: "revoke", key });
      btn.disabled = false;
      if (res.unauthorized) { denyAndRedirect(); return; }
      if (!res.okHttp) {
        showNotice($("admActionMsg"), (res.data && res.data.message) || "停止に失敗しました。", "err");
        return;
      }
      showNotice($("admActionMsg"), `⏸ ${key} を利用停止にしました。`, "ok");
      await loadDashboard(false);
      return;
    }
    if (act === "reactivate") {
      if (!window.confirm(`キー（${key}）を再有効化しますか？`)) return;
      btn.disabled = true;
      const res = await callAdminApi({ action: "reactivate", key });
      btn.disabled = false;
      if (res.unauthorized) { denyAndRedirect(); return; }
      showNotice($("admActionMsg"), `▶ ${key} を再有効化しました。`, "ok");
      await loadDashboard(false);
      return;
    }
    if (act === "delete") {
      if (!window.confirm(`キー（${key}）を完全に削除しますか？この操作は取り消せません。`)) return;
      btn.disabled = true;
      const res = await callAdminApi({ action: "delete", key });
      btn.disabled = false;
      if (res.unauthorized) { denyAndRedirect(); return; }
      if (!res.okHttp) {
        showNotice($("admActionMsg"), (res.data && res.data.message) || "削除できませんでした。", "err");
        return;
      }
      showNotice($("admActionMsg"), `🗑 ${key} を削除しました。`, "ok");
      await loadDashboard(false);
      if (dashData && Array.isArray(dashData.records) && dashData.records.some((x) => x.key === key)) {
        dashData.records = dashData.records.filter((x) => x.key !== key);
        renderDashboard();
      }
    }
  });

  // 初期認証チェック：未ログイン・一般有料キーの場合は即座に index.html へリダイレクト
  const savedKey = normKey(localStorage.getItem(LS_KEY) || "");
  if (!savedKey || !apiBase()) {
    denyAndRedirect();
  } else {
    loadDashboard(false);
  }
})();
