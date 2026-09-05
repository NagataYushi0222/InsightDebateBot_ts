# Ogg/Opus音声パイプライン堅牢化報告

## 修正概要

- SILK 60 ms frameを80 ms（3840 samples）と誤計算していたTOC解析を、10/20/40/60 msの明示テーブルへ変更した。
- SILK / Hybrid / CELTおよびOpus packing code 0/1/2/3のframe countを検証し、120 msを超える不正packetを拒否するようにした。
- `UserAudioRecorder.discard()` を追加し、異常終了時もpending packetへEOSを付け、WriteStreamのclose後に一時ファイルを削除するようにした。
- flush開始時にstream世代を切り替え、close待ち中に到着したpacketを終了済みstreamへ書く競合を解消した。
- WriteStream errorまたは不正Opus packetが発生した録音はfailedとして扱い、Geminiへ渡さないようにした。
- Guild、VC記事化、今北産業のDestroyed処理からrecorderのdiscardを行い、timerとvoice subscriptionも解除するようにした。
- `SharedVoiceCoordinator` と基本版BotのDestroyed通知対象へ `ImakitaSessionManager` を追加した。
- 要約用Gemini uploadは全音声必須とし、1件でも失敗した場合は先行uploadを削除して分析全体を失敗させるようにした。
- retry音声のDiscord user IDとsegment/part identityを分離し、`userId__partN` を本物のuser IDとして渡さないようにした。
- SQLite DBをGit管理対象から外し、POSIX環境でDB/WAL/SHMを0600へ補正するようにした。systemd例には `UMask=0077` を追加した。
- 通常経路から不要になったOgg raw連結関数、PCM/Opus decode診断、MP3変換の古い説明、古いnpm lockfileを削除した。

## テスト結果

- `bun run typecheck`: 成功
- `bun test`: 14件成功
- `bun run build`: 成功
- `git diff --check`: 成功
- ffprobe: codec `opus`、sample rate `48000`、channels `2` を確認
- 実際のlibopus 60 ms packetを再muxし、元Oggと生成Oggのduration差が20 ms未満であることを確認
- `ffmpeg -v error -i generated.ogg -f null -`: exit code 0
- ffmpeg/ffprobeがない環境ではintegration testだけをskipし、TOC・granule・lacingのunit testは実行されることを確認

## セキュリティ確認

- ローカルの既存DBは削除していない。
- 現在のDBに保存済みAPI keyは0件だった。
- Git履歴をtoken形式で走査し、ソースおよび過去のDBからGemini API key形式の値は検出されなかった。
- Git履歴の書き換えは行っていない。

## FOLLOW-UP

現在の録音はユーザー別・時間区間別のOgg断片で、同じユーザーのretry segmentは順序を保持してGeminiへ渡す。一方、複数ユーザー間の発話burstを絶対時刻で交互に並べるmetadataはまだ保持していない。`A → B → A` の厳密な会話時系列を復元するには、受信hubからburst開始・終了時刻を記録する設計変更が必要なため、別作業を推奨する。
