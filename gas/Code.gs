/**
 * BAメーカー ライセンスキー自動送信リレー（Gmail ＋ Google Apps Script）
 * 送信元アカウント: seitaimichibiki@gmail.com（独自ドメイン不要・完全無料）
 *
 * 【設置手順（5分で完了）】
 * 1. seitaimichibiki@gmail.com でログインしたブラウザで https://script.google.com/ を開き「新しいプロジェクト」を作成
 * 2. このファイルの内容をすべて貼り付け、下の SECRET_TOKEN を任意の合言葉（例: 長めの英数字）に書き換えて保存（⌘+S）
 *    ※Cloudflare Worker 側の `npx wrangler secret put GAS_EMAIL_SECRET`（または ADMIN_SECRET）と同じ文字列にします
 * 3. 上部メニューで関数「testSendToSelf」を選んで「▶ 実行」を1回押し、権限承認画面で「許可」を押す
 *    （seitaimichibiki@gmail.com 宛にテストメールが1通届けばOK！）
 * 4. 右上の「デプロイ」→「新しいデプロイ」→ 種類の選択（歯車アイコン）で「ウェブアプリ」を選択
 *    - 次のユーザーとして実行: 「自分 (seitaimichibiki@gmail.com)」
 *    - アクセスできるユーザー: 「全員」
 * 5. 「デプロイ」を押して表示される「ウェブアプリのURL（https://script.google.com/macros/s/.../exec）」をコピーし、
 *    Worker側で `npx wrangler secret put GAS_WEBHOOK_URL` に貼り付ければ完了です！
 */

const SECRET_TOKEN = "CHANGE_ME_TO_YOUR_SECRET";
const DEFAULT_SENDER_NAME = "BAメーカー";
const DEFAULT_REPLY_TO = "seitaimichibiki@gmail.com";

function getConfiguredSecret_() {
  const prop = PropertiesService.getScriptProperties().getProperty("GAS_EMAIL_SECRET");
  return String(prop || SECRET_TOKEN || "").trim();
}

function jsonResponse_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return jsonResponse_({ ok: false, error: "empty_body" });
    }

    const data = JSON.parse(e.postData.contents);
    const expectedSecret = getConfiguredSecret_();
    if (!expectedSecret || expectedSecret === "CHANGE_ME_TO_YOUR_SECRET" || data.secret !== expectedSecret) {
      return jsonResponse_({ ok: false, error: "unauthorized" });
    }

    const to = String(data.to || "").trim();
    const subject = String(data.subject || "").trim();
    const text = String(data.text || "").trim();
    const html = String(data.html || "").trim();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      return jsonResponse_({ ok: false, error: "invalid_email" });
    }
    if (!subject || (!text && !html)) {
      return jsonResponse_({ ok: false, error: "missing_content" });
    }

    const options = {
      name: String(data.senderName || DEFAULT_SENDER_NAME).trim(),
      replyTo: String(data.replyTo || DEFAULT_REPLY_TO).trim()
    };
    if (html) {
      options.htmlBody = html;
    }

    GmailApp.sendEmail(to, subject, text || "HTMLメール対応のメールソフトでご確認ください。", options);

    return jsonResponse_({
      ok: true,
      provider: "gmail_gas",
      remainingDailyQuota: MailApp.getRemainingDailyQuota()
    });
  } catch (err) {
    return jsonResponse_({
      ok: false,
      error: String(err && err.message ? err.message : err)
    });
  }
}

/**
 * 初回のGmail送信権限承認＆動作テスト用関数
 * GASエディタ上部で「testSendToSelf」を選択して「▶ 実行」を押してください。
 */
function testSendToSelf() {
  GmailApp.sendEmail(
    DEFAULT_REPLY_TO,
    "【BAメーカー】Gmail自動送信テスト成功",
    "seitaimichibiki@gmail.com からのライセンス自動送信テストが正常に完了しました。",
    {
      name: DEFAULT_SENDER_NAME,
      replyTo: DEFAULT_REPLY_TO
    }
  );
  Logger.log("テストメールを送信しました: " + DEFAULT_REPLY_TO + " / 残り本日送信可能数: " + MailApp.getRemainingDailyQuota());
}
