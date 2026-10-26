#!/usr/bin/env bash
# Shared release machinery for the suite's apps.
#
# Both apps release the same way — derive a version, stamp it, build, notarise,
# upload, tag, publish — and differ only in their name, their update host and
# their bucket. That difference is three variables, not two copies of this file,
# so the per-app scripts set them and call release_main.
#
# Source it, don't execute it, exactly as tools/signing.sh is sourced:
#   RELEASE_APP_ID=magimail
#   RELEASE_APP_NAME=Magimail
#   RELEASE_ENV_PREFIX=MAGIMAIL
#   . "$REPO_ROOT/tools/release.sh"
#   release_main "$@"
#
# Tags are per app: magimail-v1.2.0, magical-v0.3.0. A bare v1.2.0 cannot name
# two apps that version independently, and they do.
#
# Releases are run on the Mac holding the Developer ID certificate and the
# notarisation credentials: notarytool reads its keychain profile and the AWS CLI
# reads its local profile.

# --- Output formatting ---
step() { printf '\n\033[1;34m▸ %s\033[0m\n' "$1"; }
warn() { printf '\033[1;33m⚠ %s\033[0m\n' "$1" >&2; }
die() {
    printf '\033[1;31m✗ %s\033[0m\n' "$1" >&2
    exit 1
}
ok() { printf '\033[1;32m✓ %s\033[0m\n' "$1"; }

release_usage() {
    cat <<EOF
Create a release of $RELEASE_APP_NAME.

Usage:
  ./scripts/release.sh [auto|patch|minor|major|<version>]
                          Work out version, create tag, build, notarise, and publish.
  ./scripts/release.sh --dry-run
                          Validate git state, calculate version, check config, then stop.

Options:
  --dry-run               Validate git state, calculate the version, check config, then stop
  --tag                   Create and push the release tag only, then stop
  --yes, -y               Skip the interactive confirmation
  --skip-build            Skip build-app.sh
  --skip-notarize         Skip notarytool and stapler
  --skip-upload           Skip the bucket upload
  --skip-github-release   Skip creating the GitHub Release
  --bucket <name>         Override the R2 bucket (e.g. magic-apps-releases)
  -h, --help              Show this message

Configuration comes from the environment; a --dry-run needs none of it:
  R2_ACCOUNT_ID           Names the S3 endpoint the upload writes to
  R2_BUCKET               Shared by both apps; each writes under its own prefix
  R2_ACCESS_KEY_ID        An R2 API token, scoped to object read and write
  R2_SECRET_ACCESS_KEY

The public update URL is not configured here. It is publish.url in
apps/${RELEASE_APP_ID}/electron-builder.json, which is what the build bakes
into the bundle, and this script reads it back from there.
EOF
}

release_parse_args() {
    VERSION_INPUT="auto"
    DRY_RUN=0
    CONFIRM=1
    SKIP_BUILD=0
    SKIP_NOTARIZE=0
    TAG_ONLY=0
    SKIP_UPLOAD=0
    SKIP_GH_RELEASE=0
    CLI_BUCKET=""

    # On a runner the checkout is already at the ref being released, and on a
    # tag push HEAD is the tag rather than main. Both make the local "switch to
    # main and pull" dance wrong, so the git gatekeeping asserts instead of
    # moving.
    CI_MODE=0
    if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
        CI_MODE=1
        CONFIRM=0
    fi

    while [ $# -gt 0 ]; do
        case "$1" in
        auto | patch | minor | major | [0-9]*) VERSION_INPUT="$1" ;;
        v[0-9]*) VERSION_INPUT="${1#v}" ;;
        --dry-run)
            DRY_RUN=1
            CONFIRM=0
            ;;
        --yes | -y) CONFIRM=0 ;;
        --skip-build) SKIP_BUILD=1 ;;
        --skip-notarize) SKIP_NOTARIZE=1 ;;
        --tag) TAG_ONLY=1 ;;
        --skip-upload) SKIP_UPLOAD=1 ;;
        --skip-github-release) SKIP_GH_RELEASE=1 ;;
        --bucket)
            CLI_BUCKET="${2:?--bucket requires an R2 bucket name}"
            shift
            ;;
        -h | --help)
            release_usage
            exit 0
            ;;
        *) die "Unknown option: $1 (try --help)" ;;
        esac
        shift
    done
}

