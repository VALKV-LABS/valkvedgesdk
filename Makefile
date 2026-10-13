# Everything runs in Docker. No local toolchains are needed.
NODE_IMAGE ?= node:22-bookworm-slim
TS = docker run --rm -v "$(CURDIR)/typescript":/app -v vkesdk-ts-modules:/app/node_modules -w /app \
     --add-host=host.docker.internal:host-gateway

.PHONY: help ts-test ts-integ

help: ## List the commands
	@grep -E '^[a-z-]+:.*##' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  make %-10s %s\n", $$1, $$2}'

ts-test: ## TypeScript SDK: type-check, unit tests (no network) and build
	$(TS) $(NODE_IMAGE) sh -c "npm install --no-audit --no-fund --loglevel=error && npm run typecheck && npm test && npm run build"

# Needs a running service and a key that may manage databases:
#   make ts-integ EDGEKV_URL=... EDGEKV_CONTROL_URL=... EDGEKV_API_KEY=ekv_...
# From inside the container, the machine running Docker is host.docker.internal.
ts-integ: ## TypeScript SDK against a running service: creates, uses and deletes a database
	$(TS) -e EDGEKV_URL -e EDGEKV_CONTROL_URL -e EDGEKV_API_KEY $(NODE_IMAGE) \
	    sh -c "npm install --no-audit --no-fund --loglevel=error && npm run test:integration"
