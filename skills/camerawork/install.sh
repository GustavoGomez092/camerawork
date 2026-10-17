#!/usr/bin/env bash
# camerawork installer: ffmpeg (if needed), the camerawork engine, and the Claude skill.
#
#   curl -fsSL https://raw.githubusercontent.com/GustavoGomez092/camerawork/main/skills/camerawork/install.sh | bash
#   bash install.sh --help
set -euo pipefail

REPO="GustavoGomez092/camerawork"
REF="${CAMERAWORK_REF:-main}"
# Where the engine is installed from. CAMERAWORK_SPEC overrides it (any npm spec; used to test from a local checkout).
SPEC_OVERRIDE="${CAMERAWORK_SPEC:-}"
ENGINE=1 SKILL=1 PROJECT=0 FFMPEG=1 UPGRADE=0

usage() {
  cat <<'USAGE'
camerawork installer: installs ffmpeg (if missing), the camerawork engine and the Claude skill.

Usage: install.sh [options]

  --engine-only   install ffmpeg and the engine only (no Claude skill); the plugin path uses this
  --skill-only    copy the Claude skill only (no ffmpeg, no engine)
  --project       install the skill into ./.claude/skills instead of ~/.claude/skills
  --ref <ref>     git ref of GustavoGomez092/camerawork to install (default: main; env CAMERAWORK_REF)
  --no-ffmpeg     do not try to install ffmpeg (a missing ffmpeg is only a warning)
  --upgrade       reinstall the engine even if camerawork is already on PATH
  -h, --help      show this help

The skill is copied from the installed package (`npm root -g`)/camerawork/skills/camerawork; if the package is not
installed globally, from the skill directory next to this script (a checkout or the plugin cache).
Requires macOS or Linux, Node 20+ and npm. ffmpeg and ffprobe 6+ are installed with brew, apt-get, dnf or pacman.
USAGE
}

say() { printf '==> %s\n' "$*"; }
warn() { printf '!!  %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --engine-only) SKILL=0 ;;
    --skill-only) ENGINE=0 FFMPEG=0 ;;
    --project) PROJECT=1 ;;
    --ref)
      [ $# -ge 2 ] || die "--ref needs a git ref"
      REF="$2"; shift ;;
    --ref=*) REF="${1#--ref=}" ;;
    --no-ffmpeg) FFMPEG=0 ;;
    --upgrade) UPGRADE=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
  shift
done
[ "$ENGINE" = 1 ] || [ "$SKILL" = 1 ] || die "--engine-only and --skill-only cannot be combined"

# Directory of this script, when it is a real file (empty when piped through bash).
SCRIPT_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

# ---- platform ---------------------------------------------------------------------------------------------------
OS="$(uname -s)"
case "$OS" in
  Darwin|Linux) ;;
  *) die "unsupported OS '$OS': camerawork supports macOS and Linux" ;;
esac

# ---- node + npm -------------------------------------------------------------------------------------------------
node_help() {
  cat >&2 <<'HELP'
Install Node 20 or newer, then run this installer again:
  nvm (any OS):   curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/master/install.sh | bash
                  then open a new shell and run: nvm install 22
  macOS (brew):   brew install node
  Debian/Ubuntu:  sudo apt-get install -y nodejs npm   (or use nvm if the version is older than 20)
HELP
}

if [ "$ENGINE" = 1 ]; then
  have node || { warn "node is not installed"; node_help; exit 1; }
  have npm || { warn "npm is not installed"; node_help; exit 1; }
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$NODE_MAJOR" -lt 20 ]; then
    warn "Node $(node -v) is too old: camerawork needs Node 20 or newer"
    node_help
    exit 1
  fi
  say "Node $(node -v), npm $(npm -v)"
fi

# ---- ffmpeg -----------------------------------------------------------------------------------------------------
major_of() { # prints the major version of `$1 -version`, or nothing when it cannot be read
  "$1" -version 2>/dev/null | sed -n '1s/^[a-z]* version [nN]\{0,1\}\([0-9][0-9]*\).*/\1/p'
}

ffmpeg_ok() {
  have ffmpeg && have ffprobe || return 1
  local m
  m="$(major_of ffmpeg)"
  # Development builds report a git hash instead of a version: accept them.
  [ -z "$m" ] || [ "$m" -ge 6 ]
}

ffmpeg_help() {
  cat >&2 <<'HELP'
Install ffmpeg and ffprobe 6 or newer, then run this installer again:
  macOS:          brew install ffmpeg
  Debian/Ubuntu:  sudo apt-get install -y ffmpeg
  Fedora:         sudo dnf install -y ffmpeg   (enable RPM Fusion first if needed)
  Arch:           sudo pacman -S ffmpeg
  Other:          https://ffmpeg.org/download.html
HELP
}

as_root() { # runs a command with sudo unless already root; announces sudo first
  if [ "$(id -u)" = 0 ]; then "$@"; else
    say "This needs administrator rights: running 'sudo $*'"
    sudo "$@"
  fi
}

