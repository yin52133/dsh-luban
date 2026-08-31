#!/usr/bin/env bash
set -euo pipefail

profile='ubuntu-server'
version='pinned'
mode='--dry-run'
dsh_home=''
approved_by=''
output=''
approve_unpinned=0
apply_seen=0
dry_run_seen=0

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
    --dsh-home)
      [[ $# -ge 2 ]] || { echo '--dsh-home requires a value' >&2; exit 2; }
      dsh_home=$2
      shift 2
      ;;
    --approved-by)
      [[ $# -ge 2 ]] || { echo '--approved-by requires a value' >&2; exit 2; }
      approved_by=$2
      shift 2
      ;;
    --output)
      [[ $# -ge 2 ]] || { echo '--output requires a value' >&2; exit 2; }
      output=$2
      shift 2
      ;;
    --approve-unpinned)
      approve_unpinned=1
      shift
      ;;
    --apply)
      apply_seen=1
      mode='--apply'
      shift
      ;;
    --dry-run)
      dry_run_seen=1
      mode='--dry-run'
      shift
      ;;
    --help)
      echo 'Usage: scripts/install-3rd-party.sh [--profile ubuntu-server] [--version pinned|latest|<semver>] [--dsh-home <absolute-path>] [--approved-by <actor>] [--approve-unpinned] [--output <path>] [--dry-run|--apply]'
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 2
      ;;
  esac
done

if ((apply_seen == 1 && dry_run_seen == 1)); then
  echo 'Choose either --apply or --dry-run, not both.' >&2
  exit 2
fi

if [[ ! $profile =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  echo 'Profile must match [a-z0-9][a-z0-9-]*' >&2
  exit 2
fi

if ((apply_seen == 1)); then
  [[ -n $dsh_home ]] || { echo '--dsh-home is required with --apply' >&2; exit 2; }
  [[ -n $approved_by ]] || { echo '--approved-by is required with --apply' >&2; exit 2; }
fi

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
driver_args=(
  "$script_dir/install-3rd-party.mjs"
  --platform ubuntu
  --profile "$profile"
  --version "$version"
)
if [[ -n $dsh_home ]]; then
  driver_args+=(--dsh-home "$dsh_home")
fi
if [[ -n $approved_by ]]; then
  driver_args+=(--approved-by "$approved_by")
fi
if [[ -n $output ]]; then
  driver_args+=(--output "$output")
fi
if ((approve_unpinned == 1)); then
  driver_args+=(--approve-unpinned)
fi
exec node "${driver_args[@]}" "$mode"