# The notarytool profile holding the App Store Connect API key, stored once on
# the release machine with `store-credentials`. See
# docs/shared/building-and-signing.md.
NOTARYTOOL_PROFILE="magic-apps-notary"

# A CLI flag beats the environment. Everything else is read straight from it.
release_load_config() {
    if [ -f "$REPO_ROOT/.env.release" ]; then
        # shellcheck disable=SC1090
        . "$REPO_ROOT/.env.release"
    fi

    R2_BUCKET="${CLI_BUCKET:-${R2_BUCKET:-magic-apps-releases}}"

    # The URL the release notes advertise has to be the URL the installed app
    # updates from, and electron-builder bakes publish.url into the bundle as
    # app-update.yml. Reading it back from there rather than keeping a second
    # copy is what stops a release offering downloads on one host while the
    # updater polls another.
    UPDATE_URL="$(node -p "require('$APP_DIR/electron-builder.json').publish?.url ?? ''")"
    [ -n "$UPDATE_URL" ] ||
        die "apps/$RELEASE_APP_ID/electron-builder.json has no publish.url to release against."
    UPDATE_URL="${UPDATE_URL%/}"

    # Both apps share one bucket and write under a prefix each. The prefix has
    # to appear in the update URL too: electron-updater's generic provider
    # reads <url>/latest-mac.yml, so two apps published at one bucket root
    # would share a manifest and each release would offer the other app's
    # build as an update.
    BUCKET_PREFIX="$RELEASE_APP_ID"

    # R2 speaks the S3 API, so the AWS CLI drives it unchanged apart from the
    # endpoint. R2 has no regions, and "auto" is the value it expects.
    AWS_CMD=(aws --endpoint-url "https://${R2_ACCOUNT_ID:-}.r2.cloudflarestorage.com" --region auto)

    # Checked here rather than at the upload, which runs after twenty minutes
    # of building and notarising. A missing key should stop the release before
    # it compiles anything.
    if [ "$SKIP_UPLOAD" = "0" ] && [ "$DRY_RUN" = "0" ] && [ "$TAG_ONLY" = "0" ]; then
        [ -n "${R2_ACCOUNT_ID:-}" ] || die "R2_ACCOUNT_ID is not set."
        [ -n "${R2_ACCESS_KEY_ID:-}" ] || die "R2_ACCESS_KEY_ID is not set."
        [ -n "${R2_SECRET_ACCESS_KEY:-}" ] || die "R2_SECRET_ACCESS_KEY is not set."
    fi
}

release_verify_git() {
    step "Verifying Git state"
    cd "$REPO_ROOT"

    if [ -n "$(git status --porcelain)" ]; then
        die "Working tree is dirty. Commit, stash or discard changes before releasing."
    fi
    ok "Working tree is clean"

    GIT_REMOTE="${GIT_REMOTE:-$(git remote | grep -E '^(origin|original)$' | head -1 || echo "origin")}"

    step "Fetching $GIT_REMOTE/main and tags"
    git fetch "$GIT_REMOTE" main --tags --quiet
    ok "Remote refs fetched"

    if [ "$CI_MODE" = "1" ]; then
        # Release whatever the runner checked out, having first proved it is on
        # main. A tag pointing off main is the one thing this must never build:
        # customers would be served a bundle from a commit nobody reviewed.
        TARGET_COMMIT="$(git rev-parse HEAD)"
        if ! git merge-base --is-ancestor "$TARGET_COMMIT" "$GIT_REMOTE/main"; then
            die "HEAD ($(git rev-parse --short HEAD)) is not an ancestor of $GIT_REMOTE/main. Releases come only from main."
        fi
        ok "Releasing $(git rev-parse --short "$TARGET_COMMIT"), confirmed on main"
        return 0
    fi

    local current_branch
    current_branch="$(git rev-parse --abbrev-ref HEAD)"
    TARGET_COMMIT="$(git rev-parse "$GIT_REMOTE/main")"

    if [ "$current_branch" != "main" ]; then
        if [ "$DRY_RUN" = "1" ]; then
            warn "Currently on branch '$current_branch' (dry run: would switch to 'main')"
        else
            git checkout main --quiet 2>/dev/null ||
                die "Cannot checkout 'main' (is it checked out in another worktree?). Releases run from 'main'."
            current_branch="main"
        fi
    fi

    if [ "$current_branch" = "main" ]; then
        if [ "$(git rev-parse HEAD)" != "$TARGET_COMMIT" ]; then
            if [ "$DRY_RUN" = "1" ]; then
                warn "Local main differs from $GIT_REMOTE/main. The dry run uses $GIT_REMOTE/main."
            else
                echo "Fast-forwarding local main to $GIT_REMOTE/main..."
                git pull --ff-only "$GIT_REMOTE" main
            fi
        fi
        ok "On main at commit $(git rev-parse --short "$TARGET_COMMIT")"
    fi
}

