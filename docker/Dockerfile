FROM node:22-trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json .
RUN npm install --omit=dev
COPY . .
RUN chmod +x docker/entrypoint.sh \
 && ln -s node_modules/@nictool/api/conf.d conf.d
EXPOSE 8443
ENTRYPOINT ["./docker/entrypoint.sh"]
