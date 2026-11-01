/**
 * BAメーカー ライセンス自動発行・端末2台制限・解約自動遮断サーバー（Cloudflare Workers + KV）
 *
 * 役割：
 * 1. Stripe決済完了（Webhook / Redirect）で個別ライセンスキーを自動発行し、独自ドメインメールで即時自動送信
 * 2. 1ライセンスにつき最大2台（MAX_DEVICES=2）までの端末認証・解除管理
 * 3. サブスク解約・未払い発生時に自動でキーを無効化し、アプリ側を無料プランへ自動切り戻し
 */

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 0,O,1,I を除外

function normKey(k) {
  return String(k || "").trim().toUpperCase().replace(/\s+/g, "");
}

function normDeviceId(d) {
  return String(d || "").trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
}

function maskKey(k) {
  const n = normKey(k);
  const parts = n.split("-");
  if (parts.length === 4) return `${parts[0]}-${parts[1]}-••••-${parts[3].slice(-2)}••`;
  return n.slice(0, 8) + "••••";
}

function generateLicenseKey() {
  const seg = () => {
    const buf = new Uint8Array(4);
    crypto.getRandomValues(buf);
    return Array.from(buf, (b) => ALPHABET[b % ALPHABET.length]).join("");
  };
  return `BAM-${seg()}-${seg()}-${seg()}`;
}

function getMaxDevices(env, record) {
  if (record && typeof record.maxDevices === "number" && record.maxDevices >= 1) {
    return record.maxDevices;
  }
  const n = parseInt(env.MAX_DEVICES || "2", 10);
  return Number.isFinite(n) && n >= 1 ? n : 2;
}

function corsHeaders(env, request) {
  const reqOrigin = (request && request.headers.get("Origin")) || "";
  const rawAllowed = String(env.ALLOWED_ORIGIN || "*").trim();
  let allowOrigin = "*";
  if (rawAllowed !== "*") {
    const list = rawAllowed.split(",").map((s) => s.trim()).filter(Boolean);
    if (list.includes(reqOrigin)) {
      allowOrigin = reqOrigin;
    } else if (reqOrigin.startsWith("http://localhost:") || reqOrigin.startsWith("http://127.0.0.1:")) {
      allowOrigin = reqOrigin;
    } else if (list.length > 0) {
      allowOrigin = list[0];
    }
  }
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

function jsonResp(data, status, env, request) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...corsHeaders(env, request)
    }
  });
}

// ---------- Stripe Webhook 署名検証（Web Crypto HMAC-SHA256） ----------
function timingSafeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function hmacSha256Hex(secret, payload) {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuf = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(payload));
  return Array.from(new Uint8Array(sigBuf), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function verifyStripeSignature(rawBody, sigHeader, webhookSecret) {
  if (!sigHeader || !webhookSecret) return false;
  const parts = sigHeader.split(",").map((s) => s.trim());
  let timestamp = "";
  const v1Sigs = [];
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq);
    const v = part.slice(eq + 1);
    if (k === "t") timestamp = v;
    else if (k === "v1") v1Sigs.push(v);
  }
  if (!timestamp || v1Sigs.length === 0) return false;
  const tsNum = parseInt(timestamp, 10);
  if (!Number.isFinite(tsNum)) return false;
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - tsNum) > 300) return false;

  const expected = await hmacSha256Hex(webhookSecret, `${timestamp}.${rawBody}`);
  return v1Sigs.some((s) => timingSafeEqualHex(s.toLowerCase(), expected));
}

function isAllowedBrowserOrigin(env, request) {
  const reqOrigin = (request && request.headers.get("Origin")) || "";
  if (!reqOrigin) return true;
  const rawAllowed = String(env.ALLOWED_ORIGIN || "*").trim();
  if (rawAllowed === "*") return true;
  if (reqOrigin.startsWith("http://localhost:") || reqOrigin.startsWith("http://127.0.0.1:")) return true;
  const list = rawAllowed.split(",").map((s) => s.trim()).filter(Boolean);
  return list.includes(reqOrigin);
}

function isAdminLicenseRecord(env, record) {
  if (!record || record.status !== "active") return false;
  const ownerKey = normKey(env.OWNER_LICENSE_KEY || "");
  if (ownerKey && timingSafeEqualHex(normKey(record.key), ownerKey)) return true;
  return record.isAdmin === true;
}

// ---------- KV ストレージ操作 ----------
const AUDIT_LOG_KEY = "meta:audit_log";
const KEY_INDEX_KEY = "meta:key_index";
const MAX_AUDIT_LOGS = 80;