release_resolve_version() {
    step "Calculating release version"

    # A tag push already carries the version, and the tag already exists, so
    # there is nothing to derive and nothing to create. Deriving one anyway
    # would let the workflow build a version the tag does not name.
    TAG_ALREADY_PUSHED=0
    local describe=(git describe --tags --abbrev=0 --match "${RELEASE_APP_ID}-v[0-9]*")
    if [ "${GITHUB_REF_TYPE:-}" = "tag" ]; then
        TAG_ALREADY_PUSHED=1
        # The runner is only here because a human pushed a tag, so the tag is
        # the whole input. Refuse anything that does not name this app and a
        # semver before taking a version out of it.
        [[ "$GITHUB_REF_NAME" =~ ^${RELEASE_APP_ID}-v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] ||
            die "Tag '$GITHUB_REF_NAME' is not ${RELEASE_APP_ID}-vX.Y.Z."
        VERSION_INPUT="${GITHUB_REF_NAME#"${RELEASE_APP_ID}"-v}"
        # HEAD is the release tag, so it would otherwise describe as its own predecessor.
        describe+=(--exclude "$GITHUB_REF_NAME")
        echo "Triggered by tag $GITHUB_REF_NAME; taking the version from it."
    fi

    LATEST_TAG="$("${describe[@]}" 2>/dev/null || echo "")"
    local base_version
    if [ -z "$LATEST_TAG" ]; then
        base_version="0.0.0"
        COMMITS="$(git log "$TARGET_COMMIT" --oneline -n 50)"
        echo "No existing $RELEASE_APP_NAME tags. Baseline version: 0.0.0"
    else
        base_version="${LATEST_TAG#"${RELEASE_APP_ID}"-v}"
        COMMITS="$(git log "$LATEST_TAG..$TARGET_COMMIT" --oneline)"
        echo "Latest tagged release: $LATEST_TAG"
    fi

    local major minor patch
    IFS='.' read -r major minor patch <<<"${base_version%%-*}"
    major="${major:-0}"
    minor="${minor:-0}"
    patch="${patch:-0}"

    case "$VERSION_INPUT" in
    auto)
        [ -n "$COMMITS" ] || die "No commits on main since ${LATEST_TAG:-the initial commit}. Nothing to release."
        local bump
        if echo "$COMMITS" | grep -Eq '^[a-f0-9]+ (.*!:|.*BREAKING CHANGE)'; then
            bump=major
            major=$((major + 1))
            minor=0
            patch=0
        elif echo "$COMMITS" | grep -Eq '^[a-f0-9]+ feat(\(.*\))?:'; then
            bump=minor
            minor=$((minor + 1))
            patch=0
        else
            bump=patch
            patch=$((patch + 1))
        fi
        TARGET_VERSION="${major}.${minor}.${patch}"
        echo "Detected bump type from commits: $bump"
        ;;
    major)
        TARGET_VERSION="$((major + 1)).0.0"
        ;;
    minor)
        TARGET_VERSION="${major}.$((minor + 1)).0"
        ;;
    patch)
        TARGET_VERSION="${major}.${minor}.$((patch + 1))"
        ;;
    *)
        [[ "$VERSION_INPUT" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] ||
            die "Invalid semver string '$VERSION_INPUT'. Expected X.Y.Z (e.g. 1.0.0)"
        TARGET_VERSION="$VERSION_INPUT"
        ;;
    esac

    TARGET_TAG="${RELEASE_APP_ID}-v${TARGET_VERSION}"
    ok "Target version: $TARGET_VERSION (tag: $TARGET_TAG)"

    if [ "$TAG_ALREADY_PUSHED" = "0" ] && git rev-parse "$TARGET_TAG" >/dev/null 2>&1; then
        die "Tag $TARGET_TAG already exists in the repository."
    fi
    if [ "$TAG_ALREADY_PUSHED" = "1" ] && [ "$(git rev-parse "$TARGET_TAG^{commit}")" != "$TARGET_COMMIT" ]; then
        die "Tag $TARGET_TAG does not point at the checked-out commit $TARGET_COMMIT."
    fi

    # A release has to move forward. A tag naming a version already released,
    # or one older than the latest, is a mistake that is cheap to catch here
    # rather than after the upload.
    if [ -n "$LATEST_TAG" ]; then
        [ "$TARGET_VERSION" != "$base_version" ] ||
            die "$LATEST_TAG already releases $base_version."
        if [[ "$TARGET_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && "$base_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
            [ "$(printf '%s\n%s\n' "$base_version" "$TARGET_VERSION" | sort -V | tail -1)" = "$TARGET_VERSION" ] ||
                die "Version $TARGET_VERSION is older than the latest release $LATEST_TAG ($base_version)."
        fi
    fi
}

release_confirm() {
    printf '\n\033[1m%s release summary\033[0m\n' "$RELEASE_APP_NAME"
    printf '  • Target version:     \033[1;32m%s\033[0m (%s)\n' "$TARGET_VERSION" "$TARGET_TAG"
    printf '  • Commit on main:     %s (%s)\n' "$(git rev-parse --short "$TARGET_COMMIT")" "$(git log -1 --format=%s "$TARGET_COMMIT")"
    printf '  • Bucket:             %s (prefix %s/)\n' "$R2_BUCKET" "$BUCKET_PREFIX"
    printf '  • Update CDN URL:     %s\n' "$UPDATE_URL"
    [ "$DRY_RUN" = "1" ] && printf '  • Mode:               \033[1;33mDRY RUN (nothing will be published)\033[0m\n'

    if [ -n "$COMMITS" ]; then
        printf '\n  \033[1mCommits since %s:\033[0m\n' "${LATEST_TAG:-the initial commit}"
        echo "$COMMITS" | sed 's/^/    /' | head -15
        local total
        total="$(echo "$COMMITS" | wc -l | tr -d ' ')"
        [ "$total" -gt 15 ] && echo "    ... and $((total - 15)) more"
    fi
    printf '\n'

    if [ "$CONFIRM" = "1" ]; then
        read -rp "Proceed with $RELEASE_APP_NAME $TARGET_TAG? [y/N] " response
        case "$response" in
        [yY][eE][sS] | [yY]) ;;
        *) die "Release aborted." ;;
        esac
    fi
}

