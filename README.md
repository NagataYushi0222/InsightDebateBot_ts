# InsightDebate Bot

Discord上のボイスチャットを自動録音・分析し、議論の要約や対立構造を可視化するAI Botです。

## 特徴
- 📹 **ユーザーごとの音声録音**: 各参加者の発言を個別に記録
- 🤖 **Gemini AIによる分析**: Google Gemini API (Gemini 2.5 Flash / 3 Flash) で音声を分析
- 🔍 **ファクトチェック**: Google検索機能 (Dynamic Retrieval) で発言内容の正確性を確認
- 📊 **2つのモード**: 「議論分析」と「会議要約」を選択可能
- ☁️ **軽量設計**: OCI E2.1 Microなどの低スペック環境でも動作可能（ストリーム録音対応）

## 必要なもの
- **Bun** v1.3以上（プログラムの実行に使います）
- **FFmpeg**（音声の変換処理に使います）

---

## 🖥️ Windows でのセットアップ

### ステップ1: Bunをインストールする

PowerShellを **管理者として実行** し、以下を打ちます。

```powershell
powershell -c "irm bun.sh/install.ps1 | iex"
```

⚠️ **重要: インストール後、PowerShellを一度閉じて開き直してください。**
閉じないと `bun` コマンドが認識されません。

開き直したら、以下で確認できます。
```powershell
bun --version
```
バージョン番号（例: `1.3.10`）が表示されれば成功です。

### ステップ2: プロジェクトの準備

```powershell
git clone https://github.com/NagataYushi0222/InsightDebateBot.git
cd InsightDebateBot
bun install
```

### ステップ3: 設定ファイルの作成

`env.template` をコピーして `.env` を作り、メモ帳やVSCodeで開いて編集します。

```powershell
copy env.template .env
notepad .env
```

以下の2つを自分の値に書き換えてください。
```
DISCORD_TOKEN=ここにBotのトークンを貼り付け
GEMINI_API_KEY=ここにGemini APIキーを貼り付け
```

### ステップ4: 起動

```powershell
bun start
```

`Logged in as ○○` と表示されたら成功です 🎉

---

## 🍎 Mac でのセットアップ

### ステップ1: Bunをインストールする

ターミナルを開き、以下を実行します。

```bash
curl -fsSL https://bun.sh/install | bash
```

⚠️ **重要: インストール後、ターミナルを一度閉じて開き直してください。**

確認:
```bash
bun --version
```

### ステップ2: FFmpegをインストールする

Homebrewがある場合:
```bash
brew install ffmpeg
```

Homebrewがない場合は先にHomebrewをインストールしてください:
```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
brew install ffmpeg
```

### ステップ3: プロジェクトの準備

```bash
git clone https://github.com/NagataYushi0222/InsightDebateBot.git
cd InsightDebateBot
bun install
```

### ステップ4: 設定

```bash
cp env.template .env
nano .env
```

`DISCORD_TOKEN` と `GEMINI_API_KEY` を自分の値に書き換えて保存します（nano: Ctrl+O → Enter → Ctrl+X）。

### ステップ5: 起動

```bash
bun start
```

---

## ☁️ OCI / Linux サーバーでのセットアップ

### ステップ1: 必要なツールをインストール

```bash
# Bunのインストール
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc

# FFmpegのインストール
sudo apt-get update && sudo apt-get install -y ffmpeg
```

### ステップ2: プロジェクトの準備

```bash
git clone https://github.com/NagataYushi0222/InsightDebateBot.git
cd InsightDebateBot
bun install
```

### ステップ3: 設定

```bash
cp env.template .env
nano .env
```

### ステップ4: 起動（バックグラウンド実行）

サーバーではターミナルを閉じても動き続けるようにする必要があります。

```bash
# 方法1: nohup で起動（シンプル）
nohup bun start > bot.log 2>&1 &

# ログを確認したい場合
tail -f bot.log

# 停止したい場合
pkill -f "bun run src/index.ts"
```

```bash
# 方法2: screenを使う（ログを直接見たい場合）
screen -S debate-bot
bun start
# Ctrl+A → D で画面を離脱（裏で動き続ける）
# screen -r debate-bot で戻れる
```

---

## 🐳 Docker での実行（オプション）

Dockerを使いたい場合は、以下の手順で起動できます。

```bash
# データベースファイルを先に作成
touch bot_settings.db

# .envファイルを設定
cp env.template .env
# .envを編集

# 起動
docker compose up -d --build
```

- **ログ確認**: `docker compose logs -f`
- **停止**: `docker compose down`
- **再起動**: `docker compose restart`

---

## コマンド一覧

### 録音・分析コマンド
- `/rec start`: ボイスチャットの録音・分析を開始します
- `/rec stop`: 分析を終了し、レポートを作成して退出します
- `/rec now`: 現在までの会話を強制的に分析・要約します

### 設定コマンド
- `/settings set_key <key>`: Gemini APIキーを設定します
- `/settings set_mode <debate|summary>`: 分析モードを変更します
  - `debate`: 議論の対立構造やファクトチェック
  - `summary`: 会議の議事録・要約
- `/settings set_interval <秒>`: 定期分析の間隔を変更（デフォルト300秒）
- `/settings set_model <model>`: 使用するGeminiモデルを変更
  - `gemini-2.5-flash`: 高速・安定
  - `gemini-3-flash-preview`: 高性能

## トラブルシューティング

### `bun` が認識されない
- **原因**: インストール後にターミナルを再起動していない
- **解決**: ターミナル（PowerShell / Terminal）を一度閉じて開き直す

### FFmpegが見つからない
- `ffmpeg -version` でインストール済みか確認
- Windows: [ffmpeg.org](https://ffmpeg.org/download.html) からダウンロード
- Mac: `brew install ffmpeg`
- Linux: `sudo apt-get install ffmpeg`

### 429 Quota Exceeded
- Google Gemini APIの制限。自動リトライしますが、頻発する場合は `/settings set_model` でモデルを変更してください

## ライセンス
MIT License
