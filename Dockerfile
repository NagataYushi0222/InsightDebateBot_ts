# Bun をベースイメージとして使用
FROM oven/bun:1-slim

# 作業ディレクトリを設定
WORKDIR /app

# システム依存関係をインストール
# - ffmpeg: 音声処理に必要
# - ca-certificates: SSL証明書
RUN apt-get update && apt-get install -y \
    ffmpeg \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# パッケージファイルをコピーしてインストール
COPY package.json bun.lock* ./
RUN bun install --production

# アプリケーションコードをコピー
COPY src/ ./src/
COPY tsconfig.json ./

# 一時音声ファイル用のディレクトリを作成
RUN mkdir -p /app/temp_audio

# 環境変数のデフォルト値（実行時にオーバーライド可能）
ENV NODE_ENV=production
ENV DISCORD_TOKEN=""

# Bun でTypeScriptを直接実行
CMD ["bun", "run", "src/index.ts"]
