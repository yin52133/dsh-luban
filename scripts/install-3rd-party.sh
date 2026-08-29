#!/usr/bin/env bash
set -euo pipefail

profile='ubuntu-server'
version='pinned'
mode='--dry-run'

while (($# > 0)); do
  case "$1" in
    --profile)
      [[ $# -ge 2 ]] || { echo '--profile requires a value' >&2; exit 2; }
      profile=$2
      shift 2
      ;;
    --version)
      [[ $# -ge 2 ]] || { echo '--version requires a value' >&2; exit 2; }
      version=$2
      shift 2
      ;;
    --apply)
      mode='--apply'
      shift
      ;;
    --dry-run)
      mode='--dry-run'
      shift
      ;;
    --help)
      echo 'Usage: scripts/install-3rd-party.sh [--profile ubuntu-server] [--version pinned|latest|<semver>] [--dry-run|--apply]'
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 2
      ;;
  esac
done

if [[ ! $profile =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  echo 'Profile must match [a-z0-9][a-z0-9-]*' >&2
  exit 2
fi

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
exec node "$script_dir/install-3rd-party.mjs" \
  --platform ubuntu \
  --profile "$profile" \
  --version "$version" \
  "$mode"
