#!/usr/bin/env node
/**
 * ライセンスキー発行ツール
 *   使い方: node tools/make_license.js 5     （5個発行）
 *
 * - キーは licenses_issued.txt に追記（※このファイルは公開しないこと）
 * - public/config.js の LICENSE_HASHES に貼る行を標準出力に表示
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const n = parseInt(process.argv[2] || "1", 10);
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 紛らわしい文字(0,O,1,I)を除外
const seg = () => Array.from(crypto.randomBytes(4), b => ALPHABET[b % ALPHABET.length]).join("");

const lines = [];
const hashes = [];
for (let i = 0; i < n; i++) {
  const key = `BAM-${seg()}-${seg()}-${seg()}`;
  const hash = crypto.createHash("sha256").update(key).digest("hex");
  lines.push(key);
  hashes.push(`    "${hash}", // ${key.slice(0, 8)}…`);
}
fs.appendFileSync(path.join(__dirname, "..", "licenses_issued.txt"),
  lines.map(k => `${new Date().toISOString()}  ${k}`).join("\n") + "\n");

console.log("▼ 発行したキー（購入者へ送付）");
lines.forEach(k => console.log("  " + k));
console.log("\n▼ public/config.js の LICENSE_HASHES に追加");
hashes.forEach(h => console.log(h));
