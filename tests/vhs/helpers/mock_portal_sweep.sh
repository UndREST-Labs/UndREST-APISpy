#!/usr/bin/env bash
# Mock script that simulates azure_portal_sweep.py terminal output for VHS recording.
# Echoes a realistic run of a 305-service sweep with plausible timing delays.
# This is NOT a real sweep — it produces no actual network traffic or CSV output.

BOLD=$'\e[1m'
DIM=$'\e[2m'
GREEN=$'\e[32m'
YELLOW=$'\e[33m'
RESET=$'\e[0m'

header() { printf '%s\n' "${BOLD}${1}${RESET}"; }
ok()     { printf '%s\n' "${GREEN}✓${RESET} ${1}"; }
info()   { printf '%s\n' "  ${DIM}${1}${RESET}"; }
warn()   { printf '%s\n' "${YELLOW}WARNING:${RESET} ${1}"; }

header "APISpy Portal Sweep"
info "Extension : $(pwd)/apispy/extension"
info "Output dir: $(pwd)"
info "Dwell     : 1500 ms per service"
info "Session   : ${HOME}/.apispy-sweep-session"
echo ""

printf 'Requesting device code for Azure authentication…\n'
sleep 1
printf 'To sign in, use a web browser to open the page https://login.microsoft.com/device\n'
printf 'and enter the code %s to authenticate.\n' "K9BX2MPWN"
sleep 3
ok "Authenticated (token expires at $(date -d '+60 minutes' '+%H:%M:%S' 2>/dev/null || date -v+60M '+%H:%M:%S' 2>/dev/null || echo '23:59:00'))"
echo ""

printf 'Launching browser with APISpy extension…\n'
sleep 2
printf 'Waiting for portal authentication (up to 180s)…\n'
sleep 1
ok "Portal authentication confirmed."
echo ""

printf 'Enabling sweep mode in APISpy…\n'
sleep 0.5
printf '  Extension ID : oinpmbhpfpgenaibihaplhgjeladlkpo\n'
ok "Sweep mode enabled — APISpy will process ARM requests as they arrive."
echo ""

printf 'Collecting service URLs from All Services…\n'
sleep 2
ok "Collected 305 service URLs."
echo ""

printf 'Sweeping 305 services (dwell 1500 ms each)…\n'
sleep 0.3

services=(
  "Virtual machines" "Storage accounts" "SQL databases"
  "App Services" "Kubernetes services" "Cognitive Services"
  "Key Vaults" "Virtual networks" "Load balancers"
  "Azure Active Directory" "Monitor" "Security Center"
  "Resource groups" "Subscriptions" "Cost Management"
  "API Management" "Service Bus" "Event Hubs"
  "Azure Functions" "Logic Apps" "Container Registry"
  "Azure Cosmos DB" "Azure Cache for Redis" "Application Insights"
  "Azure Backup" "Azure Site Recovery" "Automation"
  "Azure DevOps" "Azure Boards" "Azure Pipelines"
)

total=305
shown=30

for i in $(seq 1 $shown); do
  idx=$(( (i - 1) % ${#services[@]} ))
  printf "  [%3d/%d] %s\n" "$i" "$total" "${services[$idx]}"
  sleep 0.08
done

sleep 0.3
printf "  [%3d/%d] …\n" 100 $total
sleep 0.2
printf "  [%3d/%d] …\n" 200 $total
sleep 0.2
printf "  [%3d/%d] …\n" 305 $total
sleep 0.3

ok "Visited ${total} services."
echo ""

printf 'Exporting APISpy CSV…\n'
info "Stopping capture (final flush)…"
sleep 0.5
info "Opening      : chrome-extension://oinpmbhpfpgenaibihaplhgjeladlkpo/panel.html"
sleep 1
info "Raw requests : 407 captured by devtools.js"
info "Processing   : waiting for Normalizer/Matcher pipeline…"
sleep 1
info "Page status  : Processing 407 captured request(s)…"
sleep 0.5
info "Matched      : 364 ARM request(s) after filtering"
sleep 0.3
ok "Triggering CSV download…"
sleep 0.5

TIMESTAMP=$(date '+%Y-%m-%d-%H-%M-%S')
CSV_NAME="apispy-${TIMESTAMP}.csv"

ok "CSV saved to: $(pwd)/${CSV_NAME}"
echo ""
printf "Done. CSV exported to:\n"
printf "  %s/%s\n" "$(pwd)" "${CSV_NAME}"
