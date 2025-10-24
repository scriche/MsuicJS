# Use official Node.js LTS image
FROM node:20-slim

# Install ffmpeg, curl, and cron
RUN apt-get update && \
    apt-get install -y ffmpeg curl cron && \
    apt-get clean

# Setup cron job for yt-dlp updates
RUN echo "0 * * * * root /app/scripts/update-ytdlp.sh >> /var/log/ytdlp-update.log 2>&1" > /etc/cron.d/ytdlp-update && \
    chmod 0644 /etc/cron.d/ytdlp-update

# Set working directory
WORKDIR /app

# Copy package.json and package-lock.json if present
COPY package.json ./
# If you have package-lock.json, uncomment the next line
# COPY package-lock.json ./

# Install dependencies
RUN npm install --production

# Copy bot code
COPY msuic.js ./

# Set environment variables (override with your own .env in production)
ENV NODE_ENV=production

# Create scripts directory and copy scripts
COPY scripts /app/scripts
RUN chmod +x /app/scripts/*.sh

# Use the entrypoint script
ENTRYPOINT ["/app/scripts/entrypoint.sh"]