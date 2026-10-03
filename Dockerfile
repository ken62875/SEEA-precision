# SEEA Precision — Coolify(Vultr) 배포용
# 의존성 없음 (Node 내장 모듈만) → npm install 불필요
FROM node:22-alpine

ENV TZ=Asia/Seoul
RUN apk add --no-cache tzdata

WORKDIR /app
COPY . .

# 런타임 데이터(커뮤니티·방문·캐시·업로드)는 /app/data 에만 쓴다.
# Coolify > Persistent Storage 에서 이 경로를 볼륨으로 매핑해야 재배포 후에도 보존된다.
ENV NODE_ENV=production \
    DATA_DIR=/app/data \
    PORT=3000
RUN mkdir -p /app/data

EXPOSE 3000
CMD ["node", "server.mjs"]
