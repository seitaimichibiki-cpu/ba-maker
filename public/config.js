/**
 * BAメーカー 設定ファイル
 * ここを書き換えるだけで、価格・購入リンク・ライセンスを変更できます。
 */
window.BAM_CONFIG = {
  BRAND: "BAメーカー",

  // 無料版の透かし文字（書き出し画像・動画の最下部に小さく入る）
  WATERMARK_TEXT: "BAメーカー 無料版",

  // 有料プラン表示用（※価格は提案値。Stripe側の設定と必ず一致させること）
  PRO_PRICE_LABEL: "月額 480円（税込）",
  PRO_PRICE_NOTE: "いつでも解約OK",

  // Stripe Payment Link など購入ページのURL（未設定なら購入ボタンは案内表示になる）
  // 例: "https://buy.stripe.com/xxxxxxxx"
  PAYMENT_URL: "",

  // 無料 / 有料 の制限
  LIMITS: {
    free: { width: 720,  height: 1280, maxSeconds: 30 },
    pro:  { width: 1080, height: 1920, maxSeconds: 90 }
  },

  // 有効なライセンスキーの SHA-256 ハッシュ一覧
  // 生成方法: `node tools/make_license.js 3` （README参照）
  LICENSE_HASHES: [
    "de4fef8b2dae2473927c217f3fd1bc90c8f07e5b3f47a5d08d3483346fb23fe9", // テスト用 BAM-NAVQ…
    "5d50a0c9cd29e1ff3e14ecc166b0a4865acf704a36100bd99eb408d8f674ad5e", // テスト用 BAM-NVGD…
    "95772aeb22845b82f63e70d92d057844f26835dce586eaab4bca65c4cf7f2e32"  // テスト用 BAM-LR5C…
  ]
};
