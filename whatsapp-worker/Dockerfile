FROM node:20-slim

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# Both source files must be present — pgAuthState.js holds the Postgres session store.
COPY index.js pgAuthState.js ./

# Session lives in Postgres (DATABASE_URL), so NO persistent disk is needed —
# this runs fine on hosts with an ephemeral filesystem (e.g. Render free).
ENV PORT=3000
EXPOSE 3000

CMD ["node", "index.js"]
