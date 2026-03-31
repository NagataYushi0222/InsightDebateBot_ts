# InsightDebate Bot (TypeScript)

Discord のボイスチャットを録音し、Gemini で定期分析や最終レポートを作成する Bot です。議論の要点整理、対立構造の可視化、会議要約に加えて、VC の会話を記事化する機能も追加できます。

## 特徴

- ユーザーごとに音声を個別録音
- 定期レポート、手動レポート、最終レポートに対応
- Gemini による議論分析 / 会議要約
- VC 会話から記事候補トピックを抽出し、ニュース風の記事を生成
- 記事化用音声を日時ごとに保存し、一覧表示や再読み込みに対応
- 記事化録音は約15分ごとに区切って MP3 化
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

### VC 記事化コマンド

- `/article_start`
  VC 記事化用の録音を開始します。
- `/article_stop`
  録音を停止し、記事候補トピックを抽出します。
- `/article_topics`
  直近のトピック候補を再表示します。
- `/article_archives`
  保存済みのVC音声セッション一覧を表示します。
- `/article_load archive_id:<ID>`
  保存済み音声を選び、保存済みの記事候補を読み込みます。候補が未保存の古いアーカイブだけ初回に抽出します。
- `/article_write topic:<番号>`
  選択したトピックからニュース風の記事を生成します。
- `/article_discard`
  録音中セッションまたは現在選択中のキャッシュを破棄します。保存済み音声自体は残ります。

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
- VC 記事化機能でテキストチャットも取り込む場合は、Discord Developer Portal 側で `Message Content Intent` を有効化してください

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

通常版:

```bash
bun start
```

開発時は監視モードも使えます。

```bash
bun run dev
```

VC 記事化機能を含む拡張版を起動する場合:

```bash
bun run src/index_with_vc_article.ts
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

## VC 記事化機能の流れ

1. `/settings set_apikey` で API キーを保存
2. 記事化したい VC に参加
3. `/article_start` で録音開始
4. 必要に応じて同じテキストチャンネルで会話ログも投稿
5. `/article_stop` で録音停止とトピック抽出
6. `/article_write topic:<番号>` で記事生成

記事化機能では、ユーザーごとの音声ファイルと、同じテキストチャンネルでの発言をまとめて Gemini に渡し、記事化向きの話題を抽出します。

## 記事化音声の保存仕様

- 保存先は `temp_audio/vc_article_archive/YYYY-MM-DD/<archive_id>/` です
- 音声はユーザーごとに別ファイルで保存されます
- 長時間VCに対応するため、録音中に約15分ごとで区切って PCM から MP3 へ変換します
- そのため、1人の参加者について複数のMP3断片が保存されることがあります
- 保存済みアーカイブは7日で期限切れになり、次回アクセス時に自動削除されます
- 一度概要を生成したアーカイブには、概要先頭20文字程度のタイトルが付き、`/article_archives` で見やすく表示されます
- `/article_stop` で生成した記事候補はアーカイブに保存され、`/article_load` で再利用されます

## 保存済み音声の使い方

1. `/article_archives` で保存済み音声の一覧を確認
2. 一覧の `archive_id` を使って `/article_load archive_id:<ID>` を実行
3. 保存済みまたは初回抽出されたトピックに対して `/article_write topic:<番号>` を実行

一覧には、保存ID、概要タイトル、録音日時、VC名、ファイル数、話者数、チャット件数、容量が表示されます。

## 追加ファイル

- `src/bot_with_vc_article.ts`
  既存コマンドに加えて VC 記事化コマンドを含む拡張版 Bot 本体です。
- `src/index_with_vc_article.ts`
  VC 記事化機能込みの起動エントリーポイントです。
- `src/vcArticle/`
  VC 記事化用のプロンプト、AI 呼び出し、セッション管理ロジックを分離したディレクトリです。
  `storage.ts` で保存済み音声アーカイブ管理を行います。

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
