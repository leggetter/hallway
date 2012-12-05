export GIT_REVISION?=$(shell git rev-parse --short --default HEAD)
# if not provided by Jenkins, then just use the gitrev
export BUILD_NUMBER?=git-$(GIT_REVISION)

.PHONY: deps build build_dev npm_modules npm_modules_dev

all: build
	@echo
	@echo "Looks like everything worked!"
	@echo

# install system level dependencies into deps/
deps:
	./scripts/install-deps deps
	@echo
	@echo "Go ahead and run 'make'"

# check if system level dependencies are installed
check_deps:
	@. scripts/use-deps.sh && \
	if ! ./scripts/install-deps --check-only; then \
		echo Some dependencies are missing.  Try running "make deps" to install them.; \
		exit 1; \
	fi

# Get Hallway ready to run
build: check_deps npm_modules

build_dev: check_deps npm_modules_dev

# install node dependencies via npm
npm_modules:
	@. scripts/use-deps.sh && \
	npm install

npm_modules_dev:
	npm install --dev

migrations:
	@echo "Applying migrations"
	./node_modules/db-migrate/bin/db-migrate -v --config Config/config.json -e database up
.PHONY: migrations

MOCHA = ./node_modules/.bin/mocha
MOCHA_TESTS = $(shell find test -name "*.test.js")
ltest:
	@env CONFIG_PATH="$(shell pwd)/test/resources/config.json" NODE_PATH="lib:test/lib" \
	$(MOCHA) $(MOCHA_TESTS)

test: build_dev ltest

MOCHA_UNIT_TESTS=$(shell find test -name "*.unit.test.js")
unittest: build_dev
	@env CONFIG_PATH="$(shell pwd)/test/resources/config.json" NODE_PATH="lib" \
		$(MOCHA) $(MOCHA_UNIT_TESTS)

_MOCHA=./node_modules/.bin/_mocha
COVER=./node_modules/cover/bin/cover
cov: check_deps npm_modules
	@env NODE_PATH="lib" \
		$(COVER) run $(_MOCHA) $(MOCHA_TESTS)
	$(COVER) report html

SUBDIR=hallway-$(BUILD_NUMBER)
DISTFILE=$(SUBDIR).tar.gz

# create a ready-to-run tarball with a complete build inside
bindist: $(DISTFILE)

$(DISTFILE):
	./scripts/build-tarball "$(SUBDIR)" "$@"

# create a ready-to-run tarball, and then run tests on the contents
test-bindist: $(DISTFILE)
	./scripts/test-tarball "$(SUBDIR)" "$<"

# this is the rule that Jenkins runs as of 2012-04-18
jenkins:
	$(MAKE) test-bindist

clean:
	rm -f "$(DISTFILE)"
	rm -f "hallway-git-*.tar.gz"
	rm -rf node_modules
