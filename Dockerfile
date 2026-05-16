FROM node:20-alpine

WORKDIR /app

COPY backend/package*.json ./backend/
WORKDIR /app/backend
RUN npm ci --omit=dev

WORKDIR /app
COPY backend ./backend
COPY frontend ./frontend

ENV NODE_ENV=production
ENV HOST=0.0.0.0

EXPOSE 3000

WORKDIR /app/backend
CMD ["npm", "start"]
