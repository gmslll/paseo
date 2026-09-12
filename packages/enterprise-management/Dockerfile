FROM node:22-bookworm-slim AS runtime

RUN useradd --create-home --uid 10001 paseo
WORKDIR /opt/paseo-management
COPY --chown=paseo:paseo dist/standalone.js ./standalone.js
USER paseo
EXPOSE 17443
ENTRYPOINT ["node", "--disable-warning=ExperimentalWarning", "/opt/paseo-management/standalone.js"]
