FROM node:20-alpine

RUN apk add --no-cache python3 py3-pip ffmpeg ca-certificates \
    && python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir -U yt-dlp \
    && adduser -D -H -u 10001 app

ENV PATH="/opt/venv/bin:$PATH"

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

COPY . .
RUN chown -R app:app /app

USER app
EXPOSE 3000
CMD ["npm", "start"]