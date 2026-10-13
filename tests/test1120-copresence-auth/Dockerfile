FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4
RUN install -d -m 0755 /run/user && install -d -m 0700 -o bun -g bun /run/user/1000
WORKDIR /repo
COPY agent-node/src/runtime/opencode-acp/ /repo/agent-node/src/runtime/opencode-acp/
USER bun
CMD ["bun", "test", "agent-node/src/runtime/opencode-acp/copresence-auth.test.ts", "agent-node/src/runtime/opencode-acp/child-env.test.ts"]
