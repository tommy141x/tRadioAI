#!/usr/bin/env bash
# Bundles glibc's loader and the shared libraries the local engines need into the
# resource, so they run on a host whose own libc cannot load them.
#
# WHY THIS EXISTS
#
# Upstream publishes exactly one Linux x64 CPU build of each engine —
# `llama-bNNNNN-bin-ubuntu-x64`, whisper.cpp's ubuntu build, Piper's
# `linux_x86_64` — and all three are glibc-linked. There is no musl asset in any
# of those releases. On a musl host (Alpine, which several FiveM container
# images use) the kernel cannot even find the binary's interpreter,
# `/lib64/ld-linux-x86-64.so.2`, and the exec fails before `main` with a bare
# "No such file or directory" naming the *binary*. That message reads as a
# corrupt or wrong-architecture download and sends the operator looking in
# entirely the wrong place; the same error has cost other projects days.
#
# The fix is to stop relying on the host's interpreter: ship glibc's loader
# inside the resource and run each binary through it with `--library-path`
# pointing at the bundled libraries. tLib's spawn gate builds that argv itself
# the moment it finds `lib/ld-linux-x86-64.so.2` beside an engine, and execs the
# binary directly when it does not — so a release built without this script
# behaves exactly as every release has so far, and one built with it stops
# caring what the host's libc is. The declarations are in tLib's
# `server/lib/spawn/catalog.ts`; this script's only contract with it is the
# directory layout below.
#
# FXServer itself uses this trick for its own glibc-linked components, which is
# the precedent, and it keeps the rule intact: everything stays inside the
# resource, nothing is installed and nothing is fetched at runtime.
#
# RUN THIS ON A GLIBC HOST (Debian/Ubuntu/Fedora), NOT on Alpine: the point is to
# harvest a *glibc* runtime, and harvesting from musl produces a musl one.
#
#   bun run scripts/vendor-local-engine.ts     # first: the engines themselves
#   ./scripts/bundle-linux-libs.sh             # then: all three engines
#   ./scripts/bundle-linux-libs.sh llama       # or one at a time
#
# Pick the oldest glibc you intend to support. A loader harvested from a new
# distribution refuses older *host* kernels, and while glibc is
# forward-compatible it is not backward-compatible.
#
# The result is committed into the resource — `server/bin/` is an opaque tree in
# scripts/runtime-staging.ts, so `lib/` reaches the release zip without any
# policy change — and then tested on a glibc host AND inside an Alpine
# container. Shipping it untested on musl proves nothing: the glibc host worked
# before this script existed.

set -euo pipefail

