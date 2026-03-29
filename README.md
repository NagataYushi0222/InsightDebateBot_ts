# InsightDebate Bot (TypeScript)

Discord のボイスチャットを録音し、Gemini で定期分析や最終レポートを作成する Bot です。議論の要点整理、対立構造の可視化、会議要約に使えます。

## 特徴

- ユーザーごとに音声を個別録音
- 定期レポート、手動レポート、最終レポートに対応
- Gemini による議論分析 / 会議要約
- Google Search Grounding を使ったファクトチェック対応
- 軽量構成で Linux サーバーや OCI でも運用しやすい
- Slash Command で操作可能

## 現在のコマンド

### 分析コマンド

- `/analyze_start`
  ボイスチャンネルに参加した状態で分析を開始します。
- `/analyze_now`
  その時点までの会話をすぐに分析します。
- `/analyze_stop`
  最終レポートを出さずに停止します。
- `/analyze_stop_final`
  最終レポートを作成してから停止します。

### 設定コマンド

- `/settings set_apikey key:<YOUR_KEY>`
  実行したユーザー専用の Gemini API キーを保存します。
- `/settings set_mode mode:<debate|summary>`
  分析モードを切り替えます。
- `/settings set_interval seconds:<60以上>`
  定期分析の間隔を秒単位で変更します。
- `/settings set_model model:<モデルID>`
  使用モデルを変更します。
- `/model model:<モデルID>`
  モデルだけを素早く変更するショートカットです。
- `/check`
  現在のモデル、モード、分析間隔、録音状態を確認します。

## 分析モード

- `debate`
  主張、対立点、論拠、弱点、ファクトチェックを重視します。
- `summary`
  会議メモや議事録のような要約を重視します。

## 対応モデル

現状のコマンドから選べるモデルは次の 3 つです。

- `gemini-2.5-flash`
- `gemini-3-flash-preview`
- `gemini-3.1-flash-lite-preview`

## 必要なもの

- Bun
- FFmpeg
- Discord Bot Token
- Gemini API Key

## 環境変数

`env.template` をコピーして `.env` を作成します。

```bash
cp env.template .env
```

設定項目:

```env
DISCORD_TOKEN=your_discord_bot_token_here
# GEMINI_API_KEY=your_gemini_api_key_here
# GUILD_ID=your_guild_id_here
```

補足:

- `DISCORD_TOKEN` は必須です
- `GEMINI_API_KEY` は任意です
  ただし通常は `/settings set_apikey` で各ユーザーが自分のキーを保存して使います
- `GUILD_ID` を設定すると、コマンドを特定サーバーへ即時反映できます

## セットアップ

### 1. Bun のインストール

macOS / Linux:

```bash
curl -fsSL https://bun.sh/install | bash
```

Windows PowerShell:

```powershell
powershell -c "irm bun.sh/install.ps1 | iex"
```

### 2. FFmpeg のインストール

macOS:

```bash
brew install ffmpeg
```

Ubuntu / Debian:

```bash
sudo apt-get update
sudo apt-get install -y ffmpeg
```

### 3. プロジェクトの取得

```bash
git clone https://github.com/NagataYushi0222/InsightDebateBot_ts.git
cd InsightDebateBot_ts
bun install
```

### 4. 起動

```bash
bun start
```

開発時は監視モードも使えます。

```bash
bun run dev
```

## Docker での実行

```bash
touch bot_settings.db
cp env.template .env
docker compose up -d --build
```

よく使う操作:

- ログ確認: `docker compose logs -f`
- 停止: `docker compose down`
- 再起動: `docker compose restart`

## サーバー運用例

```bash
nohup bun start > bot.log 2>&1 &
tail -f bot.log
```

停止する場合:

```bash
pkill -f "bun run src/index.ts"
```

## 動作の流れ

1. `/settings set_apikey` で API キーを保存
2. ボイスチャンネルに参加
3. `/analyze_start` で分析開始
4. 一定間隔でレポートが投稿される
5. 必要に応じて `/analyze_now` で手動分析
6. 終了時に `/analyze_stop` または `/analyze_stop_final`

レポートはテキストチャンネルに投稿され、本文はスレッドに分割送信されます。

## トラブルシューティング

### `bun` が認識されない

インストール後にターミナルを再起動してください。

### FFmpeg が見つからない

`ffmpeg -version` で確認してください。

### API キーが設定されていない

`/settings set_apikey` を実行してください。キーは `AIza` で始まる形式を想定しています。

### 429 / レート制限

Gemini API 側の制限です。モデル変更や分析頻度の調整を試してください。

### コマンドがすぐ反映されない

`GUILD_ID` を設定してギルドコマンドとして登録すると反映が速くなります。グローバルコマンドは反映に時間がかかることがあります。

## リポジトリ

- TypeScript 版: https://github.com/NagataYushi0222/InsightDebateBot_ts

## ライセンス

ISC
