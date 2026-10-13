# Everything runs in Docker. No local toolchains are needed.
NODE_IMAGE   ?= node:22-bookworm-slim
PYTHON_IMAGE ?= python:3.12-slim
# From inside a container, the machine running Docker is host.docker.internal.
TS = docker run --rm -v "$(CURDIR)/typescript":/app -v vkesdk-ts-modules:/app/node_modules -w /app \
     --add-host=host.docker.internal:host-gateway
PY = docker run --rm -v "$(CURDIR)/python":/app:ro -w /app -e PYTHONPATH=/app/src -e PYTHONDONTWRITEBYTECODE=1 \
     --add-host=host.docker.internal:host-gateway

.PHONY: help test integ ts-test ts-integ py-test py-integ

help: ## List the commands
	@grep -E '^[a-z-]+:.*##' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  make %-10s %s\n", $$1, $$2}'

test: ts-test py-test ## Every SDK's unit tests (no network)

# The integration targets need a running service and a key that may manage databases:
#   make integ EDGEKV_URL=... EDGEKV_CONTROL_URL=... EDGEKV_API_KEY=ekv_...
integ: ts-integ py-integ ## Every SDK against a running service: creates, uses and deletes databases

ts-test: ## TypeScript SDK: type-check, unit tests and build
	$(TS) $(NODE_IMAGE) sh -c "npm install --no-audit --no-fund --loglevel=error && npm run typecheck && npm test && npm run build"

ts-integ: ## TypeScript SDK against a running service
	$(TS) -e EDGEKV_URL -e EDGEKV_CONTROL_URL -e EDGEKV_API_KEY $(NODE_IMAGE) \
	    sh -c "npm install --no-audit --no-fund --loglevel=error && npm run test:integration"

py-test: ## Python SDK: unit tests, on the oldest and the newest supported Python
	$(PY) python:3.9-slim python -m unittest -v tests.test_unit
	$(PY) $(PYTHON_IMAGE) python -m unittest tests.test_unit

py-integ: ## Python SDK against a running service
	$(PY) -e EDGEKV_URL -e EDGEKV_CONTROL_URL -e EDGEKV_API_KEY $(PYTHON_IMAGE) python -m unittest -v tests.test_integration
