#!/usr/bin/env bash
# Publish the prepared release using the user's existing GitHub CLI login.
# Run explicitly: bash scripts/publish.sh
set -euo pipefail

plugin_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$plugin_root"
plugin_repo='hiSlowMo/mygo-music-fusion'
plugin_tag='v0.1.0'
plugin_archive='mygo-music-fusion-0.1.0.zip'

plugin_account="$(gh api user --jq .login)"
if [[ "$plugin_account" != 'hiSlowMo' ]]; then
  printf 'Expected GitHub account hiSlowMo; active account is %s.\n' "$plugin_account" >&2
  exit 1
fi
if [[ -n "$(git status --porcelain)" ]]; then
  printf 'Commit the prepared plugin files before publishing.\n' >&2
  exit 1
fi
(cd releases && shasum -a 256 -c "$plugin_archive.sha256")

if gh repo view "$plugin_repo" --json nameWithOwner >/dev/null 2>&1; then
  plugin_visibility="$(gh repo view "$plugin_repo" --json visibility --jq .visibility)"
  if [[ "$plugin_visibility" != 'PUBLIC' ]]; then
    printf 'The existing repository is not public; refusing to change its visibility.\n' >&2
    exit 1
  fi
else
  gh repo create "$plugin_repo" --public --description 'NetEase + QQ Music source plugin for MyGo Music: dual accounts, unified search and local mixed playlists.' --disable-wiki
fi

plugin_remote="$(git remote get-url origin 2>/dev/null || true)"
if [[ -z "$plugin_remote" ]]; then
  git remote add origin "https://github.com/$plugin_repo.git"
elif [[ "$plugin_remote" != "https://github.com/$plugin_repo.git" && "$plugin_remote" != "git@github.com:$plugin_repo.git" ]]; then
  printf 'Unexpected origin: %s. Refusing to replace it.\n' "$plugin_remote" >&2
  exit 1
fi

git -c credential.helper= -c 'credential.helper=!gh auth git-credential' push --set-upstream origin HEAD:refs/heads/main
gh repo edit "$plugin_repo" --default-branch main --add-topic mygo-music-plugin --add-topic qqmusic --add-topic netease-cloud-music

if gh release view "$plugin_tag" --repo "$plugin_repo" >/dev/null 2>&1; then
  printf 'Release %s already exists; leaving it unchanged.\n' "$plugin_tag"
else
  gh release create "$plugin_tag" "releases/$plugin_archive" "releases/$plugin_archive.sha256" --repo "$plugin_repo" --target "$(git rev-parse HEAD)" --title 'v0.1.0 - NetEase + QQ Music' --notes-file docs/release-v0.1.0.md --latest
fi

gh repo view "$plugin_repo" --json url,visibility,repositoryTopics
gh release view "$plugin_tag" --repo "$plugin_repo" --json url,tagName,isDraft,isPrerelease,assets
printf 'Install: mygo-music://install-plugin?repo=%s\n' "$plugin_repo"
