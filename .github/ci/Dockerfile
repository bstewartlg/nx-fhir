# CI image for run-tests.yml: Maven + JDK 17 + Node/npm + bun in one
# container, so workflow runs install no toolchains at runtime. Every version
# is pinned here; bumping one is a reviewed commit followed by the
# publish-ci-image workflow, then updating the tag referenced in run-tests.yml.
FROM maven:3.9-eclipse-temurin-17

# npm and npx in bin/ are symlinks into lib/node_modules, so the two
# directories must be copied together. The yarn symlinks point at an /opt tree
# that is not copied, and only bun and npm are supported, so they are removed.
COPY --from=node:24.19.0-bookworm-slim /usr/local/bin /usr/local/bin
COPY --from=node:24.19.0-bookworm-slim /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=oven/bun:1.3.14 /usr/local/bin/bun /usr/local/bin/bun
RUN rm -f /usr/local/bin/yarn /usr/local/bin/yarnpkg \
 && ln -s /usr/local/bin/bun /usr/local/bin/bunx