RESOURCE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENGINES=("$@")
if [[ ${#ENGINES[@]} -eq 0 ]]; then
    ENGINES=(llama whisper piper)
fi

command -v ldd >/dev/null || { echo "ldd not found — run this on a glibc host" >&2; exit 2; }
if ldd --version 2>&1 | grep -qi musl; then
    echo "This is a musl host. Harvesting from here produces a musl runtime, which defeats the purpose." >&2
    exit 2
fi

# One `lib/` per engine, not one shared directory, for the reason
# vendor-local-engine.ts already keeps the engines apart: llama.cpp and
# whisper.cpp both ship a `libggml` built from different revisions, and the
# loser of a shared directory is handed a library it was not linked against.
# Three ~15 MB closures is the price of that not being a possibility.
bundle_engine() {
    local engine="$1"
    local dest="$RESOURCE_ROOT/server/bin/linux/$engine"
    local lib="$dest/lib"

    if [[ ! -d "$dest" ]]; then
        echo "==> $engine: no $dest — run scripts/vendor-local-engine.ts first" >&2
        return 1
    fi

    # Every ELF executable in the engine directory, found by asking `file`
    # rather than by name: a Linux binary has no extension, so a name list is
    # the one thing that silently goes stale when an engine ships a second
    # executable (llama.cpp's llama-bench, whisper's whisper-cli).
    local binaries=()
    local candidate
    for candidate in "$dest"/*; do
        [[ -f "$candidate" && -x "$candidate" ]] || continue
        case "$candidate" in *.so|*.so.*) continue ;; esac
        if head -c 4 "$candidate" | grep -q $'\x7fELF'; then
            binaries+=("$candidate")
        fi
    done
    if [[ ${#binaries[@]} -eq 0 ]]; then
        echo "==> $engine: no executables in $dest" >&2
        return 1
    fi

    echo "==> $engine: ${#binaries[@]} executable(s)"
    mkdir -p "$lib"

    # The engine's OWN shared objects are deliberately NOT copied in here. They
    # already sit beside the binary, and tLib puts that directory on
    # `--library-path` after the bundle precisely so they do not have to be
    # duplicated — ggml alone is 13 dlopen'd CPU backends.
    echo "  resolving the glibc dependency closure"
    declare -A seen=()
    resolve() {
        local target="$1" dep path
        while read -r dep path; do
            [[ -z "$path" || ! -f "$path" ]] && continue
            [[ -n "${seen[$path]:-}" ]] && continue
            seen[$path]=1
            install -m 0755 "$path" "$lib/$(basename "$path")"
            echo "    $(basename "$path")"
            resolve "$path"
        done < <(ldd "$target" 2>/dev/null | awk '/=>/ && $3 ~ /^\// { print $1, $3 }')
    }
    local target
    for target in "${binaries[@]}"; do
        resolve "$target"
    done
    # The engine's own .so files are scanned for dependencies even though they
    # are not copied: ggml's backends link libgomp and libstdc++, which ldd
    # against the executable alone never mentions because they are dlopen'd.
    shopt -s nullglob
    for target in "$dest"/*.so*; do
        resolve "$target"
    done
    shopt -u nullglob

    # Taken from the binary's PT_INTERP rather than guessed, because the path
    # differs between distributions (/lib64 vs /usr/lib64 vs a multiarch
    # directory). It is installed under the ABI name, which is what tLib looks
    # for and the only name it will accept.
    local interp
    interp="$(ldd "${binaries[0]}" | awk '!/=>/ && $1 ~ /ld-linux/ { print $1 }' | head -1)"
    if [[ -z "$interp" ]]; then
        interp="$(patchelf --print-interpreter "${binaries[0]}" 2>/dev/null || true)"
    fi
    if [[ -z "$interp" || ! -f "$interp" ]]; then
        echo "  could not locate the ELF interpreter for ${binaries[0]}" >&2
        return 1
    fi
    install -m 0755 "$interp" "$lib/ld-linux-x86-64.so.2"
    echo "  interpreter: $(basename "$interp") -> lib/ld-linux-x86-64.so.2"

    # Exactly the argv tLib builds, so a bundle that cannot start is found here
    # rather than on a customer's server. `--library-path` must precede the
    # program: it is the loader's option, and anything after the program name
    # belongs to the program.
    echo "  verifying the bundle runs through its own loader"
    local probe
    for probe in "${binaries[@]}"; do
        if "$lib/ld-linux-x86-64.so.2" --library-path "$lib:$dest" "$probe" --help >/dev/null 2>&1 \
            || "$lib/ld-linux-x86-64.so.2" --library-path "$lib:$dest" "$probe" --version >/dev/null 2>&1; then
            echo "    $(basename "$probe"): ok"
        else
            echo "    $(basename "$probe"): the bundled loader could not start it" >&2
            return 1
        fi
    done
}

failed=0
for engine in "${ENGINES[@]}"; do
    bundle_engine "$engine" || failed=1
done

cat <<'NOTES'

Notes that matter for these bundles:

  * local-engine.ts already passes --host 127.0.0.1 and must keep doing so.
    Resolving a hostname goes through NSS, which dlopen()s the *host's*
    libnss_*.so modules into our bundled glibc. Mismatched glibc and NSS modules
    is the classic way this technique crashes; an IP literal avoids NSS
    entirely. tLib's catalog types --host as `loopback`, so this is enforced.

  * Do not bundle libnss_*, libresolv or libgcc_s by hand to "be safe". They are
    the parts most likely to conflict with the host.

  * No locale data is shipped, so the processes run in the C locale. That is
    correct for all three engines and must not be changed by setting LC_ALL.

  * Piper needs espeak-ng-data, which is DATA and not a library: it is already
    shipped beside the binary and passed as --espeak_data. The loader does not
    affect it.

  * Size: roughly 10-15 MB per engine on top of the vendored builds. Still far
    less than one weight.
NOTES

exit "$failed"
