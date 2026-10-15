#!/bin/sh
# Builds the native library for Linux on this machine's architecture and puts
# it in its npm package folder. Runs inside a container, from the Makefile and
# from the npm workflow:
#
#   gnu   in rust:1-bookworm, linked against glibc 2.17 with zig, so it loads
#         on any distribution from about 2014 on
#   musl  in rust:1-alpine, for Alpine and other musl distributions
#
# Usage: build-linux.sh gnu|musl   (mounts: /src = native/, /npm = typescript/npm/)
set -eu

libc="${1:?usage: build-linux.sh gnu|musl}"
case "$(uname -m)" in
  x86_64) arch=x64 ;;
  aarch64) arch=arm64 ;;
  *) echo "no build for $(uname -m)" >&2; exit 1 ;;
esac
cpu="$(uname -m)"
suffix="linux-$arch-$libc"
target_dir="${CARGO_TARGET_DIR:-/src/target}"

case "$libc" in
  gnu)
    apt-get update -qq >/dev/null
    apt-get install -y -qq python3-pip >/dev/null
    pip3 install -q --break-system-packages --root-user-action=ignore ziglang==0.13.0.post1 cargo-zigbuild==0.23.4
    cargo zigbuild --release --locked --target "$cpu-unknown-linux-gnu.2.17"
    built="$target_dir/$cpu-unknown-linux-gnu/release/libedgekv_native.so"
    ;;
  musl)
    apk add --no-cache musl-dev >/dev/null
    # A shared library cannot link the C runtime statically.
    RUSTFLAGS="-C target-feature=-crt-static" cargo build --release --locked
    built="$target_dir/release/libedgekv_native.so"
    ;;
  *) echo "libc must be gnu or musl, not $libc" >&2; exit 1 ;;
esac

cp "$built" "/npm/$suffix/edgekv.$suffix.node"
echo "built /npm/$suffix/edgekv.$suffix.node"
