# AGENTS.md — InsightDebateBot (TypeScript)

このファイルは AI コーディング支援ツール（opencode 等）がプロジェクトの意図・規約・運用方法を
コンテキストなしで理解できるようにするためのガイドです。
「このプロジェクトの修正をして」と指示されたら、ここを読んでから作業を始めてください。

## 1. プロジェクトの概要

Discord のボイスチャットを録音し、Gemini API で定期分析・最終レポートを作成する Bot です。
2 つの主機能があります。

- **要約・ディベート分析** (`/analyze_*`, `/dialogue_*`)
  VC で録音しながら一定間隔でレポートを生成。モードは `debate`（対立構造重視）と `summary`（議事録重視）、`dialogue`（指定テーマ整理）。
- **VC 記事化** (`/article_*`)
  VC の会話から記事候補トピックを抽出し、指定トピックからニュース風記事を生成。

両機能は同じ VC 内で同時に利用可能（音声接続を共有する設計）。

## 2. リポジトリと実行環境

- **Git リポジトリ**: `https://github.com/NagataYushi0222/InsightDebateBot_ts`
- **言語/ランタイム**: TypeScript + Bun（`bun run src/index_with_vc_article.ts` で起動）
- **本番稼働先**: OCI（Oracle Cloud Infrastructure）の Always Free インスタンス
  - SSH: `ssh -i ~/Downloads/ssh-key-2026-02-13.key ubuntu@161.33.38.160`
  - サービス: `insight-vc-bot.service`（systemd）
  - ローカルパス（OCI 上）: `~/InsightDebateBot`
  - ログ: `~/InsightDebateBot/bot.log`
- **GitHub 連携フロー**: ローカルで修正 → `git push origin main` →
  OCI 上で `cd ~/InsightDebateBot && git pull && sudo systemctl restart insight-vc-bot`
  （`discord-bot` という古いユニット名ではなく `insight-vc-bot` が正式名）
- **必須依存**: Bun, Discord Bot Token, Gemini API Key（FFmpeg/ffprobe はOgg integration test時のみ）
- **環境変数**: `.env` に `DISCORD_TOKEN`（必須）、既定 `GEMINI_API_KEY`（任意）、`GUILD_ID`（任意）
- **DB**: `bot_settings.db`（Bun SQLite、ギルドごとの API キー・モデル・間隔・モードを保持）

### 開発・検証コマンド

```bash
bun install
bun run typecheck
bun test
bun run build
bun run src/index_with_vc_article.ts   # ローカル起動
bun run dev                  # watch モード
```

### 型チェックに関する注意

`bun install` のpostinstallで、利用中のTypeScript/@noble版に合わせて
`@ovencord/voice` の互換パッチを適用する。型チェックが依存パッケージ内で失敗した場合は、
先に `bun run scripts/patch-ovencord-voice.ts` を再実行する。`bun run typecheck` は成功が必須。

## 3. ディレクトリ構造

