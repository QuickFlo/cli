SHELL := /usr/bin/env bash
.ONESHELL:
.SHELLFLAGS := -eu -o pipefail -c

VERSION := $(shell awk -F'"' '/"version":/ {print $$4; exit}' deno.json)
TAG := v$(VERSION)

.PHONY: help fmt check release tag-only

help:
	@printf 'Targets:\n'
	@printf '  fmt        deno fmt (auto-fix)\n'
	@printf '  check      fmt:check + lint + type check + test\n'
	@printf '  release    require clean main, run check, push, tag %s, push tag\n' '$(TAG)'
	@printf '  tag-only   just create + push tag %s (skip checks; for re-runs)\n' '$(TAG)'

fmt:
	deno task fmt

check:
	deno task fmt:check
	deno task lint
	deno task check
	deno task test

release:
	@[ "$$(git rev-parse --abbrev-ref HEAD)" = "main" ] || { echo "release: must be on main"; exit 1; }
	@[ -z "$$(git status --porcelain)" ] || { echo "release: working tree dirty — commit or stash first"; exit 1; }
	@! git rev-parse '$(TAG)' >/dev/null 2>&1 || { echo "release: tag $(TAG) already exists — bump version in deno.json"; exit 1; }
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
