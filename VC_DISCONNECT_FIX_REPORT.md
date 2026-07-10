# VC 自動退出問題の解析と改善報告

## 発生事象

10分インターバルで分析（`/analyze_start` 系）を実行中、AI の回答出力中に以下のメッセージとともに Bot が勝手に VC から退出する。

```
🔌 VCから切断しました
理由: Bot が VC から退出したため
対象VC: 💭｜雑談３
詳細: Discord の VoiceStateUpdate で Bot の在室先変更を検知しました。
```

5分間隔（デフォルト）では発生せず、10分間隔に設定したときだけ再現する。

## 解析

### 実行環境の確認

稼働中の Bot は systemd ユニット `insight-vc-bot.service` により
`bun run src/index_with_vc_article.ts`（`bot_with_vc_article.ts`）で起動している。
OCI 無料枠（ARM Ampere A1）上で動作。

### 根本原因

`src/audioProcessor.ts` の `convertToMp3` が `execSync`（**同期**）で ffmpeg を呼び出していた。

```
execSync(`ffmpeg -f s16le -ar 48000 -ac 2 -i "${filePath}" -y "${mp3Path}"`);
```

録音間隔 `recording_interval` は DB 設定（デフォルト 300秒＝5分）。
対話音声は Discord PCM 形式（s16le / 48kHz / 2ch）で蓄積されるため、1分あたり約 11MB。

| 間隔 | PCM サイズ目安 | execSync の阻塞時間 |
|------|----------------|----------------------|
| 5分  | 約 55MB        | 数秒（ギリギリ許容）|
| 10分 | 約 110MB       | 10秒前後（致命的）|

`execSync` は Node/Bun のイベントループを**完全にブロック**する。その間以下が送れない。

- **Discord 音声 WebSocket のハートビート**（概ね5〜30秒間隔）
- **Discord Gateway のハートビート**

ハートビートが途切れると Discord 側が音声接続を切断し、Bot を VC から退出させる。
これが `bot_with_vc_article.ts` の `VoiceStateUpdate` ハンドラで `oldState.channelId` あり / `newState.channelId` なしとして検知され、即座に `reportBeforeDestroy` で接続破棄＋切断メッセージ送信に至る。

「回答出力中に起きる」のは、定期分析ループが 10 分経過後に `processAudio` を起動し、
その最初の工程である **PCM→MP3 変換（execSync）** でイベントループが止まるため。
AI 応答そのもの（Gemini API 待ち）は非同期 await でイベントループを塞がないので、
変換フェーズがトリガーになっていると判断できる。

5分間隔で問題ないのも、変換時間が短くハートビート1回分以内に収まるためと説明がつく。

### 追加の弱点

`VoiceStateUpdate` ハンドラは Bot が VC を離れた瞬間に**即座に接続を破棄**していた。
一方 `SharedVoiceCoordinator` には「切断 → 5秒以内の再接続待ち → 失敗時のみ破棄」という
穏やかな復帰ロジックがあるが、`VoiceStateUpdate` ハンドラがそれを先取りして強制破棄してしまう競合があった。
OCI 無料枠の一時的なネットワーク揺らぎでも、復帰できずにセッションが終了してしまう状態だった。

## 改善内容

### 1. 音声エンコードの非同期化（根本対策）

`src/audioProcessor.ts`

- `execSync` を `child_process.spawn` を使った非同期版 `convertToMp3Async` に置き換え。
- イベントループを block しないため、長時間録音でも音声/Gateway ハートビートが途切れない。
- `sessionManager.ts`（`runProcessAudio`）と `vcArticle/sessionManager.ts`（`flushCurrentChunk`）の
  全呼び出し元を `convertToMp3Async` に更新。分析側は `Promise.all` で並列化。

### 2. VC 自動再接続の追加（耐障害性強化）

`src/bot_with_vc_article.ts`

- `VoiceStateUpdate` で Bot の退出を検知したとき、録音セッションが生きていて
  **VC に人間が残っていれば同じチャンネルへ自動再接続**する `attemptVoiceReconnect` を追加。
- 成功時: `♻️ 一時的な音声接続の切断を検知し、VC へ再接続しました。録音は継続します。` を通知し、
  古い接続は切断メッセージを出さずに破棄（`VoiceDisconnectReporter.suppressReport`）。
- 失敗時: セッションを安全に終了し、切断通知を1件だけ送信。
- 「Bot が別の VC へ移動（管理者による移動）」場合は再接続せず、従来通りの切断処理。

### 3. セッション側の再接続支援メソッド

`src/sessionManager.ts`（`GuildSession`）、`src/vcArticle/sessionManager.ts`（`VcArticleSession`）

- `reattachVoiceConnection(connection)`: 新しい VoiceConnection に音声キャプチャだけ差し替え。
  構造化メモリ・録音サイクル・APIキー・保留音声は**維持**され、録音が継続できる。
- `prepareForReconnect()`: 再接続前に古い接続参照とキャプチャ購読を解放し、
  `SharedVoiceCoordinator` が「アクティブ接続なし」と判定して新規接続を作れるようにする。

### 4. 切断通知の抑制IF

`src/voiceDisconnectReporter.ts`

- `suppressReport(connection)`: 再接続成功時に古い接続の破棄で二重に切断メッセージが出ないよう、
  `reportedConnections` へ事前登録するメソッドを追加。

## 検証

- `bunx tsc --noEmit` で編集ファイルに由来するエラー0件を確認（既存の `bun:sqlite`/ovencord 依存の環境差分は除く）。
- OCI 側は Bun 実行で `bun:sqlite` 等が解決するため、型エラーは実害なし。

## 適用手順

```bash
# ローカルで修正をコミット後
cd ~/InsightDebateBot_ts
git add -A && git commit -m "fix: 非同期エンコード化とVC自動再接続で10分間隔時の切断を解消"
git push
```

OCI 側:

```bash
ssh -i ~/Downloads/ssh-key-2026-02-13.key ubuntu@161.33.38.160
cd ~/InsightDebateBot && git pull && sudo systemctl restart discord-bot && sudo systemctl status discord-bot
```

> 注: OCI 側のクローンパス（`~/InsightDebateBot`）とローカルの `InsightDebateBot_ts` は
> 同一 GitHub リポジトリの別段落（ブランチ/作業コピー）の想定。必要に応じてブランチを合わせること。

## 期待される効果

- 10分間隔でも PCM→MP3 変換中にイベントループが止まらなくなり、VC から切断されなくなる。
- 万一の一時切断でも、人が残っていれば同じ VC へ自動復帰し録音が継続する。
- 管理者による Bot の強制移動時は従来通りの切断通知が出る（誤作動なし）。