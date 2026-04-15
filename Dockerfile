# Dev image — hot reload via ts-node watch.
# Phase 7 replaces this with a multi-stage production build.
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
CMD ["npm", "run", "start:dev"]
