# VHS tape: demonstrate azure_portal_sweep.py terminal output
# Produces demos/apispy-portal-sweep-terminal.gif
#
# This tape shows the script's --help output and simulates a complete sweep
# run using a mock helper script (no real browser or Azure auth required).
# For the actual browser experience use --record-video when running the real script.

Output demos/apispy-portal-sweep-terminal.gif

Set Shell bash
Set FontSize 16
Set Width 1000
Set Height 720
Set Theme "TokyoNight"
Set TypingSpeed 80ms
Set WindowBar ColorfulRight

Hide
Type "cd /home/runner/work/SpecRecon/SpecRecon"
Enter 1
Show

# Show help output
Type "python3 scripts/azure_portal_sweep.py --help"
Enter 1
Sleep 3s

# Blank line before the demo run
Type ""
Enter 1
Sleep 500ms

# Simulate a complete sweep run using the mock helper
Type "bash tests/vhs/helpers/mock_portal_sweep.sh"
Enter 1
Sleep 45s
