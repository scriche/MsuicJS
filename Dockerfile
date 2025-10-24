# Use official Node.js LTS image
FROM node:20-slim

# Install yt-dlp and ffmpeg for audio extraction
RUN apt-get update && \
    apt-get install -y ffmpeg curl && \
    curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp && \
    apt-get clean

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

# Download yt-dlp and set permissions, then run the bot
CMD ["bash", "-c", "curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && chmod a+rx /usr/local/bin/yt-dlp && node msuic.js"]