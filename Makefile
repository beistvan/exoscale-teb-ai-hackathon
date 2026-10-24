IMAGE ?= greenops-webapp
CONTAINER ?= greenops-webapp
PORT ?= 3005
STARTER ?= greenops-challenge-starter-kit
STARTER_IMAGE ?= ghcr.io/exogmi/greenops-challenge-starter-kit:latest

.DEFAULT_GOAL := help

.PHONY: help build run stop logs ps shell clean rebuild creds status starter demo dashboard attempt attempt-dry mock cleanup-run

help:
	@echo "GreenOps webapp in Docker (deps live inside the image, host needs nothing):"
	@echo "  make build     build the image"
	@echo "  make run       build (if needed) and start the container on :$(PORT)"
	@echo "  make stop      stop the container"
	@echo "  make logs      follow container logs"
	@echo "  make ps        show container status"
	@echo "  make shell     open a shell inside the running container"
	@echo "  make rebuild   stop + build + run"
	@echo "  make clean     remove container and image"
	@echo ""
	@echo "Challenge run (the app cannot start a run — it is read-only):"
	@echo "  make creds     generate greenops-exo.json for the starter kit (from .env)"
	@echo "  make status    read-only status of the run (node only, no deps)"
	@echo "  make starter   clone the official starter kit (once)"
	@echo "  make demo      run the official 2-workload demo — STARTS THE CLOCK (use a fresh run)"
	@echo "  make attempt   run the 15-workload carbon-aware orchestrator (starts the clock)"
	@echo "  make attempt-dry  plan-only preview against the current .env run (safe, no writes)"
	@echo "  make mock      offline mock run of the live controller (no credentials, no API)"
	@echo "  make cleanup-run  delete this controller's VMs via the receipt (after a run)"
	@echo "  make dashboard print the monitor + challenge dashboard URLs"

build:
	docker build -t $(IMAGE) .

.env:
	test -f .env || cp .env.example .env

# print the host port the greenops-webapp container actually publishes (container:8080 -> host:PORT)
realport = $(shell docker port $(CONTAINER) 8080/tcp 2>/dev/null | head -1 | sed 's/.*:\([0-9][0-9]*\).*/\1/')

run: build .env
	@if docker ps -q --filter name=^$(CONTAINER)$$ | grep -q .; then \
		echo "$(CONTAINER) already running — URL: http://localhost:$(or $(realport),$(PORT))/"; \
	else \
		docker rm -f $(CONTAINER) 2>/dev/null || true; \
		HPORT=$$(p=$(PORT); while :; do \
			if docker ps -a --format '{{.Ports}}' | grep -q "0\.0\.0\.0:$$p->" || ss -ltn 2>/dev/null | grep -q ":$$p "; then p=$$((p+1)); else break; fi; done; echo $$p); \
		docker run -d --name $(CONTAINER) -p $$HPORT:8080 --env-file .env $(IMAGE); \
		if [ "$$HPORT" != "$(PORT)" ]; then echo "$(PORT) busy — "; fi; \
		echo "$(CONTAINER) started — URL: http://localhost:$$HPORT/"; \
	fi

stop:
	docker rm -f $(CONTAINER) 2>/dev/null || true

logs:
	docker logs -f $(CONTAINER)

ps:
	docker ps --filter name=^$(CONTAINER)$$ --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'

shell:
	docker exec -it $(CONTAINER) sh

rebuild: stop build run

creds: .env
	node scripts/make-creds.mjs

status:
	node scripts/greenops-status.mjs

starter:
	@test -d $(STARTER) || git clone --depth 1 https://github.com/exogmi/greenops-challenge-starter-kit.git $(STARTER)
	@echo "starter kit ready in ./$(STARTER)"

demo: starter
	@test -f greenops-exo.json || { echo "greenops-exo.json missing — run: make creds"; exit 1; }
	docker run --rm -i -v "$(CURDIR)/$(STARTER):/workspace" -w /workspace \
		-v "$(CURDIR)/greenops-exo.json:/workspace/greenops-exo.json" \
		$(STARTER_IMAGE) python3 examples/python/static.py run --config greenops-exo.json

attempt: .env
	@test -f .env || { echo ".env missing — copy credentials first"; exit 1; }
	docker run --rm -t -v "$(CURDIR):/app" -w /app --env-file .env \
		$(IMAGE) bun scripts/orchestrator.mjs

attempt-dry: .env
	docker run --rm -t -v "$(CURDIR):/app" -w /app --env-file .env \
		$(IMAGE) bun scripts/orchestrator.mjs --dry

mock:
	docker run --rm -t -v "$(CURDIR):/app" -w /app $(IMAGE) bun scripts/greenops/mock.mjs 20 --lat 3000

probe-score: .env
	@test -f .env || { echo ".env missing — copy credentials first"; exit 1; }
	docker run --rm -t -v "$(CURDIR):/app" -w /app --env-file .env \
		$(IMAGE) bun scripts/probe-score.mjs

probe-timeline: .env
	@test -f .env || { echo ".env missing — copy credentials first"; exit 1; }
	docker run --rm -t -v "$(CURDIR):/app" -w /app --env-file .env \
		$(IMAGE) bun scripts/probe-timeline.mjs

cleanup-run: .env
	@test -f greenops-orchestrator-state.json || { echo "no receipt — nothing to clean"; exit 1; }
	docker run --rm -v "$(CURDIR):/app" -w /app --env-file .env \
		$(IMAGE) bun scripts/orchestrator.mjs destroy

dashboard:
	@echo "Monitor:          http://localhost:$(or $(realport),$(PORT))/"
	@echo "Challenge board:  https://greenops.containerstack.net/app/runs"

clean:
	docker rm -f $(CONTAINER) 2>/dev/null || true
	docker rmi -f $(IMAGE) 2>/dev/null || true
