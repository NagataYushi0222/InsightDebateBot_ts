# InsightDebate Bot

Discord上のボイスチャットを自動録音・分析し、議論の要約や対立構造を可視化するAI Botです。

## 特徴
- 📹 **ユーザーごとの音声録音**: 各参加者の発言を個別に記録
- 🤖 **Gemini AIによる分析**: Google Gemini API (Gemini 2.5 Flash / 3 Flash) で音声を分析
- 🔍 **ファクトチェック**: Google検索機能 (Dynamic Retrieval) で発言内容の正確性を確認
- 📊 **2つのモード**: 「議論分析」と「会議要約」を選択可能
- ☁️ **軽量設計**: OCI E2.1 Microなどの低スペック環境でも動作可能（ストリーム録音対応）

## 必要条件
- Node.js v18以上
- FFmpeg (`apt-get install ffmpeg` 等でインストール済みであること)

## クイックスタート (CLI / サーバー)

### 1. 準備
リポジトリをクローンし、依存関係をインストールします。

```bash
git clone https://github.com/NagataYushi0222/InsightDebateBot.git
cd InsightDebateBot
npm install
```

### 2. 設定
`.env` ファイルを作成し、Discord Botのトークンを設定します。

```bash
cp env.template .env
nano .env
```

`.env` の内容:
```
DISCORD_TOKEN=your_discord_bot_token_here
GEMINI_API_KEY=your_gemini_api_key_here (任意: Bot起動後にコマンドでも設定可能)
```

### 3. ビルドと起動

```bash
npm run build
npm start
```

## コマンド一覧

### 分析コマンド
- `/analyze_start`: ボイスチャットの録音・分析を開始します。
- `/analyze_stop`: 分析を終了し、レポートを作成して退出します。
- `/analyze_now`: 現在までの会話を強制的に分析・要約します（定期分析のタイマーはリセットされません）。

### 設定コマンド
- `/settings set_key <key>`: Gemini APIキーを設定します（ユーザーごとに設定可能）。
- `/settings set_mode <debate|summary>`: 分析モードを変更します。
  - `debate`: 議論の対立構造やファクトチェックを行います。
  - `summary`: 会議の議事録・要約を作成します。
- `/settings set_interval <秒>`: 定期分析の間隔を変更します（デフォルト300秒）。
- `/settings set_model <model>`: 使用するGeminiモデルを変更します。
  - `gemini-2.5-flash`: 高速・安定
  - `gemini-3-flash-preview`: 高性能

## トラブルシューティング
- **429 Quota Exceeded**: Google Gemini APIの制限です。自動的に検索機能をオフにしてリトライしますが、頻発する場合は `/settings set_model` でモデルを変更してください。

## ライセンス
MIT License
