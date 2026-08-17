# syntax=docker/dockerfile:1
FROM node:20-alpine AS runner

WORKDIR /app

# Set production environment
ENV NODE_ENV=production
ENV PORT=3500

# Install dependencies
COPY package*.json ./
RUN npm ci --only=production --ignore-scripts

# Copy application files and self-contained datasets
COPY data ./data
COPY public ./public
COPY server.js ./

# Expose container port
EXPOSE 3500

# Run server
CMD ["node", "server.js"]
