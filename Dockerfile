# 폐쇄망 반입용 이미지: 의존성과 MMDB를 이미지에 포함한다(런타임 외부 통신 없음).
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080 HOST=0.0.0.0
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY data ./data
COPY THIRD_PARTY_NOTICES.md ./
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "src/server.js"]