release_stamp_version() {
    step "Stamping version $TARGET_VERSION onto $RELEASE_APP_ID"
    node -e "
const fs = require('fs');
const path = '$APP_DIR/package.json';
const pkg = JSON.parse(fs.readFileSync(path, 'utf8'));
pkg.version = '$TARGET_VERSION';
fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
"
    ok "apps/$RELEASE_APP_ID/package.json version -> $TARGET_VERSION"
}

release_rollback() {
    warn "Rolling back version changes in the working tree..."
    git checkout "$APP_DIR/package.json" 2>/dev/null || true
}

release_build() {
    if [ "$SKIP_BUILD" = "1" ]; then
        warn "Skipping build-app.sh as requested (--skip-build)"
    else
        step "Building all native targets and packaging DMG + ZIP"
        "$APP_DIR/scripts/build-app.sh" --dist
        ok "Build and packaging completed"
    fi

    step "Verifying release artefacts in $RELEASE_DIR"
    DMG_FILE="$RELEASE_DIR/${RELEASE_APP_NAME}-${TARGET_VERSION}-arm64.dmg"
    ZIP_FILE="$RELEASE_DIR/${RELEASE_APP_NAME}-${TARGET_VERSION}-arm64-mac.zip"
    MANIFEST_FILE="$RELEASE_DIR/latest-mac.yml"

    # electron-builder names the zip with or without the -mac suffix depending
    # on whether a dir target is configured alongside it.
    if [ ! -f "$ZIP_FILE" ] && [ -f "$RELEASE_DIR/${RELEASE_APP_NAME}-${TARGET_VERSION}-arm64.zip" ]; then
        ZIP_FILE="$RELEASE_DIR/${RELEASE_APP_NAME}-${TARGET_VERSION}-arm64.zip"
    fi

    if [ "$SKIP_BUILD" = "0" ]; then
        [ -f "$DMG_FILE" ] || die "Missing release artefact: $DMG_FILE"
        [ -f "$ZIP_FILE" ] || die "Missing release artefact: $ZIP_FILE"
        [ -f "$MANIFEST_FILE" ] || die "Missing release manifest: $MANIFEST_FILE"
        ok "Artefacts verified on disk"
    fi
}