async function getKeyIndex(env) {
  try {
    const raw = await env.LICENSES.get(KEY_INDEX_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map((k) => normKey(k)).filter(Boolean) : [];
  } catch (e) {
    return [];
  }
}

async function addKeyToIndex(env, nk) {
  if (!nk) return;
  try {
    const idx = await getKeyIndex(env);
    if (!idx.includes(nk)) {
      idx.unshift(nk);
      await env.LICENSES.put(KEY_INDEX_KEY, JSON.stringify(idx));
    }
  } catch (e) {}
}

async function removeKeyFromIndex(env, nk) {
  if (!nk) return;
  try {
    const idx = await getKeyIndex(env);
    const next = idx.filter((k) => k !== nk);
    if (next.length !== idx.length) {
      await env.LICENSES.put(KEY_INDEX_KEY, JSON.stringify(next));
    }
  } catch (e) {}
}

async function getAuditLogs(env) {
  try {
    const raw = await env.LICENSES.get(AUDIT_LOG_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

async function appendAuditLog(env, entry) {
  try {
    const logs = await getAuditLogs(env);
    const k = normKey(entry.key || "");
    logs.unshift({
      id: "ev_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 6),
      at: new Date().toISOString(),
      type: String(entry.type || "info"),
      key: k ? maskKey(k) : "",
      rawKey: k || "",
      email: String(entry.email || "").slice(0, 120),
      detail: String(entry.detail || "").slice(0, 200)
    });
    if (logs.length > MAX_AUDIT_LOGS) logs.length = MAX_AUDIT_LOGS;
    await env.LICENSES.put(AUDIT_LOG_KEY, JSON.stringify(logs));
  } catch (e) {}
}

async function getLicenseRecord(env, key) {
  const nk = normKey(key);
  if (!nk) return null;
  const raw = await env.LICENSES.get(`lic:${nk}`);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

async function saveLicenseRecord(env, record) {
  const nk = normKey(record.key);
  record.key = nk;
  record.updatedAt = new Date().toISOString();
  await env.LICENSES.put(`lic:${nk}`, JSON.stringify(record));
  await addKeyToIndex(env, nk);
  if (record.subscriptionId) {
    await env.LICENSES.put(`sub:${record.subscriptionId}`, nk);
  }
  if (record.customerId) {
    await env.LICENSES.put(`cus:${record.customerId}`, nk);
  }
  if (record.checkoutSessionId) {
    await env.LICENSES.put(`cs:${record.checkoutSessionId}`, nk, { expirationTtl: 60 * 60 * 24 * 14 });
  }
}

async function deleteLicenseRecord(env, record) {
  if (!record || !record.key) return;
  const nk = normKey(record.key);
  await env.LICENSES.delete(`lic:${nk}`);
  await removeKeyFromIndex(env, nk);
  if (record.subscriptionId) await env.LICENSES.delete(`sub:${record.subscriptionId}`);
  if (record.customerId) await env.LICENSES.delete(`cus:${record.customerId}`);
  if (record.checkoutSessionId) await env.LICENSES.delete(`cs:${record.checkoutSessionId}`);
}

async function listAllLicenseRecords(env) {
  const nameSet = new Set();
  const indexedKeys = await getKeyIndex(env);
  for (const nk of indexedKeys) {
    if (nk) nameSet.add(`lic:${nk}`);
  }
  if (typeof env.LICENSES.list === "function") {
    let cursor = undefined;
    for (let pageIdx = 0; pageIdx < 20; pageIdx++) {
      const res = await env.LICENSES.list({ prefix: "lic:", cursor });
      if (res && Array.isArray(res.keys)) {
        for (const item of res.keys) {
          if (item && item.name) nameSet.add(item.name);
        }
      }
      if (!res || res.list_complete || !res.cursor) break;
      cursor = res.cursor;
    }
  }
  const names = Array.from(nameSet);
  const rawList = await Promise.all(names.map((n) => env.LICENSES.get(n)));
  const records = [];
  for (const raw of rawList) {
    if (!raw) continue;
    try {
      const rec = JSON.parse(raw);
      if (rec && rec.key) records.push(rec);
    } catch (e) {}
  }
  records.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  return records;
}

async function findRecordByStripeIds(env, { sessionId, subscriptionId, customerId }) {
  if (sessionId) {
    const k = await env.LICENSES.get(`cs:${sessionId}`);
    if (k) {
      const rec = await getLicenseRecord(env, k);
      if (rec) return rec;
    }
  }
  if (subscriptionId) {
    const k = await env.LICENSES.get(`sub:${subscriptionId}`);
    if (k) {
      const rec = await getLicenseRecord(env, k);
      if (rec) return rec;
    }
  }
  if (customerId) {
    const k = await env.LICENSES.get(`cus:${customerId}`);
    if (k) {
      const rec = await getLicenseRecord(env, k);
      if (rec) return rec;
    }
  }
  return null;
}

function extractStripeCustomerName(obj) {
  if (!obj) return "";
  const fromCustom = Array.isArray(obj.custom_fields)
    ? obj.custom_fields.map((f) => (f && f.text && f.text.value) || "").find(Boolean)
    : "";
  const raw = fromCustom
    || (obj.customer_details && obj.customer_details.name)
    || obj.customer_name
    || (obj.shipping_details && obj.shipping_details.name)
    || "";
  return String(raw || "").trim().slice(0, 100);
}

async function issueOrGetLicense(env, { sessionId, customerId, subscriptionId, email, customerName, maxDevices }) {
  const cleanName = String(customerName || "").trim().slice(0, 100);
  let existing = await findRecordByStripeIds(env, { sessionId, subscriptionId });
  if (!existing && customerId) {
    const byCus = await findRecordByStripeIds(env, { customerId });
    // 同一サブスク（またはサブスクID未確定）の場合のみ既存レコードを再利用し、解約後の新規再契約では新しいキーを発行する
    if (byCus && (!subscriptionId || !byCus.subscriptionId || byCus.subscriptionId === subscriptionId)) {
      existing = byCus;
    }
  }
  if (existing) {
    let changed = false;
    if (sessionId && existing.checkoutSessionId !== sessionId) { existing.checkoutSessionId = sessionId; changed = true; }
    if (subscriptionId && existing.subscriptionId !== subscriptionId) { existing.subscriptionId = subscriptionId; changed = true; }
    if (customerId && !existing.customerId) { existing.customerId = customerId; changed = true; }
    if (email && !existing.email) { existing.email = String(email).trim(); changed = true; }
    if (cleanName && !existing.customerName) { existing.customerName = cleanName; changed = true; }
    if (existing.status !== "active") {
      existing.status = "active";
      existing.revokedReason = null;
      existing.cancelAtPeriodEnd = false;
      changed = true;
    }
    if (changed) await saveLicenseRecord(env, existing);
    return existing;
  }

  // 未使用キーを生成（万一の衝突も回避）
  let key = generateLicenseKey();
  for (let i = 0; i < 5; i++) {
    const dup = await env.LICENSES.get(`lic:${key}`);
    if (!dup) break;
    key = generateLicenseKey();
  }

  const now = new Date().toISOString();
  const record = {
    key,
    email: String(email || "").trim(),
    customerName: cleanName,
    customerId: customerId || null,
    subscriptionId: subscriptionId || null,
    checkoutSessionId: sessionId || null,
    status: "active",
    revokedReason: null,
    cancelAtPeriodEnd: false,
    currentPeriodEnd: null,
    maxDevices: maxDevices || getMaxDevices(env, null),
    devices: [],
    emailSentAt: null,
    createdAt: now,
    updatedAt: now
  };
  await saveLicenseRecord(env, record);
  return record;
}

// ---------- 自動メール送信（Gmail+GAS / Resend / SendGrid 対応） ----------
function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function sendLicenseEmail(env, record, opts) {
  opts = opts || {};
  const isRecovery = !!opts.isRecovery;
  if (!record.email) return { sent: false, reason: "no_email" };
  const brand = env.BRAND_NAME || "BAメーカー";
  const baseAppUrl = String(env.APP_URL || "https://seitaimichibiki-cpu.github.io/ba-maker/").replace(/\?.*$/, "");
  const sep = baseAppUrl.endsWith("/") ? "" : "/";
  const activateUrl = `${baseAppUrl}${sep}?key=${encodeURIComponent(record.key)}`;
  const helpUrl = `${baseAppUrl}${sep}help.html`;
  const maxDev = getMaxDevices(env, record);
  const lineUrl = String(env.LINE_CONTACT_URL || "https://lin.ee/XB6R3kS").trim();

  const subject = isRecovery
    ? `【${brand}】ライセンスキー再送のご案内`
    : `【${brand}】有料プランのライセンスキーをお届けします`;

  const leadText = isRecovery
    ? `${brand} をご利用いただきありがとうございます。ご登録メールアドレス宛にライセンスキーを再送いたします。`
    : `${brand} 有料プランにお申し込みいただきありがとうございます。`;

  const textBody = [
    leadText,
    "",
    "以下の「ワンタップ有効化リンク」を開くだけで、すぐにご利用いただけます。",
    "（透かしなし・1080pフルHD・AI顔ぼかし追従・姿勢基準線＆スタンプ・ラスト2秒LINE誘導カット・上下分割／スライド比較・4:5／1:1サイズ切替・全テーマ＆院ロゴ）",
    `▼ ワンタップで有料プランを有効化する`,
    activateUrl,
    "",
    "▼ ライセンスキー（手動入力・2台目の登録用）",
    record.key,
    "",
    "【ご利用ルール】",
    `・1契約につき最大 ${maxDev}台 の端末（例：院のiPad＋パソコン等）でご利用いただけます。`,
    "・機種変更や別の端末へ切り替える際は、画面右上の「プラン・端末管理」から「この端末のライセンスを解除する」を押すと枠が空きます。",
    "",
    `▼ 使い方・ヘルプ・ご契約について`,
    helpUrl,
    lineUrl ? `\n▼ お問い合わせ窓口（公式LINEのみ）\n${lineUrl}` : "",
    "※本メールは送信専用です。ご返信いただいても対応いたしかねますので、お問い合わせは公式LINEよりお願いいたします。",
    "",
    `今後とも ${brand} をよろしくお願いいたします。`
  ].filter((line, idx, arr) => !(line === "" && arr[idx - 1] === "")).join("\n");

  const htmlHeading = isRecovery
    ? `🔑 ${escapeHtml(brand)} ライセンスキー再送のご案内`
    : `🎬 ${escapeHtml(brand)} 有料プランへようこそ`;

  const htmlBody = `
<div style="font-family:'Hiragino Sans','Noto Sans JP',Meiryo,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#1a1a1a;line-height:1.7">
  <h2 style="margin:0 0 16px;font-size:20px;color:#111">${htmlHeading}</h2>
  <p style="margin:0 0 16px">${escapeHtml(leadText)}<br>下のボタンを押すだけで、お使いの端末ですぐに<strong>有料プラン（透かしなし・1080pフルHD・AI顔ぼかし追従・姿勢基準線＆注目スタンプ・ラスト2秒LINE誘導カット・上下分割／スライド比較・4:5／1:1サイズ切替・全テーマ＆院ロゴ）</strong>が有効になります。</p>
  <div style="text-align:center;margin:24px 0">
    <a href="${escapeHtml(activateUrl)}" style="display:inline-block;background:#ff5a5f;color:#ffffff;text-decoration:none;font-weight:700;padding:14px 28px;border-radius:10px;font-size:16px">⭐ ワンタップで有料プランを有効化する</a>
  </div>
  <div style="background:#f5f6f8;border:1px solid #dfe3ea;border-radius:10px;padding:16px;margin:20px 0;text-align:center">
    <div style="font-size:12px;color:#666;margin-bottom:4px">ライセンスキー（手動入力・2台目の端末登録用）</div>
    <div style="font-family:monospace;font-size:20px;font-weight:700;letter-spacing:1px;color:#111">${escapeHtml(record.key)}</div>
  </div>
  <ul style="font-size:14px;color:#444;padding-left:20px;margin:16px 0">
    <li>1契約につき<strong>最大 ${maxDev}台 まで</strong>同時登録できます（例：iPad＋PC）。</li>
    <li>端末を入れ替える際は、アプリ画面右上の<strong>「プラン・端末管理」→「この端末のライセンスを解除する」</strong>で枠を空けられます。</li>
  </ul>
  <p style="font-size:13px;color:#666;margin-top:20px">使い方・よくある質問・ご契約情報：<a href="${escapeHtml(helpUrl)}" style="color:#555">${escapeHtml(helpUrl)}</a></p>
  <div style="font-size:12px;color:#666;margin-top:16px;border-top:1px solid #eee;padding-top:12px">
    ${lineUrl ? `<p style="margin:0 0 6px">お問い合わせ窓口（公式LINEのみ）：<a href="${escapeHtml(lineUrl)}" style="color:#06c755;font-weight:700">${escapeHtml(lineUrl)}</a></p>` : ""}
    <p style="margin:0;color:#888">※本メールは自動送信専用です。返信での対応は行っておりませんので、お問い合わせは公式LINEよりお願いいたします。</p>
  </div>
</div>`.trim();

  // 1. 独自ドメイン不要：Gmail ＋ Google Apps Script（GAS）経由で自動送信
  if (env.GAS_WEBHOOK_URL) {
    const gasSecret = String(env.GAS_EMAIL_SECRET || env.ADMIN_SECRET || "").trim();
    let resp = await fetch(String(env.GAS_WEBHOOK_URL).trim(), {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({
        secret: gasSecret,
        to: record.email,
        subject,
        text: textBody,
        html: htmlBody,
        senderName: brand
      }),
      redirect: "manual"
    });
    // GAS Webアプリの302リダイレクト（script.googleusercontent.com）をGETで追跡して結果JSONを取得
    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get("Location");
      if (loc) {
        resp = await fetch(loc, { method: "GET" });
      }
    }
    const rawText = await resp.text();
    let gasJson = null;
    try { gasJson = JSON.parse(rawText); } catch (e) {}
    if (!resp.ok || !gasJson || gasJson.ok !== true) {
      console.error("GAS email error:", resp.status, rawText.slice(0, 300));
      return { sent: false, reason: (gasJson && gasJson.error) ? `gas_${gasJson.error}` : `gas_${resp.status}` };
    }
    return { sent: true, provider: "gmail_gas" };
  }

  const fromEmail = env.FROM_EMAIL || "BAメーカー <seitaimichibiki@gmail.com>";

  if (env.RESEND_API_KEY) {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [record.email],
        subject,
        html: htmlBody,
        text: textBody
      })
    });
    if (!resp.ok) {
      const errText = await resp.text();
      console.error("Resend error:", resp.status, errText);
      return { sent: false, reason: `resend_${resp.status}` };
    }
    return { sent: true, provider: "resend" };
  }

  if (env.SENDGRID_API_KEY) {
    const match = fromEmail.match(/^(.*)<([^>]+)>$/);
    const fromObj = match
      ? { name: match[1].trim(), email: match[2].trim() }
      : { email: fromEmail.trim() };
    const resp = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.SENDGRID_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: record.email }] }],
        from: fromObj,
        subject,
        content: [
          { type: "text/plain", value: textBody },
          { type: "text/html", value: htmlBody }
        ]
      })
    });
    if (!resp.ok) {
      const errText = await resp.text();
      console.error("SendGrid error:", resp.status, errText);
      return { sent: false, reason: `sendgrid_${resp.status}` };
    }
    return { sent: true, provider: "sendgrid" };
  }

  console.warn("No email provider secret (GAS_WEBHOOK_URL / RESEND_API_KEY / SENDGRID_API_KEY) configured.");
  return { sent: false, reason: "no_provider" };
}

