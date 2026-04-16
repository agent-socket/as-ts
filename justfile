default: build

install:
    bun install

build: install
    bun run build

test: install
    bun test

clean:
    rm -rf dist node_modules

echo: install
    bun run echo.ts
