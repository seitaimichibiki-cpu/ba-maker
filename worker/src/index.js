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

// ---------- KV ストレージ操作 ----------
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

async function issueOrGetLicense(env, { sessionId, customerId, subscriptionId, email, maxDevices }) {
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
    if (email && !existing.email) { existing.email = email; changed = true; }
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

async function sendLicenseEmail(env, record) {
  if (!record.email) return { sent: false, reason: "no_email" };
  const brand = env.BRAND_NAME || "BAメーカー";
  const baseAppUrl = String(env.APP_URL || "https://seitaimichibiki-cpu.github.io/ba-maker/").replace(/\?.*$/, "");
  const sep = baseAppUrl.endsWith("/") ? "" : "/";
  const activateUrl = `${baseAppUrl}${sep}?key=${encodeURIComponent(record.key)}`;
  const maxDev = getMaxDevices(env, record);
  const portalUrl = String(env.CUSTOMER_PORTAL_URL || "").trim();
  const supportEmail = String(env.SUPPORT_EMAIL || "seitaimichibiki@gmail.com").trim();

  const subject = `【${brand}】有料プランのライセンスキーをお届けします`;

  const textBody = [
    `${brand} 有料プランにお申し込みいただきありがとうございます。`,
    "",
    "以下の「ワンタップ有効化リンク」を開くだけで、すぐにご利用いただけます。",
    `▼ ワンタップで有料プランを有効化する`,
    activateUrl,
    "",
    "▼ ライセンスキー（手動入力・2台目の登録用）",
    record.key,
    "",
    "【ご利用ルール】",
    `・1契約につき最大 ${maxDev}台 の端末（例：院のiPad＋パソコン等）でご利用いただけます。`,
    "・機種変更や別の端末へ切り替える際は、画面右上の「プラン・端末管理」から「この端末のライセンスを解除する」を押すと枠が空きます。",
    "・サブスクリプションを解約された場合、契約期間終了後に自動的に無料プランへ戻ります。",
    portalUrl ? `\n▼ ご契約確認・カード変更・解約手続きはこちら\n${portalUrl}` : "",
    supportEmail ? `\nお問い合わせ：${supportEmail}` : "",
    "",
    `今後とも ${brand} をよろしくお願いいたします。`
  ].filter((line, idx, arr) => !(line === "" && arr[idx - 1] === "")).join("\n");

  const htmlBody = `
<div style="font-family:'Hiragino Sans','Noto Sans JP',Meiryo,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#1a1a1a;line-height:1.7">
  <h2 style="margin:0 0 16px;font-size:20px;color:#111">🎬 ${escapeHtml(brand)} 有料プランへようこそ</h2>
  <p style="margin:0 0 16px">有料プランにお申し込みいただきありがとうございます。<br>下のボタンを押すだけで、お使いの端末ですぐに<strong>有料プラン（透かしなし・1080×1920フルHD・ロゴ挿入・全テーマ）</strong>が有効になります。</p>
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
    <li>解約された場合は自動でライセンスが停止し、無料プランへ戻ります。</li>
  </ul>
  ${portalUrl ? `<p style="font-size:13px;color:#666;margin-top:20px">ご契約内容の確認・お支払い方法の変更・解約手続き：<br><a href="${escapeHtml(portalUrl)}" style="color:#ff5a5f">${escapeHtml(portalUrl)}</a></p>` : ""}
  ${supportEmail ? `<p style="font-size:12px;color:#888;margin-top:16px;border-top:1px solid #eee;padding-top:12px">お問い合わせ：<a href="mailto:${escapeHtml(supportEmail)}" style="color:#666">${escapeHtml(supportEmail)}</a></p>` : ""}
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
        senderName: brand,
        replyTo: supportEmail
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

  const fromEmail = env.FROM_EMAIL || `BAメーカー <${supportEmail}>`;

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
    key: record.key,
    maskedKey: maskKey(record.key),
    deviceCount: record.devices.length,
    maxDevices,
    cancelAtPeriodEnd: !!record.cancelAtPeriodEnd,
    currentPeriodEnd: record.currentPeriodEnd || null
  };
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
        const email = (obj.customer_details && obj.customer_details.email) || obj.customer_email || "";
        const record = await issueOrGetLicense(env, {
          sessionId: obj.id,
          customerId: obj.customer,
          subscriptionId: obj.subscription,
          email
        });
        if (!record.emailSentAt && record.email) {
          const mailRes = await sendLicenseEmail(env, record);
          if (mailRes.sent) {
            record.emailSentAt = new Date().toISOString();
            await saveLicenseRecord(env, record);
          }
        }
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
          } else {
            const mapped = mapStripeSubStatus(obj.status);
            const itemPeriodEnd = obj.items && obj.items.data && obj.items.data[0] && obj.items.data[0].current_period_end;
            record.status = mapped.status;
            record.revokedReason = mapped.reason;
            record.cancelAtPeriodEnd = !!obj.cancel_at_period_end;
            record.currentPeriodEnd = obj.current_period_end || itemPeriodEnd || null;
          }
          await saveLicenseRecord(env, record);
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
          record.status = "inactive";
          record.revokedReason = "payment_failed";
          await saveLicenseRecord(env, record);
        }
        return jsonResp({ ok: true, handled: type }, 200, env, request);
      }

      if (type === "invoice.paid" || type === "invoice.payment_succeeded") {
        const subId = obj.subscription || (obj.parent && obj.parent.subscription_details && obj.parent.subscription_details.subscription) || null;
        const record = await findRecordByStripeIds(env, {
          subscriptionId: subId,
          customerId: obj.customer
        });
        if (record && (!record.subscriptionId || !subId || record.subscriptionId === subId) && record.revokedReason === "payment_failed") {
          record.status = "active";
          record.revokedReason = null;
          await saveLicenseRecord(env, record);
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
          if (sess && (sess.payment_status === "paid" || sess.status === "complete")) {
            const email = (sess.customer_details && sess.customer_details.email) || sess.customer_email || "";
            record = await issueOrGetLicense(env, {
              sessionId: sess.id,
              customerId: sess.customer,
              subscriptionId: sess.subscription,
              email
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

    // 5. 管理者用API（手動発行・強制停止・端末枠リセット・状態確認）
    if (request.method === "POST" && path === "/api/admin") {
      const auth = request.headers.get("Authorization") || "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
      if (!env.ADMIN_SECRET || token !== env.ADMIN_SECRET) {
        return jsonResp({ ok: false, error: "Unauthorized" }, 401, env, request);
      }

      const action = body.action;
      if (action === "issue") {
        const key = generateLicenseKey();
        const now = new Date().toISOString();
        const record = {
          key,
          email: String(body.email || "").trim(),
          customerId: null,
          subscriptionId: null,
          checkoutSessionId: null,
          status: "active",
          revokedReason: null,
          cancelAtPeriodEnd: false,
          currentPeriodEnd: null,
          maxDevices: Number(body.maxDevices) || getMaxDevices(env, null),
          devices: [],
          emailSentAt: null,
          note: String(body.note || "").slice(0, 100),
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
        return jsonResp({ ok: true, record, emailResult: mailRes }, 200, env, request);
      }

      const targetKey = normKey(body.key);
      const record = await getLicenseRecord(env, targetKey);
      if (!record) {
        return jsonResp({ ok: false, error: "Key not found" }, 404, env, request);
      }

      if (action === "get") {
        return jsonResp({ ok: true, record }, 200, env, request);
      }
      if (action === "revoke") {
        record.status = "inactive";
        record.revokedReason = "admin_revoked";
        await saveLicenseRecord(env, record);
        return jsonResp({ ok: true, record }, 200, env, request);
      }
      if (action === "reactivate") {
        record.status = "active";
        record.revokedReason = null;
        await saveLicenseRecord(env, record);
        return jsonResp({ ok: true, record }, 200, env, request);
      }
      if (action === "reset_devices") {
        record.devices = [];
        await saveLicenseRecord(env, record);
        return jsonResp({ ok: true, record }, 200, env, request);
      }
      if (action === "resend") {
        if (body.email) record.email = String(body.email).trim();
        const mailRes = await sendLicenseEmail(env, record);
        if (mailRes.sent) {
          record.emailSentAt = new Date().toISOString();
          await saveLicenseRecord(env, record);
        }
        return jsonResp({ ok: true, record, emailResult: mailRes }, 200, env, request);
      }

      return jsonResp({ ok: false, error: "Unknown action" }, 400, env, request);
    }

    return jsonResp({ ok: false, error: "Not found" }, 404, env, request);
  }
};