// ---------- 端末認証・2台制限ロジック ----------
async function checkAndBindDevice(env, record, deviceId, deviceLabel) {
  const maxDevices = getMaxDevices(env, record);
  if (record.status !== "active") {
    const msg = record.revokedReason === "payment_failed"
      ? "お支払いが確認できなかったため、有料プランが停止されています（無料プランに戻りました）。"
      : "このライセンスは解約済みのため無効です（無料プランに戻りました）。";
    return {
      ok: false,
      active: false,
      code: "INACTIVE",
      reason: record.revokedReason || "canceled",
      message: msg
    };
  }

  const devId = normDeviceId(deviceId);
  if (devId.length < 8) {
    return {
      ok: false,
      active: false,
      code: "BAD_DEVICE",
      message: "端末識別情報が不正です。ページを再読み込みしてお試しください。"
    };
  }

  if (!Array.isArray(record.devices)) record.devices = [];
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const cleanLabel = String(deviceLabel || "端末").trim().slice(0, 40) || "端末";

  const existing = record.devices.find((d) => d.id === devId);
  if (existing) {
    const lastMs = Date.parse(existing.lastSeenAt || "") || 0;
    // KV書き込み回数を節約するため、最終更新から1時間以上経過時のみ書き込む
    if (nowMs - lastMs > 3600_000) {
      existing.lastSeenAt = nowIso;
      existing.label = cleanLabel;
      await saveLicenseRecord(env, record);
    }
    return {
      ok: true,
      active: true,
      isAdmin: isAdminLicenseRecord(env, record),
      key: record.key,
      maskedKey: maskKey(record.key),
      deviceCount: record.devices.length,
      maxDevices,
      cancelAtPeriodEnd: !!record.cancelAtPeriodEnd,
      currentPeriodEnd: record.currentPeriodEnd || null
    };
  }

  if (record.devices.length >= maxDevices) {
    return {
      ok: false,
      active: false,
      code: "DEVICE_LIMIT",
      deviceCount: record.devices.length,
      maxDevices,
      message: `このライセンスキーは既に上限（${maxDevices}台）の端末で使用されています。別の端末で「この端末のライセンスを解除」を行ってから再度お試しください。`
    };
  }

  record.devices.push({
    id: devId,
    label: cleanLabel,
    firstSeenAt: nowIso,
    lastSeenAt: nowIso
  });
  await saveLicenseRecord(env, record);

  return {
    ok: true,
    active: true,
    isAdmin: isAdminLicenseRecord(env, record),
    key: record.key,
    maskedKey: maskKey(record.key),
    deviceCount: record.devices.length,
    maxDevices,
    cancelAtPeriodEnd: !!record.cancelAtPeriodEnd,
    currentPeriodEnd: record.currentPeriodEnd || null
  };
}

