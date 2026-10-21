#!/usr/bin/env bash
# Builds token -> copies wasm into factory/res -> builds factory + vault.
# Output: target/near/<crate>/<crate>.wasm (and contracts/res/*.wasm copies).
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(cd .. && pwd)"
OUT="$ROOT/contracts/res"
mkdir -p "$OUT"

build() {
  local crate="$1"
  if command -v cargo-near >/dev/null 2>&1; then
    (cd "$crate" && cargo near build non-reproducible-wasm --no-abi)
    cp "$ROOT/target/near/${crate//-/_}/${crate//-/_}.wasm" "$OUT/"
  else
    echo "cargo-near not found, falling back to cargo build" >&2
    (cd "$crate" && RUSTFLAGS="-C link-arg=-s -C target-cpu=mvp" \
      cargo build --target wasm32-unknown-unknown --release)
    cp "$ROOT/target/wasm32-unknown-unknown/release/${crate//-/_}.wasm" "$OUT/"
  fi
  echo "built $OUT/${crate//-/_}.wasm ($(wc -c < "$OUT/${crate//-/_}.wasm") bytes)"
}

build near-ft-token
cp "$OUT/near_ft_token.wasm" near-ft-factory/res/near_ft_token.wasm
build near-ft-factory
build near-launch-vault
