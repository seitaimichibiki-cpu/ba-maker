# BAメーカー（ビフォーアフター リール動画メーカー）

整体院・治療院向けに、ビフォーアフターの画像・動画を **Instagramリールサイズ（9:16）** に合わせてブラウザだけで編集できるツールです。

- **公開URL**：`https://seitaimichibiki-cpu.github.io/ba-maker/`
- **動画・画像のプライバシー**：メディア処理はすべて**端末のブラウザ内のみ**で完結し、サーバーへ送信されません。

---

## 無料プランと有料プランの分断仕様

| 項目 | 無料プラン | ⭐ 有料プラン（月額 480円・税込） |
|---|---|---|
| **書き出し画質** | `720×1280` | **`1080×1920`（フルHD）** |
| **動画の長さ** | 最大 30秒 | **最大 90秒** |
| **院名下の透かし** | あり（`BAメーカー 無料版`） | **なし** |
| **カラーテーマ** | 2種（ダーク／ホワイト） | **全5種＋自由配色** |
| **院のロゴ挿入** | — | **○** |
| **同時利用端末数** | — | **1契約につき最大 2台まで** |
| **ライセンス付与** | — | **決済直後に自動有効化＋自動メール送信** |
| **解約・未払い時** | — | **自動でライセンス停止→無料プランへ切り戻し** |

---

## 有料プラン自動運用（Stripe ＋ Cloudflare Workers ＋ 独自ドメインメール）セットアップ手順

### ステップ1：独自ドメインメールAPI（Resend）の準備

1. [Resend](https://resend.com/)（月3,000通まで無料）でアカウントを作成します。
2. **Domains** からお使いの独自ドメインを追加し、表示されるDNSレコード（SPF / DKIM）をドメイン管理画面に設定して認証（Verified）します。
3. **API Keys** からAPIキー（`re_...`）を発行して控えます。

---

### ステップ2：Cloudflare Workers ＋ KV のデプロイ

`worker/` ディレクトリで以下のコマンドを順番に実行します（Cloudflare無料枠で運用可能）。

```bash
cd worker

# 1. Cloudflareにログイン（初回のみ）
npx wrangler login

# 2. ライセンス保存用のKVネームスペースを作成
npx wrangler kv namespace create LICENSES
```

表示された `id = "xxxxxxxxxxxxxxxx"` を **`worker/wrangler.toml` の `[[kv_namespaces]]` の `id` に貼り付け**、あわせて `FROM_EMAIL` を独自ドメインの送信元アドレス（例：`BAメーカー <noreply@あなたのドメイン>`）に書き換えます。

次に、機密キーを Cloudflare Secret として安全に登録してデプロイします。

```bash
# ResendのAPIキー
npx wrangler secret put RESEND_API_KEY

# Stripeのシークレットキー（sk_live_... または sk_test_...）
# ※設定すると、決済完了後の画面リダイレクト時にWebhookを待たず0秒で即時有効化できます
npx wrangler secret put STRIPE_SECRET_KEY

# 管理者CLI用の任意のパスワード文字列（長めのランダム文字列）
npx wrangler secret put ADMIN_SECRET

# デプロイ実行
npx wrangler deploy
```

デプロイ完了後に表示される Worker URL（例：`https://ba-maker-license.<サブドメイン>.workers.dev`）を控えます。

---

### ステップ3：Stripe（決済リンク・Webhook・解約ポータル）の設定

1. **商品と Payment Link の作成**
   - Stripeダッシュボードで **月額 480円（税込・定期課金）** の商品を作成し、**Payment Link** を発行します。
   - Payment Link の「支払い完了後の動作」で **「顧客を自分のウェブサイトにリダイレクトする」** を選び、以下のURLを設定します（決済直後にキー入力不要で自動有効化されます）：
     ```text
     https://seitaimichibiki-cpu.github.io/ba-maker/?session_id={CHECKOUT_SESSION_ID}
     ```

2. **Stripe カスタマーポータル（解約・カード変更ページ）の有効化**
   - Stripeダッシュボード「設定 → 請求 → カスタマーポータル」で **リンクを有効化** し、ポータルURL（`https://billing.stripe.com/p/login/...`）を控えます。
   - `worker/wrangler.toml` の `CUSTOMER_PORTAL_URL` にも設定して `npx wrangler deploy` しておくと、自動送信メール内にも解約・契約確認リンクが記載されます。

3. **Stripe Webhook の登録（自動メール送信＆解約・未払い自動遮断）**
   - Stripeダッシュボード「開発者 → Webhook → エンドポイントを追加」を開きます。
   - **エンドポイントURL**：
     ```text
     https://ba-maker-license.<サブドメイン>.workers.dev/webhook/stripe
     ```
   - **リッスンするイベント（以下5つを選択）**：
     - `checkout.session.completed`（決済完了 → キー自動発行＆メール自動送信）
     - `customer.subscription.updated`（解約予約・ステータス変更の同期）
     - `customer.subscription.deleted`（解約完了 → ライセンス自動停止・無料プランへ切り戻し）
     - `invoice.payment_failed`（カード決済失敗 → ライセンス一時停止）
     - `invoice.paid`（支払い再開 → ライセンス自動復旧）
   - 作成後に表示される **署名シークレット（`whsec_...`）** を Worker に登録します：
     ```bash
     cd worker
     npx wrangler secret put STRIPE_WEBHOOK_SECRET
     ```

---

### ステップ4：`public/config.js` に3つのURLを設定してGitHubへ反映

`public/config.js` に控えた3つのURLを入力し、`main` ブランチへ `git push` すると自動公開されます。

```js
PAYMENT_URL: "https://buy.stripe.com/xxxxxxxx",
LICENSE_API_URL: "https://ba-maker-license.<サブドメイン>.workers.dev",
CUSTOMER_PORTAL_URL: "https://billing.stripe.com/p/login/xxxxxxxx",
```

---

## 管理者用コマンド（手動発行・2台枠リセット・強制停止）

機種変更時に古い端末が手元になく「2台枠」をリセットしたい場合や、個別キーを手動発行したい場合は `tools/admin_license.js` で管理できます。

```bash
export WORKER_URL="https://ba-maker-license.<サブドメイン>.workers.dev"
export ADMIN_SECRET="<設定したADMIN_SECRET>"

# キーの手動発行（メールアドレスを指定すると自動メールも送信）
node tools/admin_license.js issue clinic@example.com "モニター院様"

# キーの有効状態・登録端末（最大2台）の確認
node tools/admin_license.js get BAM-XXXX-XXXX-XXXX

# 登録端末（2台枠）のリセット（端末紛失・機種変更サポート用）
node tools/admin_license.js reset-devices BAM-XXXX-XXXX-XXXX

# キーの強制停止 ／ 再有効化
node tools/admin_license.js revoke BAM-XXXX-XXXX-XXXX
node tools/admin_license.js reactivate BAM-XXXX-XXXX-XXXX
```

---

## ローカル動作確認

```bash
cd public && python3 -m http.server 8000
# ブラウザで http://localhost:8000 を開く
```

## ファイル構成

- `public/` … 公開サイト本体（`index.html` / `style.css` / `app.js` / `bgm.js` / `motion.js` / `config.js`）
- `worker/` … 自動ライセンス発行・メール送信・2台制限・解約自動遮断サーバー（Cloudflare Workers + KV）
- `tools/admin_license.js` … 管理者向けライセンス操作CLI
- `tools/make_license.js` … オフライン検証用の静的ハッシュ生成ツール（サーバー未使用時のみ）
