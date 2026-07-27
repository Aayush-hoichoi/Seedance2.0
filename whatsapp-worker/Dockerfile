FROM node:20-slim

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

COPY index.js ./

# Session lives on a PERSISTENT disk mounted at /data (see render.yaml) so the
# QR link survives restarts. Without a persistent mount you re-scan every deploy.
ENV AUTH_DIR=/data/auth
ENV PORT=3000
EXPOSE 3000

CMD ["node", "index.js"]
