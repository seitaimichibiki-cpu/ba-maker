# BAメーカー（ビフォーアフター動画メーカー）

整体院・治療院向けに、ビフォーアフターの画像・動画を **リール（9:16）・フィード投稿（4:5）・正方形（1:1）** に合わせてブラウザだけで編集できるツールです。

- **公開URL**：`https://seitaimichibiki-cpu.github.io/ba-maker/`
- **動画・画像のプライバシー**：メディア処理はすべて**端末のブラウザ内のみ**で完結し、サーバーへ送信されません。

---

## 無料プランと有料プランの分断仕様

| 項目 | 無料プラン | ⭐ 有料プラン（月額 480円・税込） |
|---|---|---|
| **動き始め自動同期・自動BGM・SNS投稿** | ○ | **○** |
| **書き出し画質** | `720p` 標準 | **`1080p`（フルHD高画質）** |
| **出力サイズ切替** | `9:16`（縦長リール）のみ | **`9:16` ／ `4:5`（投稿） ／ `1:1`（正方形・HP・LINE）** |
| **比較レイアウト** | 左右2分割のみ | **左右2分割 ／ 上下2分割 ／ スライド比較（ワイプ演出）** |
| **😶 顔ぼかし** | —（※プレビュー体験可） | **○（AI自動追従＋横顔/後頭部自動追尾＋手動調整）** |
| **📏 姿勢基準線・注目スタンプ** | —（※プレビュー体験可） | **○（方眼グリッド・中心線・肩/骨盤ライン・赤丸・矢印）** |
| **🎬 ラスト2秒の予約・LINE誘導カット** | —（※プレビュー体験可） | **○（地域名・初回オファー・誘導CTAを動画末尾に自動合成）** |
| **免責テロップ・症状別テンプレ・SNS固定フッター** | —（※プレビュー体験可） | **○（ワンタップ免責・最大12件プリセット・署名/ハッシュタグ固定）** |
| **動画の長さ ／ 院名下の透かし** | 最大 30秒 ／ あり（`BAメーカー 無料版`） | **最大 90秒 ／ なし** |
| **カラーテーマ・院ロゴ挿入** | 2種（ダーク／ホワイト） | **全5種＋自由配色 ＋ 院ロゴ挿入** |
| **同時利用端末数** | — | **1契約につき最大 2台まで** |
| **ライセンス付与 ／ 解約・未払い時** | — | **決済直後に自動有効化＋自動メール送信 ／ 解約時は自動切り戻し** |

---

## 有料プラン自動運用（独自ドメイン不要・維持費0円：Gmail ＋ GAS ＋ Cloudflare Workers ＋ Stripe）セットアップ手順

独自ドメインや有料メール配信サービスは不要です。**`seitaimichibiki@gmail.com` ＋ Google Apps Script（無料）** を使ってライセンスキー＆ワンタップ有効化リンクを自動送信し、さらに決済直後の画面でもキーの即時有効化・2台目用ワンタップコピーができます。

---

### ステップ1：Gmail（`seitaimichibiki@gmail.com`）自動送信スクリプトの設置（約3分）