release_notarise() {
    if [ "$SKIP_NOTARIZE" = "1" ]; then
        warn "Skipping notarisation as requested (--skip-notarize)"
        return 0
    fi

    step "Notarising the release bundle with Apple"
    # notarytool has no default keychain profile and does not read
    # APPLE_API_KEY, so the profile is named explicitly. It holds the App Store
    # Connect API key, stored once on the release machine that notarises.
    #
    # Fatal, not a warning. An un-notarised DMG installs cleanly on the machine
    # that built it and is refused by Gatekeeper on every other Mac, so a
    # warning scrolling past in a runner log is a release that looks fine here
    # and is broken for every customer. Pass --skip-notarize to build one
    # deliberately.
    xcrun notarytool submit "$DMG_FILE" --keychain-profile "$NOTARYTOOL_PROFILE" --wait ||
        die "Notarisation failed. \`xcrun notarytool log <submission-id>\` has the reason."
    ok "DMG notarised by Apple"

    step "Stapling the notarisation ticket"
    xcrun stapler staple "$DMG_FILE" || die "Stapling the notarisation ticket failed."
    ok "Ticket stapled"
}

# release_create_tag
#
# The only place a release tag is created. The workflow never tags; the tag
# push is what starts it, so this runs from a developer shell with --tag.
release_create_tag() {
    step "Creating annotated git tag $TARGET_TAG"
    git tag -a "$TARGET_TAG" -m "Release $RELEASE_APP_NAME $TARGET_VERSION"
    if ! git push "$GIT_REMOTE" "$TARGET_TAG"; then
        git tag -d "$TARGET_TAG" >/dev/null 2>&1 || true
        die "Pushing $TARGET_TAG failed; the local tag was removed."
    fi
    ok "Pushed $TARGET_TAG."
}

