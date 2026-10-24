#!/usr/bin/env bash
# Shared codesigning resolution for the suite's build scripts.
#
# Certificate-agnostic by design. Every contributor's keychain is different, and
# plenty have no Apple certificate at all, so nothing here hardcodes an
# identity, a team or an Apple ID: both the identity and the team it belongs to
# are read from whatever happens to be installed locally, and a machine with no
# certificate still produces a working ad-hoc signed bundle.
#
# Source it, don't execute it:
#   . "$REPO_ROOT/tools/signing.sh"

signing_warn() { printf '\033[1;33m⚠ %s\033[0m\n' "$1" >&2; }

# Common names of every valid codesigning identity in the keychain.
_signing_identities() {
    security find-identity -v -p codesigning 2>/dev/null |
        sed -n 's/^[[:space:]]*[0-9]*)[[:space:]]*[0-9A-F]*[[:space:]]*"\(.*\)"$/\1/p'
}

signing_identity_exists() {
    [ -n "${1:-}" ] || return 1
    _signing_identities | grep -Fxq "$1"
}

# resolve_signing_identity [override]
#
# Echoes the identity to sign with, or "-" for ad-hoc.
#
# An override is honoured only when it names an identity that actually exists.
# Taking it on trust is what makes a missing certificate so hard to diagnose:
# the build sails through identity resolution, announces the name it was given,
# and then dies minutes later inside codesign with an error that mentions
# neither the variable that supplied the name nor the fact that it was a guess.
resolve_signing_identity() {
    local override="${1:-}" prefix found

    if [ "$override" = "-" ] || [ "${MAGIC_SUITE_ALLOW_ADHOC:-0}" = "1" ]; then
        printf '%s\n' "-"
        return 0
    fi

    if [ -n "$override" ]; then
        if signing_identity_exists "$override"; then
            printf '%s\n' "$override"
            return 0
        fi
        signing_warn "No signing identity named \"$override\" is in the keychain."
        signing_warn "Ignoring it and auto-detecting instead; \`security find-identity -v -p codesigning\` lists what you have."
    fi

    # Distribution certificates first, then development, then nothing. A
    # Developer ID build opens on other Macs once notarized; the rest are only
    # good on the machine that built them, which is still the common case.
    for prefix in "Developer ID Application:" "Apple Distribution:" "Apple Development:" "Mac Developer:"; do
        found="$(_signing_identities | grep -F "$prefix" | head -1)"
        if [ -n "$found" ]; then
            printf '%s\n' "$found"
            return 0
        fi
    done

    printf '%s\n' "-"
}

# resolve_release_identity [override]
#
# Echoes the Developer ID Application identity a release must be signed with, or
# nothing when the keychain has none. Deliberately not resolve_signing_identity:
# a release does not fall back to a certificate that only works on this Mac. See
# docs/shared/building-and-signing.md.
resolve_release_identity() {
    local override="${1:-}" found

    if [ "$override" = "-" ] || [ "${MAGIC_SUITE_ALLOW_ADHOC:-0}" = "1" ]; then
        printf '%s\n' "-"
        return 0
    fi

    if [ -n "$override" ]; then
        case "$override" in
        "Developer ID Application:"*) ;;
        *)
            signing_warn "\"$override\" is not a Developer ID Application certificate; a release is signed with nothing else."
            override=""
            ;;
        esac
    fi
    if [ -n "$override" ]; then
        if signing_identity_exists "$override"; then
            printf '%s\n' "$override"
            return 0
        fi
        signing_warn "No signing identity named \"$override\" is in the keychain."
        signing_warn "Ignoring it and auto-detecting instead; \`security find-identity -v -p codesigning\` lists what you have."
    fi

    found="$(_signing_identities | grep -F "Developer ID Application:" | head -1)"
    printf '%s\n' "$found"
}

# resolve_team_id <identity>
#
# Echoes the Apple Team ID the identity belongs to, or nothing when it cannot be
# determined (an ad-hoc build, or a certificate without an OU).
#
# The team is the OU of the certificate's subject. The parenthesised code in the
# common name looks like a team ID and is not one — for
# "Apple Development: someone@example.com (ABC123XYZ0)" with OU=TEAMID1234, the
# team is TEAMID1234 and ABC123XYZ0 identifies the certificate itself.
resolve_team_id() {
    local identity="${1:-}" ou
    if [ -z "$identity" ] || [ "$identity" = "-" ]; then
        return 0
    fi
    ou="$(security find-certificate -c "$identity" -p 2>/dev/null |
        openssl x509 -noout -subject 2>/dev/null |
        sed -n 's/.*OU[[:space:]]*=[[:space:]]*\([^,/]*\).*/\1/p' | head -1)"
    printf '%s\n' "${ou//[[:space:]]/}"
}