// ---------- 同一Stripeアカウント内の他サービス（ショクキュア・Logiction・シセビズ等）との混線防止 ----------
function isBaMakerCheckoutSession(env, sess) {
  if (!sess || typeof sess !== "object") return false;
  const expectedLink = String(env.STRIPE_PAYMENT_LINK_ID || "").trim();
  if (expectedLink) {
    if (sess.payment_link === expectedLink) return true;
    if (sess.metadata && sess.metadata.app === "ba-maker") return true;
    return false;
  }
  if (sess.metadata && sess.metadata.app) {
    return sess.metadata.app === "ba-maker";
  }
  const successUrl = String(sess.success_url || "").trim();
  if (successUrl) {
    const appBase = String(env.APP_URL || "https://seitaimichibiki-cpu.github.io/ba-maker/").replace(/\/+$/, "");
    return successUrl.includes("/ba-maker") || Boolean(appBase && successUrl.startsWith(appBase));
  }
  if (typeof sess.amount_total === "number" && sess.amount_total > 0 && sess.amount_total !== 480) {
    return false;
  }
  return true;
}

// ---------- Stripeステータス反映 ----------
function mapStripeSubStatus(stripeStatus) {
  if (stripeStatus === "active" || stripeStatus === "trialing") {
    return { status: "active", reason: null };
  }
  if (stripeStatus === "past_due" || stripeStatus === "unpaid") {
    return { status: "inactive", reason: "payment_failed" };
  }
  return { status: "inactive", reason: "canceled" };
}

