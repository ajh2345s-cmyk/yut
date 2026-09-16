FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && mkdir -p /app/data && chown node:node /app/data
COPY --chown=node:node server.js game.js ./
COPY --chown=node:node public ./public
ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_FILE=/app/data/state.json
USER node
EXPOSE 3000
CMD ["node", "server.js"]
