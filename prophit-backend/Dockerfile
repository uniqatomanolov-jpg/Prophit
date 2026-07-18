# Prophit backend — container for Railway / Render / Fly / any Docker host
FROM node:20-slim

# better-sqlite3 needs build tools to compile its native module
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# Persist the SQLite database on a mounted volume so picks/history survive restarts
ENV DB_PATH=/data/prophit.db
VOLUME ["/data"]

EXPOSE 3001
CMD ["npm", "start"]
