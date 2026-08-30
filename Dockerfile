FROM node:20-alpine

WORKDIR /app
COPY package.json server.mjs index.html README.md ./
RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
VOLUME ["/app/data"]
EXPOSE 3000

CMD ["node", "server.mjs"]
