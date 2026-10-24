FROM oven/bun:1.4

WORKDIR /app

COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile

COPY . .

ENV HOST=0.0.0.0
EXPOSE 8080

CMD ["bun", "run", "dev"]
