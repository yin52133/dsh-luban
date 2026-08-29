#!/usr/bin/env sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
dsh_home=''
mode='--dry-run'

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dsh-home)
      if [ "$#" -lt 2 ]; then
        echo 'setup-ubuntu: --dsh-home requires a value' >&2
        exit 1
      fi
      dsh_home=$2
      shift 2
      ;;
    --apply)
      if [ "$mode" = '--explicit-dry-run' ]; then
        echo 'setup-ubuntu: --apply and --dry-run are mutually exclusive' >&2
        exit 1
      fi
      mode='--apply'
      shift
      ;;
    --dry-run)
      if [ "$mode" = '--apply' ]; then
        echo 'setup-ubuntu: --apply and --dry-run are mutually exclusive' >&2
        exit 1
      fi
      mode='--explicit-dry-run'
      shift
      ;;
    --help)
      echo 'Usage: scripts/deploy/setup-ubuntu.sh [--dsh-home <path>] [--dry-run|--apply]'
      exit 0
      ;;
    *)
      echo "setup-ubuntu: unknown option: $1" >&2
      exit 1
      ;;
  esac
done

if [ "$mode" = '--explicit-dry-run' ]; then
  mode='--dry-run'
fi

if [ -n "$dsh_home" ]; then
  exec node "$script_dir/setup-profile.mjs" --profile ubuntu-server --dsh-home "$dsh_home" "$mode"
fi
exec node "$script_dir/setup-profile.mjs" --profile ubuntu-server "$mode"
