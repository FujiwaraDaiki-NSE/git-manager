FROM node:20-alpine AS deps
WORKDIR /srv
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

FROM node:20-alpine AS build
WORKDIR /srv
COPY --from=deps /srv/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:20-alpine AS run
WORKDIR /srv
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000
COPY --from=build /srv/.next/standalone ./
COPY --from=build /srv/.next/static ./.next/static
COPY --from=build /srv/public ./public
EXPOSE 3000
CMD ["node", "server.js"]