release_upload() {
    if [ "$SKIP_UPLOAD" = "1" ]; then
        warn "Skipping the bucket upload as requested (--skip-upload)"
        return 0
    fi

    command -v aws >/dev/null 2>&1 || die "aws CLI is not installed or not in PATH."

    # The CLI reads the standard AWS names, so the R2 token is mapped onto them
    # here. Assigning rather than defaulting means a developer's own AWS
    # credentials cannot reach an R2 bucket by sitting in the environment.
    export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
    export AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
    unset AWS_SESSION_TOKEN AWS_PROFILE

    local dest="s3://$R2_BUCKET/$BUCKET_PREFIX"

    # Binaries first, manifest last. latest-mac.yml is the file that says a
    # version exists, so publishing it before its .zip has landed offers an
    # update that 404s for as long as the upload takes.
    step "Uploading binaries to $dest/ with cache-control: max-age=31536000, immutable"
    "${AWS_CMD[@]}" s3 cp "$RELEASE_DIR/" "$dest/" \
        --recursive \
        --exclude "*" \
        --include "*.dmg" \
        --include "*.zip" \
        --include "*.blockmap" \
        --cache-control "max-age=31536000, immutable"
    ok "Binaries uploaded"

    step "Uploading latest-mac.yml with cache-control: public, max-age=60"
    "${AWS_CMD[@]}" s3 cp "$MANIFEST_FILE" "$dest/latest-mac.yml" \
        --cache-control "public, max-age=60"
    ok "latest-mac.yml uploaded"

    # Nothing to invalidate. Cloudflare caches by file extension by default and
    # .yml is not on the list, so the manifest is served from R2 every time
    # while the .dmg and .zip are cached at the edge. The Cache-Control headers
    # above are set anyway, so the split survives someone later turning on a
    # cache-everything rule.
}

release_github_release() {
    if [ "$SKIP_GH_RELEASE" = "1" ]; then
        warn "Skipping the GitHub Release as requested (--skip-github-release)"
        return 0
    fi
    if ! command -v gh >/dev/null 2>&1; then
        warn "gh CLI not found. Skipping the GitHub Release."
        return 0
    fi

    step "Creating the GitHub Release ($TARGET_TAG)"
    local notes gh_args
    notes="### Downloads & Distribution
- **Direct Download**: [${RELEASE_APP_NAME}-${TARGET_VERSION}-arm64.dmg](${UPDATE_URL}/${RELEASE_APP_NAME}-${TARGET_VERSION}-arm64.dmg)
- **Auto-Update Feed**: \`${UPDATE_URL}/latest-mac.yml\`"

    gh_args=(
        release create "$TARGET_TAG"
        --title "$RELEASE_APP_NAME $TARGET_VERSION"
        --generate-notes
        --notes "$notes"
    )
    [ -f "$DMG_FILE" ] && gh_args+=("$DMG_FILE")

    gh "${gh_args[@]}"
    ok "GitHub Release $TARGET_TAG published"
}

release_summary() {
    printf '\n\033[1;32m════════════════════════════════════════════════════════════════════\033[0m\n'
    printf '\033[1;32m✓ %s %s released\033[0m\n' "$RELEASE_APP_NAME" "$TARGET_VERSION"
    printf '  • Download URL: %s/%s-%s-arm64.dmg\n' "$UPDATE_URL" "$RELEASE_APP_NAME" "$TARGET_VERSION"
    printf '  • Manifest URL: %s/latest-mac.yml\n' "$UPDATE_URL"
    printf '  • Git Tag:      %s (anchored to %s)\n' "$TARGET_TAG" "$(git rev-parse --short "$TARGET_COMMIT")"
    printf '\033[1;32m════════════════════════════════════════════════════════════════════\033[0m\n\n'
}

release_main() {
    : "${RELEASE_APP_ID:?release_main needs RELEASE_APP_ID}"
    : "${RELEASE_APP_NAME:?release_main needs RELEASE_APP_NAME}"
    : "${RELEASE_ENV_PREFIX:?release_main needs RELEASE_ENV_PREFIX}"

    APP_DIR="$REPO_ROOT/apps/$RELEASE_APP_ID"
    RELEASE_DIR="$APP_DIR/release"

    release_parse_args "$@"
    release_load_config
    release_verify_git
    release_resolve_version
    release_confirm

    if [ "$DRY_RUN" = "1" ]; then
        ok "Dry run checks passed. Exiting without making changes."
        exit 0
    fi

    if [ "$TAG_ONLY" = "1" ]; then
        release_create_tag
        exit 0
    fi

    if [ "$TAG_ALREADY_PUSHED" = "0" ]; then
        release_create_tag
    fi

    release_stamp_version
    trap release_rollback ERR

    release_build
    release_notarise
    trap - ERR

    release_upload
    release_github_release
    git checkout "$APP_DIR/package.json" 2>/dev/null || true
    release_summary
}
