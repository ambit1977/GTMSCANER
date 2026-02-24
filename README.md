# GTM Scanner（Chrome 拡張機能）

現在開いているウェブサイトに読み込まれている **Google Tag Manager（GTM）** のコンテナを解析し、次の概要をレポートします。

- **タグ** … 種類と名前
- **トリガー（述語）** … 種類
- **変数（マクロ）** … 種類と名前

## 使い方

1. Chrome で `chrome://extensions/` を開く
2. 「デベロッパーモード」をオンにする
3. 「パッケージ化されていない拡張機能を読み込む」でこのフォルダ（`GTMSCANER`）を選択
4. GTM が読み込まれているサイトを開き、ツールバーの拡張アイコンをクリック
5. 「このページをスキャン」をクリック

スキャン結果がポップアップ内に表示されます。

## ファイル構成

| ファイル | 説明 |
|---------|------|
| `manifest.json` | 拡張機能の設定（Manifest V3） |
| `popup.html` / `popup.js` | ポップアップUIとスキャン処理 |
| `gtm-parser.js` | gtm.js のソースから `resource`（タグ・トリガー・変数）を抽出するパーサー |

## 動作の流れ

1. 現在のタブのページ内の `<script src="...gtm.js?id=GTM-XXXXX">` および `<noscript>` 内の iframe からコンテナIDを検出
2. 各コンテナIDに対して `https://www.googletagmanager.com/gtm.js?id=GTM-XXXXX` を取得
3. gtm.js 内の `resource` オブジェクト（tags / predicates / macros）を解析
4. タグ・トリガー・変数の一覧をポップアップに表示

## 注意

- GTM が埋め込まれていないページでは「このページでは GTM コンテナが検出されませんでした」と表示されます。
- gtm.js の形式は Google の仕様に依存するため、将来の変更でパーサーの調整が必要になる場合があります。
