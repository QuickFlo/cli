SHELL := /usr/bin/env bash
.ONESHELL:
.SHELLFLAGS := -eu -o pipefail -c

PKG_VERSION := $(shell awk -F'"' '/"version":/ {print $$4; exit}' deno.json)
TAG := v$(PKG_VERSION)

# bump target accepts v=X.Y.Z (short) or VERSION=X.Y.Z
NEW_VERSION := $(or $(v),$(NEW_VERSION))

.PHONY: help fmt check bump release tag-only deploy

help:
	@printf 'Current version: %s\n\n' '$(PKG_VERSION)'
	@printf 'Targets:\n'
	@printf '  fmt                     deno fmt (auto-fix)\n'
	@printf '  check                   fmt:check + lint + type check + test\n'
	@printf '  bump v=X.Y.Z            edit deno.json, commit "chore: bump version to X.Y.Z"\n'
	@printf '  release                 clean main + check + push + tag %s + JSR (via Actions) + GCS binaries\n' '$(TAG)'
	@printf '  tag-only                create + push tag %s + GCS binaries (skip checks; for re-runs)\n' '$(TAG)'
	@printf '  deploy                  build cross-platform binaries and upload to GCS only\n'
	@printf '\nTypical release flow:\n'
	@printf '  make bump v=0.4.0 && make release\n'

fmt:
	deno task fmt

check:
	deno task fmt:check
	deno task lint
	deno task check
	deno task test

bump:
	@[ -n "$(NEW_VERSION)" ] || { echo "usage: make bump v=X.Y.Z"; exit 1; }
	@printf '%s' '$(NEW_VERSION)' | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([.-].+)?$$' || { echo "bump: version must be semver (got '$(NEW_VERSION)')"; exit 1; }
	@[ "$(PKG_VERSION)" != "$(NEW_VERSION)" ] || { echo "bump: already at $(NEW_VERSION)"; exit 1; }
	@[ -z "$$(git status --porcelain)" ] || { echo "bump: working tree dirty — commit or stash first"; exit 1; }
	@! git rev-parse 'v$(NEW_VERSION)' >/dev/null 2>&1 || { echo "bump: tag v$(NEW_VERSION) already exists"; exit 1; }
	@printf 'bumping %s -> %s\n' '$(PKG_VERSION)' '$(NEW_VERSION)'
	sed -i.bak 's/"version": *"[^"]*"/"version": "$(NEW_VERSION)"/' deno.json
	rm deno.json.bak
	git add deno.json
	git commit -m "chore: bump version to $(NEW_VERSION)"

release:
	@[ "$$(git rev-parse --abbrev-ref HEAD)" = "main" ] || { echo "release: must be on main"; exit 1; }
	@[ -z "$$(git status --porcelain)" ] || { echo "release: working tree dirty — commit or stash first"; exit 1; }
	@! git rev-parse '$(TAG)' >/dev/null 2>&1 || { echo "release: tag $(TAG) already exists — run 'make bump VERSION=X.Y.Z' first"; exit 1; }
	$(MAKE) check
	git pull --rebase
	git push
	git tag '$(TAG)'
	git push origin '$(TAG)'
	@printf '\nTagged %s. JSR publish running on Actions; uploading GCS binaries now...\n' '$(TAG)'
	$(MAKE) deploy
	@printf '\n✓ %s released to JSR + GCS.\n' '$(TAG)'

tag-only:
	@! git rev-parse '$(TAG)' >/dev/null 2>&1 || { echo "tag-only: tag $(TAG) already exists"; exit 1; }
	git tag '$(TAG)'
	git push origin '$(TAG)'
	$(MAKE) deploy

deploy:
	bash scripts/deploy.sh
