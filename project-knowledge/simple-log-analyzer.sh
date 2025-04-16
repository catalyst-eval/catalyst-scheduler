#!/bin/bash

# Simple Log Analyzer for Catalyst Scheduler
# This version works with plain text logs

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Configuration
OUTPUT_DIR="./log-analysis"
mkdir -p "$OUTPUT_DIR"

echo -e "${BLUE}===== Simple Log Analyzer =====${NC}"
echo -e "${BLUE}===== Catalyst Scheduler Appointment Sync Diagnostics =====${NC}"
echo ""

# Check if an argument was provided
if [ $# -lt 1 ]; then
  echo -e "${YELLOW}Please provide the log file to analyze${NC}"
  echo -e "Usage: $0 logfile.txt"
  exit 1
fi

LOG_FILE="$1"

# Check if the file exists
if [ ! -f "$LOG_FILE" ]; then
  echo -e "${RED}Error: Cannot find log file: $LOG_FILE${NC}"
  exit 1
fi

echo -e "${CYAN}Analyzing log file: $LOG_FILE${NC}"

# Count lines
LINE_COUNT=$(wc -l < "$LOG_FILE")
echo -e "${GREEN}Log file contains $LINE_COUNT lines${NC}"

# Analyze webhook events
echo -e "${CYAN}Analyzing webhook events...${NC}"
WEBHOOK_COUNT=$(grep -c -i "webhook\|process.*appointment\|Received" "$LOG_FILE" || echo "0")
echo -e "${GREEN}Found $WEBHOOK_COUNT webhook events${NC}"

# Find unique appointment IDs
echo -e "${CYAN}Extracting appointment IDs...${NC}"
APPOINTMENTS=$(grep -o -E "[a-f0-9]{24}" "$LOG_FILE" | sort | uniq)
APPOINTMENT_COUNT=$(echo "$APPOINTMENTS" | wc -l)
echo -e "${GREEN}Found $APPOINTMENT_COUNT unique appointment IDs${NC}"

# Find error events
echo -e "${CYAN}Analyzing error events...${NC}"
ERROR_COUNT=$(grep -c -i "error\|exception\|failed\|warning" "$LOG_FILE" || echo "0")
echo -e "${GREEN}Found $ERROR_COUNT error/warning events${NC}"

# Create output file
REPORT_FILE="$OUTPUT_DIR/log-analysis-report.md"
echo "# Log Analysis Report" > "$REPORT_FILE"
echo "" >> "$REPORT_FILE"
echo "## Summary" >> "$REPORT_FILE"
echo "" >> "$REPORT_FILE"
echo "- **Total Lines:** $LINE_COUNT" >> "$REPORT_FILE"
echo "- **Webhook Events:** $WEBHOOK_COUNT" >> "$REPORT_FILE"
echo "- **Unique Appointment IDs:** $APPOINTMENT_COUNT" >> "$REPORT_FILE"
echo "- **Error Events:** $ERROR_COUNT" >> "$REPORT_FILE"
echo "" >> "$REPORT_FILE"

# Extract appointment-related issues
echo "## Appointment Sync Issues" >> "$REPORT_FILE"
echo "" >> "$REPORT_FILE"
echo "### Missing Appointments" >> "$REPORT_FILE"
echo "" >> "$REPORT_FILE"
grep -i "missing\|not found" "$LOG_FILE" | grep -i "appointment" >> "$REPORT_FILE" || echo "No missing appointments found" >> "$REPORT_FILE"

echo "" >> "$REPORT_FILE"
echo "### Duplicate Appointments" >> "$REPORT_FILE"
echo "" >> "$REPORT_FILE"
grep -i "duplicate\|already exists\|already processed" "$LOG_FILE" | grep -i "appointment" >> "$REPORT_FILE" || echo "No duplicate appointments found" >> "$REPORT_FILE"

echo "" >> "$REPORT_FILE"
echo "## Error Patterns" >> "$REPORT_FILE"
echo "" >> "$REPORT_FILE"
grep -i "error\|exception\|failed\|warning" "$LOG_FILE" | sort | uniq -c | sort -nr | head -20 >> "$REPORT_FILE"

echo -e "${GREEN}Analysis complete!${NC}"
echo -e "${CYAN}Results saved to:${NC} $REPORT_FILE"

# If there aren't too many unique appointment IDs, list them
if [ "$APPOINTMENT_COUNT" -lt 50 ]; then
  echo "" >> "$REPORT_FILE"
  echo "## Unique Appointment IDs" >> "$REPORT_FILE"
  echo "" >> "$REPORT_FILE"
  echo "$APPOINTMENTS" >> "$REPORT_FILE"
fi

# Common patterns to look for
echo -e "${CYAN}Looking for specific patterns in the logs...${NC}"
echo "" >> "$REPORT_FILE"
echo "## Common Patterns" >> "$REPORT_FILE"
echo "" >> "$REPORT_FILE"

echo "### Webhook Processing" >> "$REPORT_FILE"
echo "" >> "$REPORT_FILE"
grep -i "process.*webhook\|received webhook" "$LOG_FILE" | head -20 >> "$REPORT_FILE"

echo "" >> "$REPORT_FILE"
echo "### Appointment Assignment" >> "$REPORT_FILE"
echo "" >> "$REPORT_FILE"
grep -i "assign.*office\|assigned to office\|office assignment" "$LOG_FILE" | head -20 >> "$REPORT_FILE"

echo "" >> "$REPORT_FILE"
echo "### Validation Issues" >> "$REPORT_FILE"
echo "" >> "$REPORT_FILE"
grep -i "validation\|invalid\|malformed" "$LOG_FILE" | head -20 >> "$REPORT_FILE"

# Display the summary
echo -e "${BLUE}=== Analysis Summary ===${NC}"
echo -e "${CYAN}Total Lines:${NC} $LINE_COUNT"
echo -e "${CYAN}Webhook Events:${NC} $WEBHOOK_COUNT"
echo -e "${CYAN}Unique Appointment IDs:${NC} $APPOINTMENT_COUNT"
echo -e "${CYAN}Error Events:${NC} $ERROR_COUNT"
echo ""
echo -e "${GREEN}Results saved to:${NC} $REPORT_FILE"