if [ "$FFMPEG" = 1 ]; then
  if ffmpeg_ok; then
    say "ffmpeg $(major_of ffmpeg) found"
  elif have ffmpeg && have ffprobe; then
    warn "ffmpeg $(major_of ffmpeg) is older than 6"
    ffmpeg_help
    exit 1
  else
    say "ffmpeg or ffprobe is missing: installing ffmpeg"
    if [ "$OS" = Darwin ]; then
      have brew || { warn "Homebrew is not installed (https://brew.sh)"; ffmpeg_help; exit 1; }
      brew install ffmpeg
    elif have apt-get; then
      as_root apt-get install -y ffmpeg
    elif have dnf; then
      as_root dnf install -y ffmpeg
    elif have pacman; then
      as_root pacman -S --noconfirm ffmpeg
    else
      warn "no supported package manager found (brew, apt-get, dnf, pacman)"
      ffmpeg_help
      exit 1
    fi
    ffmpeg_ok || { warn "ffmpeg 6 or newer is still not available after installing"; ffmpeg_help; exit 1; }
    say "ffmpeg $(major_of ffmpeg) installed"
  fi
fi

# ---- engine -----------------------------------------------------------------------------------------------------
eacces_help() {
  cat >&2 <<'HELP'
npm cannot write to its global directory (EACCES). Do not use sudo; give npm a directory you own:
  mkdir -p ~/.npm-global
  npm config set prefix ~/.npm-global
  echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.profile   # then open a new shell
or install Node with nvm (https://github.com/nvm-sh/nvm), which keeps everything in your home directory.
Then run this installer again.
HELP
}

install_engine() {
  local spec="${SPEC_OVERRIDE:-github:$REPO#$REF}" tmp log tgz
  tmp="$(mktemp -d)"
  log="$tmp/npm.log"
  say "Installing the camerawork engine from $spec"
  # `npm install -g <git spec>` links to a temporary checkout on some npm versions, so build a tarball first.
  if ! tgz="$(cd "$tmp" && npm pack "$spec" --silent 2>"$log" | tail -n 1)" || [ -z "$tgz" ] || [ ! -f "$tmp/$tgz" ]; then
    cat "$log" >&2
    rm -rf "$tmp"
    die "could not fetch and build $spec (is git installed, and does the ref exist?)"
  fi
  if ! npm install -g "$tmp/$tgz" >"$log" 2>&1; then
    if grep -q 'EACCES' "$log"; then eacces_help; else cat "$log" >&2; fi
    rm -rf "$tmp"
    exit 1
  fi
  rm -rf "$tmp"
}

if [ "$ENGINE" = 1 ]; then
  if have camerawork && [ "$UPGRADE" = 0 ]; then
    say "camerawork $(camerawork --version) is already installed (use --upgrade to reinstall)"
  else
    install_engine
    hash -r
  fi
fi

# ---- skill ------------------------------------------------------------------------------------------------------
find_skill_source() { # prints the directory holding the skill to copy, or nothing
  local root
  if have npm; then
    root="$(npm root -g 2>/dev/null || true)"
    if [ -n "$root" ] && [ -f "$root/camerawork/skills/camerawork/SKILL.md" ]; then
      printf '%s\n' "$root/camerawork/skills/camerawork"
      return
    fi
  fi
  if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/SKILL.md" ]; then printf '%s\n' "$SCRIPT_DIR"; fi
}

install_skill() {
  local src base target
  src="$(find_skill_source)"
  [ -n "$src" ] || die "cannot find the skill to copy: install the engine first (run without --skill-only)"
  if [ "$PROJECT" = 1 ]; then base="$PWD/.claude/skills"; else base="${HOME:?HOME is not set}/.claude/skills"; fi
  target="$base/camerawork"
  if [ -L "$target" ]; then
    say "$target is a symlink (dev setup): leaving it as it is"
    return
  fi
  if [ -d "$target" ] && [ "$(cd "$target" && pwd -P)" = "$(cd "$src" && pwd -P)" ]; then
    say "the skill already lives at $target"
    return
  fi
  say "Installing the Claude skill into $target (from $src)"
  mkdir -p "$base"
  rm -rf "$target"
  mkdir -p "$target"
  cp -R "$src/." "$target/"
}

if [ "$SKILL" = 1 ]; then install_skill; fi

# ---- verify -----------------------------------------------------------------------------------------------------
if [ "$ENGINE" = 1 ]; then
  if have camerawork && camerawork --version >/dev/null 2>&1; then
    say "camerawork $(camerawork --version)"
  else
    warn "camerawork is installed but not on your PATH. Add this to your shell profile and open a new shell:"
    warn "  export PATH=\"$(npm prefix -g)/bin:\$PATH\""
    exit 1
  fi
  if have ffmpeg; then
    say "$(ffmpeg -version | head -n 1)"
  else
    warn "ffmpeg is not installed: camerawork needs ffmpeg and ffprobe 6 or newer to run"
  fi
fi

echo
say "Ready."
if [ "$ENGINE" = 1 ]; then
  cat <<'NEXT'

Next:
  camerawork plan master.mov -o plan.json --look hero --loop
  camerawork preview plan.json
  camerawork render plan.json -o out/feature
NEXT
fi
if [ "$SKILL" = 1 ]; then
  printf '\nOr ask Claude: "turn this recording into a guided video".\n'
fi
