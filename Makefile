SHELL := /usr/bin/env bash
.ONESHELL:
.SHELLFLAGS := -eu -o pipefail -c

PKG_VERSION := $(shell awk -F'"' '/"version":/ {print $$4; exit}' deno.json)
TAG := v$(PKG_VERSION)

.PHONY: help fmt check bump release tag-only

help:
	@printf 'Current version: %s\n\n' '$(PKG_VERSION)'
	@printf 'Targets:\n'
	@printf '  fmt                     deno fmt (auto-fix)\n'
	@printf '  check                   fmt:check + lint + type check + test\n'
	@printf '  bump VERSION=X.Y.Z      edit deno.json, commit "chore: bump version to X.Y.Z"\n'
	@printf '  release                 require clean main, check, push, tag %s, push tag\n' '$(TAG)'
	@printf '  tag-only                just create + push tag %s (skip checks; for re-runs)\n' '$(TAG)'
	@printf '\nTypical release flow:\n'
	@printf '  make bump VERSION=0.4.0 && make release\n'

fmt:
	deno task fmt

check:
	deno task fmt:check
	deno task lint
	deno task check
	deno task test

bump:
	@[ -n "$(VERSION)" ] || { echo "usage: make bump VERSION=X.Y.Z"; exit 1; }
	@printf '%s' '$(VERSION)' | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([.-].+)?$$' || { echo "bump: VERSION must be semver (got '$(VERSION)')"; exit 1; }
	@[ "$(PKG_VERSION)" != "$(VERSION)" ] || { echo "bump: already at $(VERSION)"; exit 1; }
	@[ -z "$$(git status --porcelain)" ] || { echo "bump: working tree dirty — commit or stash first"; exit 1; }
	@! git rev-parse 'v$(VERSION)' >/dev/null 2>&1 || { echo "bump: tag v$(VERSION) already exists"; exit 1; }
	@printf 'bumping %s -> %s\n' '$(PKG_VERSION)' '$(VERSION)'
	sed -i.bak 's/"version": *"[^"]*"/"version": "$(VERSION)"/' deno.json
	rm deno.json.bak
	git add deno.json
	git commit -m "chore: bump version to $(VERSION)"

release:
	@[ "$$(git rev-parse --abbrev-ref HEAD)" = "main" ] || { echo "release: must be on main"; exit 1; }
	@[ -z "$$(git status --porcelain)" ] || { echo "release: working tree dirty — commit or stash first"; exit 1; }
	@! git rev-parse '$(TAG)' >/dev/null 2>&1 || { echo "release: tag $(TAG) already exists — run 'make bump VERSION=X.Y.Z' first"; exit 1; }
	$(MAKE) check
	git pull --rebase
	git push
	git tag '$(TAG)'
	git push origin '$(TAG)'
	@printf '\nTagged %s. Watch: gh run watch\n' '$(TAG)'

tag-only:
	@! git rev-parse '$(TAG)' >/dev/null 2>&1 || { echo "tag-only: tag $(TAG) already exists"; exit 1; }
	git tag '$(TAG)'
	git push origin '$(TAG)'
