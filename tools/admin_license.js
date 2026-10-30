#!/usr/bin/env node
/**
 * BAメーカー ライセンス管理CLI（Cloudflare Worker 管理API呼び出し用）
 *
 * 事前設定（環境変数）:
 *   export WORKER_URL="https://ba-maker-license.<あなたのサブドメイン>.workers.dev"
 *   export ADMIN_SECRET="<wrangler secret put ADMIN_SECRET で設定した文字列>"
 *
 * 使い方:
 *   node tools/admin_license.js issue [メール] [メモ]   # 手動キー発行（メール指定時は自動メール送信も実行）
 *   node tools/admin_license.js get BAM-XXXX-XXXX-XXXX
 *   node tools/admin_license.js reset-devices BAM-XXXX-XXXX-XXXX
 *   node tools/admin_license.js revoke BAM-XXXX-XXXX-XXXX
 *   node tools/admin_license.js reactivate BAM-XXXX-XXXX-XXXX
 */

const workerUrl = String(process.env.WORKER_URL || "").trim().replace(/\/+$/, "");
const adminSecret = String(process.env.ADMIN_SECRET || "").trim();

const [, , rawCmd, arg1, arg2] = process.argv;

function usage() {
  console.log([
    "使い方:",
    "  WORKER_URL=https://... ADMIN_SECRET=... node tools/admin_license.js <コマンド> [引数]",
    "",
    "コマンド一覧:",
    "  issue [email] [note]      手動でライセンスキーを発行（email指定時は自動メール送信）",
    "  get <KEY>                 キーの状態・登録端末（最大2台）を確認",
    "  reset-devices <KEY>       登録端末（2台枠）をすべてリセット（機種変更・紛失対応）",
    "  revoke <KEY>              キーを即時無効化（無料プランへ強制切り戻し）",
    "  reactivate <KEY>          無効化したキーを再度有効化"
  ].join("\n"));
}

if (!rawCmd || rawCmd === "-h" || rawCmd === "--help") {
  usage();
  process.exit(0);
}

if (!workerUrl || !adminSecret) {
  console.error("エラー: 環境変数 WORKER_URL と ADMIN_SECRET を設定してください。\n");
  usage();
  process.exit(1);
}

const cmdMap = {
  "issue": "issue",
  "get": "get",
  "revoke": "revoke",
  "reactivate": "reactivate",
  "reset-devices": "reset_devices",
  "reset_devices": "reset_devices"
};

const action = cmdMap[rawCmd];
if (!action) {
  console.error(`エラー: 不明なコマンドです: ${rawCmd}\n`);
  usage();
  process.exit(1);
}

async function main() {
  let payload;
  if (action === "issue") {
    payload = {
      action: "issue",
      email: arg1 || "",
      note: arg2 || ""
    };
  } else {
    if (!arg1) {
      console.error("エラー: ライセンスキー（BAM-XXXX-XXXX-XXXX）を指定してください。");
      process.exit(1);
    }
    payload = { action, key: arg1 };
  }

  const res = await fetch(`${workerUrl}/api/admin`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${adminSecret}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }

  if (!res.ok) {
    console.error(`APIエラー (${res.status}):`, data);
    process.exit(1);
  }

  console.log(JSON.stringify(data, null, 2));
}

main().catch((err) => {
  console.error("通信エラー:", err.message || err);
  process.exit(1);
});
