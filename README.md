# BAメーカー（ビフォーアフター リール動画メーカー）

整体院・治療院向け。ビフォーアフターの画像／動画を **Instagramリール（9:16）** に合わせて編集します。

## レイアウト
- **上部**：症状・年齢（属性）
- **中央**：左＝BEFORE ／ 右＝AFTER（画像・動画どちらも可）
- **下部**：院名（有料プランはロゴ併記可）

## 使い方（ローカル確認）
```bash
cd public && python3 -m http.server 8000
# ブラウザで http://localhost:8000 を開く
```
サーバー処理は一切なし（静的ファイルのみ）。公開は Cloudflare Pages / Netlify / GitHub Pages / Vercel などに
このフォルダをそのまま置くだけで、**運用コストほぼ0円**で全員に無料公開できます。

## プラン
| | 無料 | 有料（提案：月額480円） |
|---|---|---|
| 画質 | 720×1280 | 1080×1920 |
| 動画の長さ | 30秒 | 90秒 |
| 透かし | あり | なし |
| テーマ | 2種 | 5種＋自由配色 |
| ロゴ挿入 | — | ○ |

価格・制限は [public/config.js](public/config.js) で変更できます。

## 有料プランの運用手順
1. Stripe で商品（月額サブスク）を作り、**Payment Link** を発行
2. `public/config.js` の `PAYMENT_URL` にそのURLを設定
3. 購入通知を受けたら、ライセンスキーを発行して購入者へメール送付
   ```bash
   node tools/make_license.js 1
   ```
   表示された **ハッシュ行を `public/config.js` の `LICENSE_HASHES` に追加** → 再デプロイ
4. 購入者は画面右上「有料プラン」→ キー入力で有効化

> [!NOTE]
> `public/config.js` 内のテスト用3キーは本番公開前に削除してください（キーは `licenses_issued.txt` に記録）。
> `licenses_issued.txt` は公開フォルダに置かないでください（`.gitignore` 済み）。

### 現状の制限（正直な注意点）
- ライセンス判定は**ブラウザ内のみ**で、サーバー認証ではありません。
  格安プラン向けの簡易方式で、詳しい人は回避できます。
- キー発行は**手動**です。購入者が増えたら、Stripe Webhook ＋ Cloudflare Workers 等で
  「決済→キー自動発行→解約で失効」を自動化するのがおすすめです。

## 動画書き出しについて
- ブラウザ内で録画方式（MediaRecorder）で書き出します。**書き出し中は元動画の長さ分の時間がかかり、タブを切り替えると止まります。**
- MP4対応ブラウザ（最近のChrome / Edge / Safari）ではMP4、非対応ならWebMで保存されます。
- WebMしか出ない場合のMP4変換例（ffmpeg）：
  ```bash
  ffmpeg -i before-after.webm -c:v libx264 -pix_fmt yuv420p -c:a aac before-after.mp4
  ```

## ファイル構成
- `public/` … 公開されるサイト本体（index.html / style.css / app.js / config.js）
- `tools/make_license.js` … ライセンスキー発行
