#!/bin/bash
# teleport.sh — Resume a cloud agent session in your local Claude Code CLI.
#
# Usage:
#   scripts/teleport.sh <agent-session-url>
#   scripts/teleport.sh <agent-session-id>
#
# Examples:
#   scripts/teleport.sh "https://linear.app/your-org/issue/ENG-123/...#agent-session-f5b0d602"
#   scripts/teleport.sh f5b0d602-8f29-49c8-9844-f0978a6c47b2
#
# Environment:
#   HERMES_URL  — Override orchestrator base URL (default: https://hermes.atls.app)
#
# When stdin is not a TTY (e.g. run by Claude Code skill), interactive prompts
# use defaults: auto-stash, auto-create-branch, and skip launching claude.

set -euo pipefail

HERMES_URL="${HERMES_URL:-https://hermes.yourdomain.com}"

# Detect interactive mode
INTERACTIVE=true
if [ ! -t 0 ]; then
  INTERACTIVE=false
fi

# --- Colors (skip in non-interactive mode) ---
if [ "$INTERACTIVE" = true ]; then
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  YELLOW='\033[1;33m'
  CYAN='\033[0;36m'
  BOLD='\033[1m'
  NC='\033[0m'
else
  RED='' GREEN='' YELLOW='' CYAN='' BOLD='' NC=''
fi

info()  { echo -e "${CYAN}▸${NC} $*"; }
success() { echo -e "${GREEN}✓${NC} $*"; }
warn()  { echo -e "${YELLOW}⚠${NC} $*"; }
error() { echo -e "${RED}✗${NC} $*" >&2; }
fatal() { error "$@"; exit 1; }

# --- Pre-flight checks ---