1. **`seitaimichibiki@gmail.com`** でログインしたブラウザで [Google Apps Script](https://script.google.com/) を開き、**「新しいプロジェクト」** を作成します。
2. エディタに最初から入っているコードを消し、このリポジトリの **`gas/Code.gs`** の中身をすべて貼り付けます。
3. 18行目の `SECRET_TOKEN` を任意の長い合言葉（ランダムな英数字）に書き換えて保存（`⌘+S`）します。
   ```js
   const SECRET_TOKEN = "ここに任意の長い合言葉を設定";
   ```
4. エディタ上部の関数選択プルダウンで **`testSendToSelf`** を選び、**「▶ 実行」** を1回押します。
   - 初回のみ権限確認画面が出るので **「権限を確認」→ `seitaimichibiki@gmail.com` を選択 →「詳細」→「（プロジェクト名）に移動」→「許可」** を押します。
   - `seitaimichibiki@gmail.com` の受信トレイに「【BAメーカー】Gmail自動送信テスト成功」が1通届けば準備完了です。
5. 右上の **「デプロイ」→「新しいデプロイ」** を開き、種類の選択（歯車アイコン）で **「ウェブアプリ」** を選びます：
   - **次のユーザーとして実行**：`自分 (seitaimichibiki@gmail.com)`
   - **アクセスできるユーザー**：`全員`
6. **「デプロイ」** を押して表示される **ウェブアプリのURL（`https://script.google.com/macros/s/....../exec`）** をコピーして控えます。

---

### ステップ2：Cloudflare Workers ＋ KV のデプロイ（無料枠）

`worker/` ディレクトリで以下のコマンドを順番に実行します。

```bash
cd worker

# 1. Cloudflareにログイン（初回のみ）
npx wrangler login

# 2. ライセンス保存用のKVネームスペースを作成
npx wrangler kv namespace create LICENSES
```

表示された `id = "xxxxxxxxxxxxxxxx"` を **`worker/wrangler.toml` の `[[kv_namespaces]]` の `id` に貼り付け**ます（自動送信元は `seitaimichibiki@gmail.com`、お問い合わせ窓口はBtoB公式LINE `https://lin.ee/XB6R3kS` に設定済みです）。

次に、機密情報を Cloudflare Secret として安全に登録してデプロイします。

```bash
# ステップ1でコピーした GAS ウェブアプリのURL（https://script.google.com/macros/s/.../exec）
npx wrangler secret put GAS_WEBHOOK_URL

# ステップ1で gas/Code.gs の SECRET_TOKEN に設定した合言葉と「同じ文字列」
npx wrangler secret put GAS_EMAIL_SECRET

# Stripeのシークレットキー（sk_live_... または sk_test_...）
# ※設定すると、決済完了後の画面リダイレクト時にWebhookを待たず0秒で即時有効化できます
npx wrangler secret put STRIPE_SECRET_KEY

# 管理者CLI用の任意のパスワード文字列（長めのランダム文字列）
npx wrangler secret put ADMIN_SECRET

# デプロイ実行
npx wrangler deploy
```

デプロイ完了後に表示される Worker URL（例：`https://ba-maker-license.seitaimichibiki.workers.dev`）を控えます。

---

### ステップ3：Stripe（決済リンク・Webhook・解約ポータル）の設定

1. **商品と Payment Link の作成**
   - Stripeダッシュボードで **月額 480円（税込・定期課金）** の商品を作成し、**Payment Link** を発行します。
   - Payment Link の「支払い完了後の動作」で **「顧客を自分のウェブサイトにリダイレクトする」** を選び、以下のURLを設定します（決済直後にキー入力不要で1台目が自動有効化され、画面内から2台目用のキーもワンタップコピーできます）：
     ```text
     https://seitaimichibiki-cpu.github.io/ba-maker/?session_id={CHECKOUT_SESSION_ID}
     ```

2. **Stripe カスタマーポータル（解約ページ）の有効化**
   - Stripeダッシュボード「設定 → 請求 → カスタマーポータル」で **リンクを有効化** し、ポータルURL（`https://billing.stripe.com/p/login/...`）を控えます（※このURLは `public/config.js` の `CUSTOMER_PORTAL_URL` に設定され、`help.html` 内の複数ステップ解約フロー完了後にのみ表示されます）。

3. **Stripe Webhook の登録（自動メール送信＆解約・未払い自動遮断）**
   - Stripeダッシュボード「開発者 → Webhook → エンドポイントを追加」を開きます。
   - **エンドポイントURL**：
     ```text
     https://ba-maker-license.seitaimichibiki.workers.dev/webhook/stripe
     ```
   - **リッスンするイベント（以下5つを選択）**：
     - `checkout.session.completed`（決済完了 → キー自動発行＆`seitaimichibiki@gmail.com` から自動メール送信）
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
LICENSE_API_URL: "https://ba-maker-license.seitaimichibiki.workers.dev",
CUSTOMER_PORTAL_URL: "https://billing.stripe.com/p/login/xxxxxxxx",
```

---

## 管理者用コマンド（手動発行・メール再送・2台枠リセット・強制停止）

機種変更時に古い端末が手元になく「2台枠」をリセットしたい場合や、メールアドレス入力ミスの方へ再送したい場合は `tools/admin_license.js` で管理できます。

```bash
export WORKER_URL="https://ba-maker-license.seitaimichibiki.workers.dev"
export ADMIN_SECRET="<設定したADMIN_SECRET>"

# キーの手動発行（メールアドレスを指定すると seitaimichibiki@gmail.com から自動メールも送信）
node tools/admin_license.js issue clinic@example.com "モニター院様"

# キーの有効状態・登録端末（最大2台）の確認
node tools/admin_license.js get BAM-XXXX-XXXX-XXXX

# ライセンスメールの再送（第2引数に新しいアドレスを指定すると宛先修正して再送可能）
node tools/admin_license.js resend BAM-XXXX-XXXX-XXXX corrected@example.com

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

- `public/` … 公開サイト本体（`index.html` / `style.css` / `app.js` / `face.js` / `bgm.js` / `motion.js` / `config.js` / `ogp.png` / `admin.html` / `admin.js` / `help.html` / `help.js` / `privacy.html` / `terms.html` / `tokushoho.html`）
- `gas/Code.gs` … 独自ドメイン不要の自動メール送信リレー（`seitaimichibiki@gmail.com` ＋ Google Apps Script 用）
- `worker/` … 自動ライセンス発行・メール送信・2台制限・解約自動遮断サーバー（Cloudflare Workers + KV）
- `tools/admin_license.js` … 管理者向けライセンス操作CLI（発行・再送・端末枠リセット・停止）
- `tools/make_license.js` … オフライン検証用の静的ハッシュ生成ツール（サーバー未使用時のみ）