# sign_hardened <identity> <path> [extra codesign args...]
#
# Signs with the hardened runtime and a secure timestamp.
#
# Notarisation requires both of every Mach-O in the bundle, nested ones
# included. A single binary without flags=0x10000(runtime) is refused, and the
# rejection names the requirement rather than the file, so the cheapest way to
# keep it true is for nothing to call codesign without going through here.
#
# --timestamp needs the network and a real certificate. Under `--sign -`
# codesign ignores it instead of failing, so an ad-hoc build needs no separate
# path; offline with a certificate it does fail, which is better than quietly
# producing a bundle Apple would reject.
sign_hardened() {
    local identity="$1" path="$2"
    shift 2
    codesign --force --sign "$identity" --options runtime --timestamp "$@" "$path"
}

# stamp_bundle_version <info-plist-path> <version> [build]
#
# Sets CFBundleShortVersionString to the marketing version and CFBundleVersion to a
# build number, which defaults to seconds since the epoch.
#
# The two carry different values on purpose. macOS decides an extension bundle has
# changed by its CFBundleVersion: chronod re-reads a widget's descriptor only when
# that number moves, and the system otherwise keeps an extension process warm across
# an install. The marketing version cannot do that job, because it moves at a release
# and every build between two releases shares it. Stamping it into both fields left a
# rebuilt extension indistinguishable from the one before, so a widget that gained a
# configuration intent was still offered as one taking none, with no Edit Widget item
# and CHSErrorDomain 1103 on every reload, and a rebuilt App Intents extension went on
# answering from the old binary.
#
# A build number only has to differ from the last one, so the clock is enough, and it
# is monotonic, which keeps a later build looking later. Two builds of one commit
# therefore differ. Nothing reads the value back; it detects change rather than naming
# a version.
stamp_bundle_version() {
    local plist="$1" version="$2" build="${3:-$(date +%s)}"
    plutil -replace CFBundleShortVersionString -string "$version" "$plist"
    plutil -replace CFBundleVersion -string "$build" "$plist"
}

# prepare_entitlements <source-plist> <dest-plist> [team-id]
#
# Writes a copy of the entitlements with the <TEAM_ID> placeholder resolved.
#
# Always to a separate destination, never in place: substituting into the
# tracked plist and restoring it afterwards leaves a resolved team ID committed
# in the repository on any run that dies before the restore, which is precisely
# the hardcoding the placeholder exists to avoid.
#
# With no team ID the App Group entitlement is dropped rather than left dangling.
# An App Group identifier is prefixed with the team ID, and an ad-hoc signature
# carries none, so a bundle claiming the group is rejected and fails to launch.
prepare_entitlements() {
    local src="$1" dst="$2" team="${3:-}"
    mkdir -p "$(dirname "$dst")"
    if [ -n "$team" ]; then
        sed "s/<TEAM_ID>/$team/g" "$src" >"$dst"
    else
        sed '/<key>com.apple.security.application-groups<\/key>/,/<\/array>/d' "$src" >"$dst"
    fi
}

# ensure_xcode [what]
#
# Points DEVELOPER_DIR at a full Xcode, returning non-zero if there isn't one.
#
# xcodebuild ships only with Xcode proper, and xcode-select may well be pointing
# at the Command Line Tools, which has no xcodebuild at all. Honour whatever
# xcode-select says before falling back to the default install path — hardcoding
# /Applications/Xcode.app breaks every machine that keeps Xcode anywhere else.
ensure_xcode() {
    local what="${1:-this target}"
    local dev
    dev="$(xcode-select -p 2>/dev/null || true)"
    if [ -n "$dev" ] && [ -x "$dev/usr/bin/xcodebuild" ]; then
        export DEVELOPER_DIR="$dev"
        return 0
    fi
    if [ -x "/Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild" ]; then
        export DEVELOPER_DIR="/Applications/Xcode.app/Contents/Developer"
        return 0
    fi
    echo "error: $what needs a full Xcode (xcodebuild), but none was found." >&2
    echo "       Install Xcode, then: sudo xcode-select -s /Applications/Xcode.app" >&2
    return 1
}