check_dependencies() {
  local missing=()
  for cmd in curl jq git tar; do
    if ! command -v "$cmd" &>/dev/null; then
      missing+=("$cmd")
    fi
  done
  if [ ${#missing[@]} -gt 0 ]; then
    fatal "Missing required commands: ${missing[*]}"
  fi
}

check_git_repo() {
  if ! git rev-parse --is-inside-work-tree &>/dev/null; then
    fatal "Not inside a git repository. Run this from your project checkout."
  fi
}

# --- Argument parsing ---

usage() {
  echo "Usage: $0 <agent-session-url-or-id>"
  echo ""
  echo "Resume a cloud agent session in your local Claude Code CLI."
  echo ""
  echo "Arguments:"
  echo "  agent-session-url  The Linear agent session URL (from Linear sidebar or Slack)"
  echo "  agent-session-id   The full agent session UUID"
  echo ""
  echo "Environment:"
  echo "  HERMES_URL         Override orchestrator URL (default: https://hermes.yourdomain.com)"
  exit 1
}

if [ $# -lt 1 ]; then
  usage
fi

INPUT="$1"

info "Using orchestrator: ${HERMES_URL}"

# --- Run pre-flight checks ---

info "Running pre-flight checks..."
check_dependencies
check_git_repo
success "Pre-flight checks passed"

# --- Fetch session metadata from orchestrator ---

info "Fetching session metadata..."

# Determine if input is a URL or a session ID
if [[ "$INPUT" == http* ]]; then
  ENCODED_URL=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$INPUT', safe=''))" 2>/dev/null \
    || jq -rn --arg url "$INPUT" '$url | @uri')
  TELEPORT_URL="${HERMES_URL}/teleport?url=${ENCODED_URL}"
else
  TELEPORT_URL="${HERMES_URL}/teleport?id=${INPUT}"
fi

RESPONSE=$(curl -sf "$TELEPORT_URL" 2>/dev/null) || {
  # Try to get error message from response
  RESPONSE=$(curl -s "$TELEPORT_URL" 2>/dev/null)
  ERROR_MSG=$(echo "$RESPONSE" | jq -r '.error // "Failed to reach orchestrator"' 2>/dev/null || echo "Failed to reach orchestrator at $HERMES_URL")
  fatal "$ERROR_MSG"
}

OK=$(echo "$RESPONSE" | jq -r '.ok')
if [ "$OK" != "true" ]; then
  ERROR_MSG=$(echo "$RESPONSE" | jq -r '.error // "Unknown error"')
  fatal "$ERROR_MSG"
fi

# Parse response
CLAUDE_SESSION_ID=$(echo "$RESPONSE" | jq -r '.claudeSessionId')
BRANCH=$(echo "$RESPONSE" | jq -r '.branch')
REPO=$(echo "$RESPONSE" | jq -r '.repo')
WORKSPACE_DIR=$(echo "$RESPONSE" | jq -r '.workspaceDir')
ISSUE_ID=$(echo "$RESPONSE" | jq -r '.issueIdentifier')
ISSUE_TITLE=$(echo "$RESPONSE" | jq -r '.issueTitle')
STATUS=$(echo "$RESPONSE" | jq -r '.status')
ARTIFACTS_URL=$(echo "$RESPONSE" | jq -r '.artifactsUrl')

echo ""
echo -e "${BOLD}Session found:${NC}"
echo -e "  Issue:   ${CYAN}${ISSUE_ID}${NC} — ${ISSUE_TITLE}"
echo -e "  Branch:  ${CYAN}${BRANCH}${NC}"
echo -e "  Status:  ${STATUS}"
echo -e "  Repo:    ${REPO}"
echo ""

# --- Validate repo matches current checkout ---

REMOTE_URL=$(git remote get-url origin 2>/dev/null || echo "")
if [ -z "$REMOTE_URL" ]; then
  fatal "No git remote 'origin' found."
fi

# Extract org/repo from remote URL (handles both HTTPS and SSH formats)
CURRENT_REPO=$(echo "$REMOTE_URL" | sed -E 's|.*github\.com[:/]||; s|\.git$||')

if [ "$CURRENT_REPO" != "$REPO" ]; then
  fatal "Repo mismatch: session is for '${REPO}' but you're in '${CURRENT_REPO}'. Run this from your ${REPO} checkout."
fi

success "Repo matches: ${REPO}"

# --- Handle git state ---

STASHED=false
CURRENT_BRANCH=$(git branch --show-current)

# Check for uncommitted changes
if ! git diff --quiet HEAD 2>/dev/null || [ -n "$(git status --porcelain 2>/dev/null)" ]; then
  if [ "$INTERACTIVE" = true ]; then
    warn "You have uncommitted changes."
    echo -n "Stash changes and continue? [Y/n] "
    read -r REPLY
    REPLY=${REPLY:-Y}
    if [[ "$REPLY" =~ ^[Yy]$ ]]; then
      git stash push -m "teleport: before resuming ${ISSUE_ID}" --include-untracked
      STASHED=true
      success "Changes stashed"
    else
      fatal "Aborting. Commit or stash your changes first."
    fi
  else
    info "Auto-stashing uncommitted changes..."
    git stash push -m "teleport: before resuming ${ISSUE_ID}" --include-untracked
    STASHED=true
    success "Changes stashed"
  fi
fi

# Restore stash on failure
cleanup() {
  if [ "$STASHED" = true ]; then
    warn "Restoring stashed changes..."
    git checkout "$CURRENT_BRANCH" 2>/dev/null || true
    git stash pop 2>/dev/null || true
  fi
  # Clean up temp files
  rm -rf /tmp/claude-teleport-*
}
trap cleanup EXIT

# Checkout branch
git fetch origin 2>/dev/null

if git ls-remote --heads origin "$BRANCH" 2>/dev/null | grep -q .; then
  # Branch exists on remote
  info "Checking out branch: ${BRANCH}"
  git checkout "$BRANCH" 2>/dev/null || git checkout -b "$BRANCH" "origin/${BRANCH}"
  git pull origin "$BRANCH" --ff-only 2>/dev/null || true
  success "On branch: ${BRANCH}"
else
  # Branch not on remote
  warn "Branch '${BRANCH}' not found on remote."

  # Detect default branch
  DEFAULT_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|refs/remotes/origin/||' || echo "main")

  if [ "$INTERACTIVE" = true ]; then
    echo ""
    echo "  [1] Create new branch '${BRANCH}' from ${DEFAULT_BRANCH}"
    echo "  [2] Continue on current branch (${CURRENT_BRANCH})"
    echo -n "Choose [1/2]: "
    read -r CHOICE
    CHOICE=${CHOICE:-1}
  else
    # Non-interactive: default to creating branch
    CHOICE=1
    info "Auto-creating branch '${BRANCH}' from ${DEFAULT_BRANCH}"
  fi

  case "$CHOICE" in
    1)
      git checkout -b "$BRANCH" "origin/${DEFAULT_BRANCH}"
      success "Created branch: ${BRANCH} (from ${DEFAULT_BRANCH})"
      ;;
    2)
      info "Continuing on branch: ${CURRENT_BRANCH}"
      ;;
    *)
      fatal "Invalid choice"
      ;;
  esac