```
src/
├── index_with_vc_article.ts   # 本番用エントリーポイント（拡張版）
├── bot_with_vc_article.ts     # 拡張版 Bot 本体（要約系 + 記事化）
├── index.ts / bot.ts          # 要約系のみの基本版（運用では基本使わない）
├── config.ts                  # 環境変数読込、Gemini モデル解決、一時ディレクトリ
├── database.ts                # SQLite ギルド設定（bun:sqlite 使用）
├── sessionManager.ts          # 要約系セッション（GuildSession / SessionManager）
├── sharedVoiceCoordinator.ts  # 音声接続の共有・再接続・切断監視
├── voiceCaptureHub.ts         # DAVE復号済みOpus packetの共有受信ハブ
├── oggOpusMuxer.ts            # Opus packetを再エンコードせずOggへmux
├── recorder.ts                # ユーザー別Ogg/Opusストリーム書き出し
├── audioProcessor.ts          # 一時音声ファイルの削除
├── analyzer.ts                # 要約系 Gemini 分析（PROMPTS/構造化メモ/Web検索）
├── geminiWebSearch.ts         # Gemini 経由の Web 検索 function calling
├── searchTool.ts              # 検索結果 fetch と URL 検証
├── voiceDisconnectReporter.ts # VC 切断時のユーザー通知
├── liveVoiceStatusDisplay.ts  # 録音状況を示す埋め込みメッセージ管理
├── runtimeMonitor.ts          # メモリ/稼働状況/VC 状態の定期ログ出力
├── voiceDiagnostics.ts        # Opus/DAVE 復号の診断カウンタ
├── commands/                  # Slash Command 関連
│   ├── builders.ts builders/  # コマンド定義ビルダ
│   ├── analyzeModes.ts        # 要約系共通 start/stop/now ロジック
│   ├── analyzeModeHandlers.ts # 上記の呼び出し口
│   ├── analyzeModeConfigs.ts  # モード別メッセージ文言
│   ├── article.ts             # /article_* 系ハンドラ
│   ├── articleFormatting.ts   # 記事系メッセージ整形
│   ├── settings.ts            # /settings, /model ハンドラ
│   ├── display.ts             # /check 表示
│   └── replies.ts             # 長文チャンク送信
├── vcArticle/                 # VC 記事化機能
│   ├── sessionManager.ts      # VcArticleSession / VcArticleSessionManager
│   ├── ai.ts                  # 記事化トピック抽出・記事生成
│   ├── prompts.ts             # 記事化プロンプト
│   ├── storage.ts             # 音声アーカイブの保存/一覧/読込（7日期限）
│   └── types.ts               # 記事化型定義
└── deploy/
    └── insight-vc-bot.service # systemd ユニット例（ExecStart = bun run src/index_with_vc_article.ts）
```

## 4. コード規約

- **言語**: TypeScript（strict モード）。ES2022 target。
- **モジュール**: `import` はデフォルト `bun` の Node 互換形式。
  `package.json` の `main` は `src/index.ts` だが、本番運用は `src/index_with_vc_article.ts` 前提。
- **コメント**: コード内に日本語コメントを許容（既存コードも日本語コメント多数）。
  新規コメントは「なぜ」を説明する短い日本語でよい。「何を」の説明は不要。
  不要なコメントは追加しない（ユーザーから明示された場合以外はコメントを最小限に）。
- **命名**:
  - クラス/ファイル: `PascalCase`
  - 変数/関数: `camelCase`
  - 定数: `SNAKE_CASE` / `UPPER_SNAKE`
  - Discord 関連以外は特段略称を使わない
- **非同期**: 同期処理（`execSync` 等）がイベントループを塞ぐと Discord の音声/Gateway
  ハートビートが途切れて Bot が VC から切断されるため、**重い処理は必ず非同期**（`spawn`, `await`）。
  過去に `execSync` 版 ffmpeg 変換で 10 分間隔時に切断事故が起きた（`VC_DISCONNECT_FIX_REPORT.md` 参照）。
- **エラーハンドリング**:
  - Discord API の `Unknown interaction (10062)` は握り潰す（既存パターン踏襲）。
  - `process.on('uncaughtException'/'unhandledRejection')` は `RuntimeMonitor` が集約ログ出力。
  - 音声/分析系のエラーは `targetTextChannel` に `⚠️` 付きメッセージを送る。

## 5. 音声パイプラインの全体像（修正時の最重要ポイント）

```
Discord音声WebSocket
    ↓ DAVE復号
voiceCaptureHub.ts  ── 参加者ごとに復号済みOpus packetを受信
    ↓ OggOpusMuxer（transcodeなし）
recorder.ts ── temp_audio/recording_<userId>_<ts>.ogg へ書込
    ↓ 定期 interval 経過
sessionManager.runProcessAudio / vcArticle.flushCurrentChunk
    ↓ recorder.flushAudio()
Gemini File API (audio/ogg; upload → PROCESSING → ACTIVE → generateContent)
```

