# Внешних зависимостей нет: npm install не нужен. База лежит в /data — это постоянное хранилище хостинга.
FROM node:24-alpine
WORKDIR /app
COPY package.json *.js ./
COPY public ./public
COPY tools ./tools
ENV NODE_ENV=production DB_PATH=/data/gateway.db PORT=8790
EXPOSE 8790
CMD ["node", "server.js"]
