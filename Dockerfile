# The server as a container image. How to run it is in docs/deployment.md; this file only
# builds it. Nothing of a landscape is in the image: host, client, user, callers and the
# password reach the container at run time (the state volume and a mounted secret).
#
# Pin the base image to a digest in your own registry before relying on it.
FROM node:22-slim

ENV NODE_ENV=production \
    SAP_ADT_STATE_DIR=/var/lib/sap-adt

WORKDIR /opt/sap-adt

# The lockfile is the control (docs/security.md, "Third-party code"): the exact tree, and no
# lifecycle script of any dependency.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --omit=dev && npm cache clean --force

COPY server.mjs ./
COPY lib ./lib
COPY tools ./tools
COPY scripts ./scripts
COPY data ./data

# The state directory: the store, the token, the audit trail, the catalogue. It must be a
# persistent volume -- the rule that protects the SAP user from a lock reads the audit trail of
# earlier starts.
RUN mkdir -p /var/lib/sap-adt && chown node:node /var/lib/sap-adt
VOLUME ["/var/lib/sap-adt"]

USER node
EXPOSE 2237

# CMD, not ENTRYPOINT: `docker run <image> node scripts/config.mjs ...` must run the configuration
# CLI, not hand those words to the server as arguments.
CMD ["node", "server.mjs"]