このパイプラインのどの段階でも**イベントループを長時間 block しない**こと。
Gemini API 呼び出しは非同期で待つ。通常経路でOpusをPCMへdecodeしたり、MP3へtranscodeしたりしない。
複数のOggをraw byte concatenateしない。retry音声は独立したaudio partとしてGeminiへ渡す。
FFmpegはテスト時の完全デコード・duration検証にのみ利用する。

## 6. 音声接続と切断の扱い（ここを変えるときは慎重に）

- `SharedVoiceCoordinator` が 1 つの VoiceConnection を要約系と記事系で共有する。
- `getActiveGuildVoiceConnection` は「isRecording && hasActiveConnection」を満たす接続のみ active 扱い。
- 切断シーケンスの重要な競合:
  - `VoiceStateUpdate` ハンドラ（`bot_with_vc_article.ts`）が Bot の退出を検知したとき、
    録音中で VC に人間が残っていれば `attemptVoiceReconnect` で**同じチャンネルに自動再接続**する。
    成功時は `VoiceDisconnectReporter.suppressReport` で古い接続の切断通知を抑制。
    失敗時だけセッション終了＋切断メッセージ1件。
  - `SharedVoiceCoordinator` 側でも `Disconnected → 5s 待ち → 再接続失敗で破棄` がある。
    VoiceStateUpdate 側が先に強制破棄しないように（再接続の邪魔をしないように）。
- `GuildSession.reattachVoiceConnection` と `VcArticleSession.reattachVoiceConnection` は
  新しい接続に音声キャプチャだけ差し替え、録音状態・構造化メモリ・保留音声は維持する仕組み。
  再接続ロジックを触るときはこの2つの使い分けに注意。
- `prepareForReconnect` を呼ぶ前に古い接続を破棄しない（破棄すると shared が active 扱いしなくなり、
  新規 join に切り替えられない）。順序は `prepareForReconnect → ensureVoiceConnectionForChannel → reattachVoiceConnection → 旧接続 destroy`。

## 7. Gemini API の扱い

- ユーザーは `/settings set_apikey` で自分の Gemini API キーを DB に保存する。
  セッション開始時にはそのユーザーキーを取得（`getRequiredUserApiKey`）して `analyzeDiscussion` へ渡す。
- `config.ts` の `resolveGeminiModel` は非推奨モデル名→推奨モデル名のマッピングを持つ。
  モデル追加/変更時は `GEMINI_MODEL_*` 定数, `DEPRECATED_MODEL_REPLACEMENTS`,
  `getGeminiModelDisplayName`, `isGeminiThinkingModel` を併せて更新。
- 思考モデル（`gemini-2.5` / `gemini-3.*`）は `thinkingConfig.thinkingLevel: 'HIGH'` を付与。
  それ以外は `thinkingConfig` を付けない。
- Web 検索は Gemini の `googleSearch` ツールではなく **自作 function calling 経由**
  （`geminiWebSearch.ts` + `searchTool.ts`）。
  無料 Tier の Grounding 制限を回避するためこの方式を維持。
- 画像/音声は `ai.files.upload` で File API に上げてから `generateContent` に渡す。
  終わったらアップロードを cleanup（`cleanupUploads`）。

## 8. よくある修正パターン

- **分析出力形式やプロンプト調整**: `src/analyzer.ts` の `PROMPTS` 定数と
  `src/vcArticle/prompts.ts` を編集する。プロンプトは日本語で記述。
- **録音間隔やモデルの既定値**: `src/config.ts` の定数と `database.ts` の DEFAULT 値、
  `commands/settings.ts` のバリデーションを併せて見る。
- **Slash Command 追加/変更**: `src/commands/builders.ts`（+ `builders/`）に定義を追加、
  `bot_with_vc_article.ts` の `interactionCreate` で dispatch を追加。
  グローバルコマンドとして登録される（反映に時間がかかる）。
  `GUILD_ID` を `.env` に入れるとギルドコマンドで即時反映できる（本番はグローバル運用）。
