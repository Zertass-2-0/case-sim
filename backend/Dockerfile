FROM node:20-alpine

WORKDIR /app

# Copy manifests first: the dependency layer is cached until package*.json changes
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY sql ./sql
COPY data ./data
COPY public ./public

ENV NODE_ENV=production
USER node
EXPOSE 3000
CMD ["node", "src/server.js"]