fi

# --- Download and extract artifacts ---

info "Downloading session artifacts..."

TMPDIR=$(mktemp -d /tmp/claude-teleport-XXXXXX)

curl -sf "$ARTIFACTS_URL" -o "${TMPDIR}/claude-projects.tar.gz" || {
  fatal "Failed to download artifacts from S3"
}

success "Downloaded artifacts"

info "Extracting and remapping session files..."

tar -xzf "${TMPDIR}/claude-projects.tar.gz" -C "${TMPDIR}" || {
  fatal "Failed to extract artifacts tarball"
}

# Find the source project directory inside the tarball
# On the agent, workspace is e.g. /workspace/app → project path is -workspace-app
SOURCE_PROJECT_DIR=""
if [ -d "${TMPDIR}/projects" ]; then
  # The tarball contains projects/<project-path>/ directories
  # Find the one that has our claudeSessionId .jsonl file
  SOURCE_PROJECT_DIR=$(find "${TMPDIR}/projects" -maxdepth 1 -type d ! -name projects | head -1)
fi

if [ -z "$SOURCE_PROJECT_DIR" ] || [ ! -d "$SOURCE_PROJECT_DIR" ]; then
  fatal "Could not find project directory in artifacts tarball"
fi

# Construct local project path from cwd
# Claude Code derives this from the absolute path: /Users/foo/work/app → -Users-foo-work-app
LOCAL_CWD=$(pwd)
LOCAL_PROJECT_PATH=$(echo "$LOCAL_CWD" | tr '/' '-')
LOCAL_PROJECTS_DIR="${HOME}/.claude/projects/${LOCAL_PROJECT_PATH}"

mkdir -p "$LOCAL_PROJECTS_DIR"

# Copy the session .jsonl file
SESSION_JSONL="${SOURCE_PROJECT_DIR}/${CLAUDE_SESSION_ID}.jsonl"
if [ -f "$SESSION_JSONL" ]; then
  cp "$SESSION_JSONL" "${LOCAL_PROJECTS_DIR}/${CLAUDE_SESSION_ID}.jsonl"
  success "Copied session transcript"
else
  # The .jsonl might be under a different project path — search for it
  FOUND_JSONL=$(find "${TMPDIR}/projects" -name "${CLAUDE_SESSION_ID}.jsonl" -type f | head -1)
  if [ -n "$FOUND_JSONL" ]; then
    cp "$FOUND_JSONL" "${LOCAL_PROJECTS_DIR}/${CLAUDE_SESSION_ID}.jsonl"
    success "Copied session transcript (found in nested path)"
  else
    fatal "Could not find session transcript ${CLAUDE_SESSION_ID}.jsonl in artifacts"
  fi
fi

# Copy the session directory (todo, memory, etc.) if it exists
SESSION_DIR="${SOURCE_PROJECT_DIR}/${CLAUDE_SESSION_ID}"
if [ -d "$SESSION_DIR" ]; then
  cp -r "$SESSION_DIR" "${LOCAL_PROJECTS_DIR}/${CLAUDE_SESSION_ID}"
  success "Copied session state directory"
fi

# Cleanup temp files (trap will handle on error)
rm -rf "$TMPDIR"

# --- Done ---

echo ""
echo -e "${GREEN}${BOLD}Ready to resume session!${NC}"
echo -e "  Issue:    ${CYAN}${ISSUE_ID}${NC} — ${ISSUE_TITLE}"
echo -e "  Session:  ${CLAUDE_SESSION_ID}"
echo ""

# Disable the EXIT trap cleanup since we succeeded
STASHED=false
trap - EXIT

if [ "$INTERACTIVE" = true ]; then
  exec claude --resume "$CLAUDE_SESSION_ID"
else
  echo "Run: claude --resume ${CLAUDE_SESSION_ID}"
fi
