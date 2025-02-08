FROM node:18-alpine

WORKDIR /app

COPY package.json package-lock.json ./
COPY . .

RUN npm install

ENV NODE_ENV=production

CMD ["node", "index.js"]
