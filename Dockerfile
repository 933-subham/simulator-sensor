FROM node:22-alpine

WORKDIR /app

# Copy dependency manifests
COPY package*.json ./

# Install only production dependencies
RUN npm ci --omit=dev

# Copy source code and public assets
COPY src/ ./src/
COPY public/ ./public/

# Expose port (default 3000)
ENV PORT=3000
EXPOSE 3000

# Start server
CMD ["npm", "start"]
