FROM node:22-alpine AS builder

WORKDIR /usr/src/app

COPY package*.json tsconfig.json ./
RUN npm ci

COPY src ./src
RUN npm run build

# --- Stage de producción ---
FROM node:22-alpine AS runner

WORKDIR /usr/src/app
ENV NODE_ENV=production

# Instalar curl para el healthcheck de Coolify
RUN apk add --no-cache curl

COPY package*.json ./
RUN npm ci --only=production

# Copiar archivos compilados y carpeta public
COPY --from=builder /usr/src/app/dist ./dist
COPY public ./public

EXPOSE 3000

CMD ["node", "dist/server.js"]
