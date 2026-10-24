#!/usr/bin/env bash
# Shared String Catalog compilation for the suite's build scripts.
#
# A .xcstrings is a source file, not a resource macOS reads. A bundle that ships
# the catalog uncompiled reads none of it and silently falls back to the English
# keys it was written against, which is why every target that ships one has to
# compile it. An Xcode target does that from its Resources phase for free; the
# App Intents extensions have no Xcode target and are built by a bare `swiftc`
# invocation, so they call `compile_string_catalog` instead of repeating the
# step in each build.sh.
#
# Source it, don't execute it:
#   . "$REPO_ROOT/tools/localization.sh"

# compile_string_catalog <xcstrings> <resources-dir>
#
# Writes `<resources-dir>/<language>.lproj/Localizable.strings` and, when the
# catalog carries plural variations, the matching `.stringsdict` — the same
# two files Xcode's Resources phase produces.
#
# Uses `xcstringstool`, which ships with a full Xcode rather than the Command
# Line Tools. `ensure_xcode` in signing.sh is what makes it findable; call that
# first, so a missing Xcode is reported as such rather than as a failed lookup.
compile_string_catalog() {
    local catalog="$1" resources="$2"

    if [ ! -f "$catalog" ]; then
        echo "error: no String Catalog at $catalog" >&2
        return 1
    fi

    xcrun xcstringstool compile "$catalog" --output-directory "$resources"
}
