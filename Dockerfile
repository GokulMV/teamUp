# TeamUp: a single Node process serves the page and runs the game rooms.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server ./server
COPY public ./public
USER node
# Railway sets PORT; 3000 is the local default.
EXPOSE 3000
CMD ["node", "server/index.js"]
