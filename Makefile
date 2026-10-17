# Everything runs in Docker. No local toolchains are needed.
NODE_IMAGE   ?= node:22-bookworm-slim
PYTHON_IMAGE ?= python:3.12-slim
# From inside a container, the machine running Docker is host.docker.internal.
TS = docker run --rm -v "$(CURDIR)/typescript":/app -v vkesdk-ts-modules:/app/node_modules -w /app \
     --add-host=host.docker.internal:host-gateway
PY = docker run --rm -v "$(CURDIR)/python":/app:ro -w /app -e PYTHONPATH=/app/src -e PYTHONDONTWRITEBYTECODE=1 \
     --add-host=host.docker.internal:host-gateway

# The MCP server uses the TypeScript SDK from ../typescript, so both are mounted.
MCP = docker run --rm -v "$(CURDIR)/typescript":/sdk/typescript -v vkesdk-ts-modules:/sdk/typescript/node_modules \
      -v "$(CURDIR)/mcp":/sdk/mcp -v vkesdk-mcp-modules:/sdk/mcp/node_modules -w /sdk/mcp

.PHONY: help test integ ts-test ts-integ py-test py-integ mcp-test native-gnu native-musl native-test

help: ## List the commands
	@grep -E '^[a-z-]+:.*##' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  make %-12s %s\n", $$1, $$2}'

test: ts-test py-test mcp-test ## Every SDK's unit tests, and the MCP server's (no network)

# The integration targets need a running service and a key that may manage databases:
#   make integ EDGEKV_URL=... EDGEKV_CONTROL_URL=... EDGEKV_API_KEY=ekv_...
integ: ts-integ py-integ ## Every SDK against a running service: creates, uses and deletes databases

ts-test: ## TypeScript SDK: type-check, unit tests and build
	$(TS) $(NODE_IMAGE) sh -c "npm install --no-audit --no-fund --loglevel=error && npm run typecheck && npm test && npm run build"

ts-integ: ## TypeScript SDK against a running service
	$(TS) -e EDGEKV_URL -e EDGEKV_CONTROL_URL -e EDGEKV_API_KEY $(NODE_IMAGE) \
	    sh -c "npm install --no-audit --no-fund --loglevel=error && npm run test:integration"

py-test: ## Python SDK: unit tests, on the oldest Python as installed, and the newest with encryption
	$(PY) python:3.9-slim python -m unittest -v tests.test_unit
	$(PY) $(PYTHON_IMAGE) sh -c "pip install --quiet --root-user-action=ignore 'cryptography>=42' && python -m unittest -v tests.test_unit"

mcp-test: ## MCP server: type-check, tests and build, on the TypeScript SDK as it is here
	$(MCP) $(NODE_IMAGE) sh -c "cd ../typescript && npm install --no-audit --no-fund --loglevel=error && npm run build \
	    && cd ../mcp && npm install --no-audit --no-fund --loglevel=error && npm run typecheck && npm test && npm run build"

py-integ: ## Python SDK against a running service
	$(PY) -e EDGEKV_URL -e EDGEKV_CONTROL_URL -e EDGEKV_API_KEY $(PYTHON_IMAGE) \
	    sh -c "pip install --quiet --root-user-action=ignore 'cryptography>=42' && python -m unittest -v tests.test_integration"

# The native library behind the TypeScript SDK's local mode, built for Linux on
# this machine's architecture into typescript/npm/. macOS and Windows builds
# come from the npm workflow (.github/workflows/npm.yml).
NATIVE = docker run --rm -v "$(CURDIR)/native":/src -v "$(CURDIR)/typescript/npm":/npm -w /src \
         -v vkesdk-cargo:/usr/local/cargo/registry -e CARGO_TARGET_DIR=/target

native-gnu: ## Native library for Linux with glibc, into typescript/npm/
	$(NATIVE) -v vkesdk-target-gnu:/target rust:1-bookworm sh build-linux.sh gnu

native-musl: ## Native library for Linux with musl (Alpine), into typescript/npm/
	$(NATIVE) -v vkesdk-target-musl:/target rust:1-alpine sh build-linux.sh musl

native-test: native-gnu native-musl ## Native library: Rust tests, and the local mode on glibc and on musl
	$(NATIVE) -v vkesdk-target-gnu:/target rust:1-bookworm cargo test --locked
	$(TS) $(NODE_IMAGE) sh scripts/test-local.sh
	docker run --rm -v "$(CURDIR)/typescript":/app -v vkesdk-ts-modules-musl:/app/node_modules -w /app \
	    node:22-alpine sh scripts/test-local.sh