- **録音中の振る舞いやリソース管理**: `sessionManager.ts` と `vcArticle/sessionManager.ts`
  の `startRecording / stopRecording / reattachVoiceConnection` 周りを確認。
  `retainRawAudioFiles`（要約系の未出力音声繰り越し）と `pendingAudioClips`（記事系）
  の扱いに注意。レポート投稿に失敗した場合は音声を次回へ繰り越す設計。

## 9. デプロイ手順（修正を本番反映）

ローカルでコミット → push:

```bash
cd <ローカルの InsightDebateBot_ts>
git add <該当ソース> && git commit -m "<変更要約>" && git push origin main
```

OCI へ反映:

```bash
ssh -i ~/Downloads/ssh-key-2026-02-13.key ubuntu@161.33.38.160 \
  "cd ~/InsightDebateBot && git pull && sudo systemctl restart insight-vc-bot && sleep 2 && sudo systemctl status insight-vc-bot --no-pager"
```

ログ確認:

```bash
ssh -i ~/Downloads/ssh-key-2026-02-13.key ubuntu@161.33.38.160 "tail -30 ~/InsightDebateBot/bot.log"
```

正常起動の目安: `Logged in as <Bot名>` と `Synced global commands` が末尾付近に出る。

## 10. コミット規約

- コミットメッセージは **英語**（`git log` を見ると既存コミットはすべて英語短文）。
  例: `Fix VC auto-disconnect via async encode and auto-reconnect`
- 1 コミット 1 テーマ。関数差し替えと無関係な `bot_settings.db*` を同時にコミットしない。
- ランタイム DB（`bot_settings.db*`）は `.gitignore` 対象。変更・コミット・削除しない。

## 11. 既知の落とし穴

- **`execSync` 系は絶対使わない**: 重い同期処理を入れると Bot が VC から切断される。
  `audioProcessor.ts` に限らず、長時間動く処理は非同期化。
- **`discord-bot` というユニット名で再起動しない**: 本番は `insight-vc-bot.service`。
- **`.env` をコミットしない**: `env.template` のみ追跡。
- **postinstall で ovencord にパッチ当てる**: `scripts/patch-ovencord-voice.ts` が
  `bun install` のたびに走る。`bun install` 後にパッチが当たらない環境差分時は
  `bun run scripts/patch-ovencord-voice.ts` を手動で実行。
- **共有接続の active 判定**: `SharedVoiceCoordinator.getActiveGuildVoiceConnection` は
  「接続オブジェクトが残っている」ではなく「isRecording && hasActiveConnection」を要求。
  切断後すぐに接続を null にしないと次の参加が_approvedな状態にならない。

## 12. 報告書と課題管理

- ユーザーが問題指示とともに要求した場合、解析と改善結果を日本語で **個別 MD ファイル**
  （例: `VC_DISCONNECT_FIX_REPORT.md`）としてリポジリに残すこと。
- 問題指示が `problem.md` 等で与えられたら、そのファイルを読み、
  必要なら追加の調査後、修正 → 検証 → push → OCI 反映 → 報告書作成 の順で進める。

## 13. 連絡先・運用メモ

- 実装者/運用者情報は省略（触れる必要があればユーザーに確認）。
- プロンプト日本語のトーン: 丁寧体（`です/ます` 基調）。
- Bot 正常稼働中のログは `bot.log` 末尾に `Logged in as ...` と `Synced global commands` が
  出れば OK。再起動直後は `received SIGTERM` の後に上記が並ぶ。

---
何かを変更する際は、このファイルの記述とGit logから最新意図を 都度 確認してください。
特に「音声接続」「非同期処理」「Gemini 呼び出し」の3領域は、過去に障害が起きた重要個所なので慎重に扱ってください。