// ---------- ルーティング ----------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(env, request) });
    }

    if (request.method === "GET" && (path === "/" || path === "/health")) {
      return jsonResp({ ok: true, service: "ba-maker-license", maxDevices: getMaxDevices(env, null) }, 200, env, request);
    }

    // 1. Stripe Webhook（自動発行・自動メール送信・解約/未払い自動遮断）
    if (request.method === "POST" && path === "/webhook/stripe") {
      const sig = request.headers.get("stripe-signature") || "";
      const rawBody = await request.text();
      const valid = await verifyStripeSignature(rawBody, sig, env.STRIPE_WEBHOOK_SECRET);
      if (!valid) {
        return jsonResp({ ok: false, error: "Invalid Stripe signature" }, 400, env, request);
      }

      let event;
      try { event = JSON.parse(rawBody); } catch (e) {
        return jsonResp({ ok: false, error: "Invalid JSON" }, 400, env, request);
      }

      const type = event.type;
      const obj = (event.data && event.data.object) || {};

      if (type === "checkout.session.completed") {
        if (!isBaMakerCheckoutSession(env, obj)) {
          return jsonResp({ ok: true, ignored: "other_product_checkout" }, 200, env, request);
        }
        const email = (obj.customer_details && obj.customer_details.email) || obj.customer_email || "";
        const customerName = extractStripeCustomerName(obj);
        const record = await issueOrGetLicense(env, {
          sessionId: obj.id,
          customerId: obj.customer,
          subscriptionId: obj.subscription,
          email,
          customerName
        });
        let sentNow = false;
        if (!record.emailSentAt && record.email) {
          const mailRes = await sendLicenseEmail(env, record);
          if (mailRes.sent) {
            record.emailSentAt = new Date().toISOString();
            await saveLicenseRecord(env, record);
            sentNow = true;
          }
        }
        const namePart = record.customerName ? `（${record.customerName}）` : "";
        await appendAuditLog(env, {
          type: "checkout_completed",
          key: record.key,
          email: record.email,
          detail: sentNow ? `Stripe決済完了${namePart}・キー自動発行＆案内メール送信` : `Stripe決済完了${namePart}・キー発行確認`
        });
        return jsonResp({ ok: true, handled: type, key: maskKey(record.key) }, 200, env, request);
      }

      if (type === "customer.subscription.updated" || type === "customer.subscription.deleted") {
        const record = await findRecordByStripeIds(env, {
          subscriptionId: obj.id,
          customerId: obj.customer
        });
        if (record && (!record.subscriptionId || !obj.id || record.subscriptionId === obj.id)) {
          if (type === "customer.subscription.deleted") {
            record.status = "inactive";
            record.revokedReason = "canceled";
            record.cancelAtPeriodEnd = false;
            record.canceledAt = new Date().toISOString();
            await saveLicenseRecord(env, record);
            await appendAuditLog(env, {
              type: "subscription_canceled",
              key: record.key,
              email: record.email,
              detail: "サブスク解約完了により自動利用停止"
            });
          } else {
            const mapped = mapStripeSubStatus(obj.status);
            const itemPeriodEnd = obj.items && obj.items.data && obj.items.data[0] && obj.items.data[0].current_period_end;
            record.status = mapped.status;
            record.revokedReason = mapped.reason;
            record.cancelAtPeriodEnd = Boolean(obj.cancel_at_period_end || obj.cancel_at);
            record.currentPeriodEnd = obj.cancel_at || obj.current_period_end || itemPeriodEnd || null;
            if (mapped.reason === "payment_failed") {
              record.paymentFailedAt = new Date().toISOString();
            }
            await saveLicenseRecord(env, record);
            await appendAuditLog(env, {
              type: mapped.reason === "payment_failed" ? "payment_failed" : "subscription_updated",
              key: record.key,
              email: record.email,
              detail: mapped.reason === "payment_failed"
                ? `決済未完了（${obj.status}）により自動利用停止`
                : (record.cancelAtPeriodEnd ? "期間終了での解約予約を反映" : `契約ステータス同期（${obj.status}）`)
            });
          }
        }
        return jsonResp({ ok: true, handled: type }, 200, env, request);
      }

      if (type === "invoice.payment_failed") {
        const subId = obj.subscription || (obj.parent && obj.parent.subscription_details && obj.parent.subscription_details.subscription) || null;
        const record = await findRecordByStripeIds(env, {
          subscriptionId: subId,
          customerId: obj.customer
        });
        if (record && (!record.subscriptionId || !subId || record.subscriptionId === subId)) {
          if (!record.customerName && obj.customer_name) {
            record.customerName = String(obj.customer_name).trim().slice(0, 100);
          }
          if (!record.email && obj.customer_email) {
            record.email = String(obj.customer_email).trim().slice(0, 120);
          }
          record.status = "inactive";
          record.revokedReason = "payment_failed";
          record.paymentFailedAt = new Date().toISOString();
          await saveLicenseRecord(env, record);
          await appendAuditLog(env, {
            type: "payment_failed",
            key: record.key,
            email: record.email,
            detail: "カード決済失敗（invoice.payment_failed）により自動利用停止"
          });
        }
        return jsonResp({ ok: true, handled: type }, 200, env, request);
      }

      if (type === "invoice.paid" || type === "invoice.payment_succeeded") {
        const subId = obj.subscription || (obj.parent && obj.parent.subscription_details && obj.parent.subscription_details.subscription) || null;
        const record = await findRecordByStripeIds(env, {
          subscriptionId: subId,
          customerId: obj.customer
        });
        if (record && (!record.subscriptionId || !subId || record.subscriptionId === subId)) {
          if (!record.customerName && obj.customer_name) {
            record.customerName = String(obj.customer_name).trim().slice(0, 100);
          }
          if (!record.email && obj.customer_email) {
            record.email = String(obj.customer_email).trim().slice(0, 120);
          }
          const wasPaymentFailed = record.revokedReason === "payment_failed";
          record.lastPaidAt = new Date().toISOString();
          if (wasPaymentFailed) {
            record.status = "active";
            record.revokedReason = null;
          }
          await saveLicenseRecord(env, record);
          if (wasPaymentFailed) {
            await appendAuditLog(env, {
              type: "payment_recovered",
              key: record.key,
              email: record.email,
              detail: "再決済成功により自動利用再開"
            });
          }
        }
        return jsonResp({ ok: true, handled: type }, 200, env, request);
      }

      return jsonResp({ ok: true, ignored: type }, 200, env, request);
    }

    // 以下はJSONボディを受け取るAPI
    let body = {};
    if (request.method === "POST") {
      try { body = await request.json(); } catch (e) {
        return jsonResp({ ok: false, message: "リクエスト形式が不正です。" }, 400, env, request);
      }
    }

    // 2. ライセンス有効化・定期照合（端末2台制限＆解約チェック）
    if (request.method === "POST" && (path === "/api/activate" || path === "/api/verify")) {
      const key = normKey(body.key);
      if (!key) {
        return jsonResp({ ok: false, active: false, code: "EMPTY_KEY", message: "ライセンスキーを入力してください。" }, 400, env, request);
      }
      const record = await getLicenseRecord(env, key);
      if (!record) {
        return jsonResp({ ok: false, active: false, code: "INVALID_KEY", message: "ライセンスキーが正しくありません。" }, 404, env, request);
      }
      const result = await checkAndBindDevice(env, record, body.deviceId, body.deviceLabel);
      return jsonResp(result, result.ok ? 200 : 403, env, request);
    }

    // 3. この端末のライセンス解除（2台枠から1台分を解放）
    if (request.method === "POST" && path === "/api/deactivate") {
      const key = normKey(body.key);
      const devId = normDeviceId(body.deviceId);
      const record = await getLicenseRecord(env, key);
      if (!record) {
        return jsonResp({ ok: true, released: false }, 200, env, request);
      }
      const beforeLen = Array.isArray(record.devices) ? record.devices.length : 0;
      record.devices = (record.devices || []).filter((d) => d.id !== devId);
      if (record.devices.length !== beforeLen) {
        await saveLicenseRecord(env, record);
      }
      return jsonResp({
        ok: true,
        released: record.devices.length !== beforeLen,
        deviceCount: record.devices.length,
        maxDevices: getMaxDevices(env, record)
      }, 200, env, request);
    }

    // 4. Stripe決済完了後のリダイレクト即時有効化（?session_id=cs_...）
    if (request.method === "POST" && path === "/api/claim-session") {
      const sessionId = String(body.sessionId || "").trim();
      if (!sessionId.startsWith("cs_")) {
        return jsonResp({ ok: false, code: "BAD_SESSION", message: "決済セッションIDが不正です。" }, 400, env, request);
      }
      let record = await findRecordByStripeIds(env, { sessionId });

      // Webhookより先にリダイレクトが到着した場合、STRIPE_SECRET_KEYがあればStripe APIで直接確認して即時発行
      if (!record && env.STRIPE_SECRET_KEY) {
        const sResp = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
          headers: { "Authorization": `Bearer ${env.STRIPE_SECRET_KEY}` }
        });
        if (sResp.ok) {
          const sess = await sResp.json();
          if (sess && isBaMakerCheckoutSession(env, sess) && (sess.payment_status === "paid" || sess.status === "complete")) {
            const email = (sess.customer_details && sess.customer_details.email) || sess.customer_email || "";
            const customerName = extractStripeCustomerName(sess);
            record = await issueOrGetLicense(env, {
              sessionId: sess.id,
              customerId: sess.customer,
              subscriptionId: sess.subscription,
              email,
              customerName
            });
            if (!record.emailSentAt && record.email) {
              const mailRes = await sendLicenseEmail(env, record);
              if (mailRes.sent) {
                record.emailSentAt = new Date().toISOString();
                await saveLicenseRecord(env, record);
              }
            }
          }
        }
      }

      if (!record) {
        return jsonResp({ ok: false, code: "PENDING", message: "決済確認中です。数秒お待ちください…" }, 202, env, request);
      }

      const result = await checkAndBindDevice(env, record, body.deviceId, body.deviceLabel);
      return jsonResp(result, result.ok ? 200 : 403, env, request);
    }

    // 4-2. ライセンスキーを忘れた方用のセルフメール再送（登録メアド宛のみ送信・メールアドレス探索防止＆レート制限付き）
    if (request.method === "POST" && path === "/api/recover-key") {
      if (!isAllowedBrowserOrigin(env, request)) {
        return jsonResp({ ok: false, error: "ForbiddenOrigin", message: "許可されていないアクセス元です。" }, 403, env, request);
      }
      const rawEmail = String(body.email || "").trim().toLowerCase();
      if (!rawEmail || rawEmail.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail)) {
        return jsonResp({ ok: false, code: "INVALID_EMAIL", message: "購入時にご登録のメールアドレスを正しく入力してください。" }, 400, env, request);
      }

      const clientIp = String(request.headers.get("CF-Connecting-IP") || "local").slice(0, 64);
      const ipKey = `rl:recover_ip:${clientIp}`;
      let ipCount = 0;
      try {
        ipCount = parseInt(await env.LICENSES.get(ipKey) || "0", 10) || 0;
      } catch (e) {}
      if (ipCount >= 6) {
        return jsonResp({
          ok: false,
          code: "RATE_LIMITED",
          message: "短時間に送信が集中しています。15分ほど時間をおいてからお試しください。"
        }, 429, env, request);
      }
      try {
        await env.LICENSES.put(ipKey, String(ipCount + 1), { expirationTtl: 900 });
      } catch (e) {}

      const genericMsg = "ご入力のメールアドレスに有効なご契約がある場合、ライセンスキーと有効化リンクをメールでお送りしました（数分経っても届かない場合は迷惑メールフォルダをご確認いただくか、購入時のメールアドレスをご確認ください）。";
      const mailCooldownKey = `rl:recover_mail:${rawEmail}`;
      try {
        const cooled = await env.LICENSES.get(mailCooldownKey);
        if (cooled) {
          return jsonResp({ ok: true, message: genericMsg }, 200, env, request);
        }
      } catch (e) {}

      const all = await listAllLicenseRecords(env);
      const matched = all.find((r) =>
        r &&
        r.status === "active" &&
        !isAdminLicenseRecord(env, r) &&
        String(r.email || "").trim().toLowerCase() === rawEmail
      );

      try {
        await env.LICENSES.put(mailCooldownKey, "1", { expirationTtl: 180 });
      } catch (e) {}

      if (matched) {
        const mailRes = await sendLicenseEmail(env, matched, { isRecovery: true });
        if (mailRes.sent) {
          matched.emailSentAt = new Date().toISOString();
          await saveLicenseRecord(env, matched);
        }
        await appendAuditLog(env, {
          type: "self_recover",
          key: matched.key,
          email: matched.email,
          detail: mailRes.sent
            ? "ユーザー操作によりキー再送メールを自動送信"
            : `ユーザーのキー再送操作（送信失敗: ${mailRes.reason || "error"}）`
        });
      }

      return jsonResp({ ok: true, message: genericMsg }, 200, env, request);
    }

    // 5. 管理者用API（CLI用 Bearer ADMIN_SECRET または 管理者ライセンスキー＋端末認証の両対応）
    if (request.method === "POST" && path === "/api/admin") {
      const auth = request.headers.get("Authorization") || "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
      let authMode = "";
      let authDeviceId = "";

      if (env.ADMIN_SECRET && token && timingSafeEqualHex(token, String(env.ADMIN_SECRET))) {
        authMode = "secret";
      } else if (body && body.authKey) {
        if (!isAllowedBrowserOrigin(env, request)) {
          return jsonResp({ ok: false, error: "ForbiddenOrigin", message: "許可されていないアクセス元です。" }, 403, env, request);
        }
        const adminRec = await getLicenseRecord(env, body.authKey);
        if (!adminRec || !isAdminLicenseRecord(env, adminRec)) {
          return jsonResp({ ok: false, error: "Unauthorized", message: "管理者ライセンスの権限がありません。" }, 401, env, request);
        }
        const bind = await checkAndBindDevice(env, adminRec, body.deviceId, body.deviceLabel || "管理者端末");
        if (!bind.ok) {
          return jsonResp({ ok: false, error: bind.code || "DeviceRejected", message: bind.message || "管理者端末の認証に失敗しました。" }, 403, env, request);
        }
        authMode = "owner_key";
        authDeviceId = normDeviceId(body.deviceId);
      } else {
        return jsonResp({ ok: false, error: "Unauthorized", message: "管理者認証が必要です。" }, 401, env, request);
      }

      const action = body.action;
      const baseAppUrl = String(env.APP_URL || "https://seitaimichibiki-cpu.github.io/ba-maker/").replace(/\?.*$/, "");
      const appSep = baseAppUrl.endsWith("/") ? "" : "/";

      if (action === "dashboard") {
        const all = await listAllLicenseRecords(env);
        const auditLogs = await getAuditLogs(env);
        let activePaidCount = 0;
        let activeManualCount = 0;
        let paymentFailedCount = 0;
        let canceledCount = 0;
        let cancelScheduledCount = 0;
        let totalBoundDevices = 0;

        const records = all.map((r) => {
          const isOwnerAdmin = isAdminLicenseRecord(env, r);
          const devs = Array.isArray(r.devices) ? r.devices : [];
          const maxDev = getMaxDevices(env, r);
          const isStripe = Boolean(r.subscriptionId || r.checkoutSessionId);

          if (r.status === "active") {
            if (!isOwnerAdmin) {
              totalBoundDevices += devs.length;
              if (isStripe) activePaidCount++;
              else activeManualCount++;
              if (r.cancelAtPeriodEnd) cancelScheduledCount++;
            }
          } else if (r.revokedReason === "payment_failed") {
            paymentFailedCount++;
          } else {
            canceledCount++;
          }

          return {
            key: r.key,
            maskedKey: maskKey(r.key),
            activateUrl: `${baseAppUrl}${appSep}?key=${encodeURIComponent(r.key)}`,
            isOwnerAdmin,
            isStripe,
            customerName: r.customerName || "",
            email: r.email || "",
            note: r.note || "",
            status: r.status || "inactive",
            revokedReason: r.revokedReason || null,
            cancelAtPeriodEnd: !!r.cancelAtPeriodEnd,
            currentPeriodEnd: r.currentPeriodEnd || null,
            deviceCount: devs.length,
            maxDevices: maxDev,
            devices: devs,
            emailSentAt: r.emailSentAt || null,
            paymentFailedAt: r.paymentFailedAt || null,
            lastPaidAt: r.lastPaidAt || null,
            canceledAt: r.canceledAt || null,
            subscriptionId: r.subscriptionId || null,
            customerId: r.customerId || null,
            createdAt: r.createdAt || null,
            updatedAt: r.updatedAt || null
          };
        });

        return jsonResp({
          ok: true,
          summary: {
            totalLicenses: records.length,
            activePaidCount,
            mrrYen: activePaidCount * 480,
            activeManualCount,
            paymentFailedCount,
            canceledCount,
            cancelScheduledCount,
            totalBoundDevices
          },
          systemInfo: {
            service: "ba-maker-license",
            defaultMaxDevices: getMaxDevices(env, null),
            autoSuspendOnPaymentFailure: true,
            autoRecoverOnInvoicePaid: true,
            selfKeyRecoveryEnabled: true,
            emailConfigured: Boolean(env.GAS_WEBHOOK_URL || env.RESEND_API_KEY || env.SENDGRID_API_KEY),
            stripeSecretConfigured: Boolean(env.STRIPE_SECRET_KEY),
            webhookSecretConfigured: Boolean(env.STRIPE_WEBHOOK_SECRET),
            paymentLinkConfigured: Boolean(env.STRIPE_PAYMENT_LINK_ID)
          },
          currentDeviceId: authDeviceId || null,
          records,
          auditLogs
        }, 200, env, request);
      }

      if (action === "issue") {
        let key = generateLicenseKey();
        for (let i = 0; i < 5; i++) {
          const dup = await env.LICENSES.get(`lic:${key}`);
          if (!dup) break;
          key = generateLicenseKey();
        }
        const now = new Date().toISOString();
        const rawMax = Number(body.maxDevices);
        const maxDev = (Number.isFinite(rawMax) && rawMax >= 1 && rawMax <= 50)
          ? Math.floor(rawMax)
          : getMaxDevices(env, null);
        const record = {
          key,
          customerName: String(body.customerName || "").trim().slice(0, 100),
          email: String(body.email || "").trim().slice(0, 120),
          customerId: null,
          subscriptionId: null,
          checkoutSessionId: null,
          status: "active",
          revokedReason: null,
          cancelAtPeriodEnd: false,
          currentPeriodEnd: null,
          maxDevices: maxDev,
          devices: [],
          emailSentAt: null,
          note: String(body.note || "").trim().slice(0, 100),
          createdAt: now,
          updatedAt: now
        };
        await saveLicenseRecord(env, record);
        let mailRes = { sent: false };
        if (record.email && body.sendEmail !== false) {
          mailRes = await sendLicenseEmail(env, record);
          if (mailRes.sent) {
            record.emailSentAt = new Date().toISOString();
            await saveLicenseRecord(env, record);
          }
        }
        await appendAuditLog(env, {
          type: "admin_issue",
          key: record.key,
          email: record.email,
          detail: `手動発行（上限${maxDev}台${record.customerName ? " / " + record.customerName : ""}${record.note ? " / " + record.note : ""}${mailRes.sent ? " / メール送信済" : ""}）`
        });
        return jsonResp({
          ok: true,
          record,
          activateUrl: `${baseAppUrl}${appSep}?key=${encodeURIComponent(record.key)}`,
          emailResult: mailRes
        }, 200, env, request);
      }

      const targetKey = normKey(body.key);
      const record = await getLicenseRecord(env, targetKey);
      if (!record) {
        return jsonResp({ ok: false, error: "Key not found", message: "対象のライセンスキーが見つかりません。" }, 404, env, request);
      }

      if (action === "get") {
        return jsonResp({ ok: true, record }, 200, env, request);
      }
      if (action === "revoke") {
        if (isAdminLicenseRecord(env, record)) {
          return jsonResp({ ok: false, error: "CannotRevokeAdmin", message: "管理者自身のライセンスキーは停止できません。" }, 400, env, request);
        }
        record.status = "inactive";
        record.revokedReason = "admin_revoked";
        await saveLicenseRecord(env, record);
        await appendAuditLog(env, {
          type: "admin_revoke",
          key: record.key,
          email: record.email,
          detail: "管理操作により利用停止"
        });
        return jsonResp({ ok: true, record }, 200, env, request);
      }
      if (action === "reactivate") {
        record.status = "active";
        record.revokedReason = null;
        await saveLicenseRecord(env, record);
        await appendAuditLog(env, {
          type: "admin_reactivate",
          key: record.key,
          email: record.email,
          detail: "管理操作により再有効化"
        });
        return jsonResp({ ok: true, record }, 200, env, request);
      }
      if (action === "reset_devices") {
        const keepSelf = authMode === "owner_key" && isAdminLicenseRecord(env, record) && authDeviceId;
        record.devices = keepSelf
          ? (record.devices || []).filter((d) => d.id === authDeviceId)
          : [];
        await saveLicenseRecord(env, record);
        await appendAuditLog(env, {
          type: "admin_reset_devices",
          key: record.key,
          email: record.email,
          detail: keepSelf ? "管理者キーの他端末枠をリセット（操作中端末は維持）" : "登録端末枠をすべてリセット"
        });
        return jsonResp({ ok: true, record, keptCurrentDevice: keepSelf }, 200, env, request);
      }
      if (action === "remove_device") {
        const targetDev = normDeviceId(body.targetDeviceId);
        if (!targetDev) {
          return jsonResp({ ok: false, message: "解除する端末IDが指定されていません。" }, 400, env, request);
        }
        if (authMode === "owner_key" && isAdminLicenseRecord(env, record) && targetDev === authDeviceId) {
          return jsonResp({ ok: false, message: "現在管理画面を開いている端末自身はここから解除できません。" }, 400, env, request);
        }
        const before = (record.devices || []).length;
        record.devices = (record.devices || []).filter((d) => d.id !== targetDev);
        await saveLicenseRecord(env, record);
        await appendAuditLog(env, {
          type: "admin_remove_device",
          key: record.key,
          email: record.email,
          detail: `端末1台を個別解除（${before}台 → ${record.devices.length}台）`
        });
        return jsonResp({ ok: true, record }, 200, env, request);
      }
      if (action === "update") {
        if (typeof body.customerName === "string") {
          record.customerName = body.customerName.trim().slice(0, 100);
        }
        if (typeof body.note === "string") {
          record.note = body.note.trim().slice(0, 100);
        }
        if (typeof body.email === "string") {
          record.email = body.email.trim().slice(0, 120);
        }
        if (body.maxDevices !== undefined) {
          const n = Number(body.maxDevices);
          if (Number.isFinite(n) && n >= 1 && n <= 50) {
            record.maxDevices = Math.floor(n);
          }
        }
        if (authMode === "secret" && typeof body.isAdmin === "boolean") {
          record.isAdmin = body.isAdmin;
        }
        await saveLicenseRecord(env, record);
        await appendAuditLog(env, {
          type: "admin_update",
          key: record.key,
          email: record.email,
          detail: `契約情報を更新（上限${record.maxDevices}台${record.customerName ? " / " + record.customerName : ""}${record.note ? " / " + record.note : ""}）`
        });
        return jsonResp({ ok: true, record }, 200, env, request);
      }
      if (action === "resend") {
        if (typeof body.email === "string" && body.email.trim()) {
          record.email = body.email.trim().slice(0, 120);
        }
        if (!record.email) {
          return jsonResp({ ok: false, message: "送信先のメールアドレスを入力してください。" }, 400, env, request);
        }
        const mailRes = await sendLicenseEmail(env, record);
        if (mailRes.sent) {
          record.emailSentAt = new Date().toISOString();
          await saveLicenseRecord(env, record);
        } else {
          await saveLicenseRecord(env, record);
        }
        await appendAuditLog(env, {
          type: "admin_resend",
          key: record.key,
          email: record.email,
          detail: mailRes.sent ? `ライセンス案内メールを再送（${record.email}）` : `メール再送失敗（${mailRes.reason || "error"}）`
        });
        return jsonResp({ ok: true, record, emailResult: mailRes }, 200, env, request);
      }
      if (action === "delete") {
        if (isAdminLicenseRecord(env, record)) {
          return jsonResp({ ok: false, error: "CannotDeleteAdmin", message: "管理者自身のライセンスキーは削除できません。" }, 400, env, request);
        }
        if (record.status === "active" && record.subscriptionId) {
          return jsonResp({
            ok: false,
            error: "CannotDeleteActiveStripe",
            message: "課金中のStripe定期契約キーは誤削除防止のため削除できません。先に利用停止またはStripe側での解約を行ってください。"
          }, 400, env, request);
        }
        await deleteLicenseRecord(env, record);
        await appendAuditLog(env, {
          type: "admin_delete",
          key: record.key,
          email: record.email,
          detail: "ライセンスレコードを削除"
        });
        return jsonResp({ ok: true, deletedKey: record.key }, 200, env, request);
      }

      return jsonResp({ ok: false, error: "Unknown action" }, 400, env, request);
    }

    return jsonResp({ ok: false, error: "Not found" }, 404, env, request);
  }
};