# assert_signing_identity <identity> <what> [consequence]
#
# Stops the build unless <identity> is a real certificate.
#
# macOS validates every app extension against the app containing it and refuses
# to load one whose team differs. An ad-hoc signature has no team at all, so the
# rule is not that some particular extension misbehaves; it is that no .appex
# loads. For Magimail that is the Share Sheet entry, the widgets and the Focus
# Filter, all three, together.
#
# The Swift helper is not an extension and does run, but notification
# authorisation is tied to a stable signature, and an ad-hoc one changes on
# every rebuild, so granted permissions are not kept.
#
# An ad-hoc build is therefore not a lesser version of the app. It is a bundle
# that looks built and is quietly inert, reporting nothing wrong at build time
# and nothing at launch. That is the failure the artefact check in build-app.sh
# already exists to prevent, so it is refused just as firmly.
#
# --adhoc sets MAGIC_SUITE_ALLOW_ADHOC for the scripts it shells out to, so
# building one deliberately stays possible for anyone who wants to run the
# Electron side without an Apple account.
assert_signing_identity() {
    local identity="${1:-}" what="${2:-this bundle}"
    local consequence="${3:-it will not load}"
    if [ "$identity" != "-" ] && [ -n "$identity" ]; then
        return 0
    fi
    if [ "${MAGIC_SUITE_ALLOW_ADHOC:-0}" = "1" ]; then
        signing_warn "Ad-hoc signing $what: $consequence."
        return 0
    fi
    printf '\033[1;31m✗ No Apple signing certificate found, so %s cannot be built properly.\033[0m\n' "$what" >&2
    printf '  Signed ad-hoc, %s.\n\n' "$consequence" >&2
    cat >&2 <<'EOF'
  macOS refuses to load an app extension whose team differs from the app
  containing it, and an ad-hoc signature has no team, so no .appex loads at all.

  To get a certificate: Xcode → Settings → Accounts → select your team →
  Manage Certificates… → + → Apple Development. Generate it on this Mac so the
  private key is created here; a .cer downloaded from developer.apple.com
  against a CSR made elsewhere installs without its key and will not work.

  Check what you have with:  security find-identity -v -p codesigning
  To build a deliberately partial bundle anyway, pass --adhoc.
EOF
    exit 1
}

# assert_release_identity <identity> <app>
#
# Stops a release unless <identity> is a Developer ID Application certificate.
# --adhoc still escapes, so the packaging path can be exercised without an Apple
# account.
assert_release_identity() {
    local identity="${1:-}" app="${2:-this app}"

    case "${identity:-}" in
    "Developer ID Application:"*) return 0 ;;
    esac

    if [ "${MAGIC_SUITE_ALLOW_ADHOC:-0}" = "1" ]; then
        signing_warn "Ad-hoc signing a release of $app: it will not open on any other Mac."
        return 0
    fi

    printf '\033[1;31m✗ Releasing %s needs a Developer ID Application certificate.\033[0m\n' "$app" >&2
    cat >&2 <<'EOF'
  A release opens on a Mac that has never seen the certificate, where only
  Developer ID is accepted; Apple Development, Apple Distribution and an ad-hoc
  signature all fail there.

  Enrol in the Apple Developer Program, then make the certificate on this Mac so
  its private key stays here: Xcode → Settings → Accounts → select your team →
  Manage Certificates… → + → Developer ID Application.

  Check what you have with:  security find-identity -v -p codesigning
  See docs/shared/building-and-signing.md. To exercise the packaging path
  without it, pass --adhoc.
EOF
    exit 1
}

# compile_only
#
# True when the caller wants nothing but a compile, set by MAGIC_SUITE_COMPILE_ONLY=1.
#
# Continuous integration asks one question of an extension: does it still build?
# Everything the build scripts do after the compile answers a different one.
# Stamping the bundle version needs node, and resolving a team and codesigning
# need a certificate in an unlocked keychain, which a runner checking a pull
# request has no business holding. None of it says anything about the source
# that just compiled, so CI stops at the compile and the .appex it leaves behind
# is not a bundle anyone should install.
compile_only() { [ "${MAGIC_SUITE_COMPILE_ONLY:-0}" = "1" ]; }
