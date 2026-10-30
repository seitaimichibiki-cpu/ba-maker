/**
 * BAメーカー 設定ファイル
 * ここを書き換えるだけで、価格・購入リンク・ライセンスを変更できます。
 */
window.BAM_CONFIG = {
  BRAND: "BAメーカー",

  // 無料版の透かし文字（院名の下に表示）
  WATERMARK_TEXT: "BAメーカー 無料版",

  // 有料プラン表示用（※Stripe側の設定価格と一致させること）
  PRO_PRICE_LABEL: "月額 480円（税込）",
  PRO_PRICE_NOTE: "いつでも解約OK ／ 1契約で最大2台の端末で利用可能",

  // 1. Stripe Payment Link（購入ページ）のURL
  //    Stripe側の「支払い完了後のリダイレクト先」に以下を設定すると決済直後にその場で自動有効化されます：
  //    https://seitaimichibiki-cpu.github.io/ba-maker/?session_id={CHECKOUT_SESSION_ID}
  //    例: "https://buy.stripe.com/xxxxxxxx"
  PAYMENT_URL: "",

  // 2. ライセンス自動認証・2台制限・解約自動遮断サーバー（Cloudflare Worker）のURL
  //    例: "https://ba-maker-license.your-subdomain.workers.dev"
  LICENSE_API_URL: "",

  // 3. Stripe カスタマーポータル（契約確認・カード変更・解約手続きページ）のURL
  //    例: "https://billing.stripe.com/p/login/xxxxxxxx"
  CUSTOMER_PORTAL_URL: "",

  // サポート・お問い合わせ先メールアドレス（Gmail＋GAS自動送信元と共通）
  SUPPORT_EMAIL: "seitaimichibiki@gmail.com",

  // 1ライセンスあたりの同時利用端末上限（Worker側の MAX_DEVICES と揃える）
  MAX_DEVICES: 2,

  // 無料 / 有料 の制限
  LIMITS: {
    free: { width: 720,  height: 1280, maxSeconds: 30 },
    pro:  { width: 1080, height: 1920, maxSeconds: 90 }
  },

  // オフライン検証用フォールバック（LICENSE_API_URL 未設定時のみ使用。本番の自動運用では空配列のままにします）
  LICENSE_HASHES: []
};
