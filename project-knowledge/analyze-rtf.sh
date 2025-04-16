#!/bin/bash

# Enhanced RTF log analyzer for Catalyst Scheduler

# Set file paths
LOG_DIR="/Users/Seabolt/Library/CloudStorage/GoogleDrive-tyler@bridgefamilytherapy.com/My Drive/Bridge Family Therapy/1 BFT Shared Main/4 Services/Catalyst Scheduler/catalyst-scheduler/project-knowledge/Version 1.0/20250416"
LOG_FILE="$LOG_DIR/Render Log 04162025.rtf"
OUTPUT_DIR="$LOG_DIR/analysis"
mkdir -p "$OUTPUT_DIR"

# Convert RTF to text
echo "Converting RTF to text..."
TEXT_FILE="$OUTPUT_DIR/render-log.txt"
textutil -convert txt -output "$TEXT_FILE" "$LOG_FILE"

# Check if conversion succeeded
if [ -f "$TEXT_FILE" ]; then
  echo "Conversion successful. Analyzing log..."
  
  # Count lines
  LINE_COUNT=$(wc -l < "$TEXT_FILE")
  echo "Log file contains $LINE_COUNT lines"
  
  # Count webhook events
  WEBHOOK_COUNT=$(grep -c -i "webhook" "$TEXT_FILE" || echo "0")
  echo "Found $WEBHOOK_COUNT webhook events"
  
  # Find unique appointment IDs
  APPOINTMENT_IDS=$(grep -o -E "[a-f0-9]{24}" "$TEXT_FILE" | sort | uniq)
  APPOINTMENT_COUNT=$(echo "$APPOINTMENT_IDS" | wc -l)
  echo "Found $APPOINTMENT_COUNT unique appointment IDs"
  
  # Find error events
  ERROR_COUNT=$(grep -c -i "error\|exception\|failed" "$TEXT_FILE" || echo "0")
  echo "Found $ERROR_COUNT error events"
  
  # Create report file
  REPORT_FILE="$OUTPUT_DIR/analysis-report.md"
  echo "# Log Analysis Report" > "$REPORT_FILE"
  echo "" >> "$REPORT_FILE"
  echo "## Summary" >> "$REPORT_FILE"
  echo "" >> "$REPORT_FILE"
  echo "- **Total Lines:** $LINE_COUNT" >> "$REPORT_FILE"
  echo "- **Webhook Events:** $WEBHOOK_COUNT" >> "$REPORT_FILE"
  echo "- **Unique Appointment IDs:** $APPOINTMENT_COUNT" >> "$REPORT_FILE"
  echo "- **Error Events:** $ERROR_COUNT" >> "$REPORT_FILE"
  echo "" >> "$REPORT_FILE"
  
  # Look for missing appointments
  echo "## Missing Appointments" >> "$REPORT_FILE"
  echo "" >> "$REPORT_FILE"
  grep -i "missing\|not found" "$TEXT_FILE" | grep -i "appointment" >> "$REPORT_FILE" || echo "No missing appointments found" >> "$REPORT_FILE"
  
  # Look for duplicate appointments
  echo "" >> "$REPORT_FILE"
  echo "## Duplicate Appointments" >> "$REPORT_FILE"
  echo "" >> "$REPORT_FILE"
  grep -i "duplicate\|already exists" "$TEXT_FILE" | grep -i "appointment" >> "$REPORT_FILE" || echo "No duplicate appointments found" >> "$REPORT_FILE"
  
  # Extract webhook processing events
  echo "" >> "$REPORT_FILE"
  echo "## Webhook Processing" >> "$REPORT_FILE"
  echo "" >> "$REPORT_FILE"
  grep -i "process.*webhook\|Received.*webhook" "$TEXT_FILE" | head -20 >> "$REPORT_FILE"
  echo "..." >> "$REPORT_FILE"
  
  # Extract information about appointment events
  echo "" >> "$REPORT_FILE"
  echo "## Appointment Events" >> "$REPORT_FILE"
  echo "" >> "$REPORT_FILE"
  echo "### Created Appointments" >> "$REPORT_FILE"
  echo "" >> "$REPORT_FILE"
  grep -i "Created.*appointment\|Adding appointment" "$TEXT_FILE" | head -15 >> "$REPORT_FILE"
  echo "..." >> "$REPORT_FILE"
  
  echo "" >> "$REPORT_FILE"
  echo "### Updated Appointments" >> "$REPORT_FILE"
  echo "" >> "$REPORT_FILE"
  grep -i "Updated.*appointment\|Updating appointment" "$TEXT_FILE" | head -15 >> "$REPORT_FILE"
  echo "..." >> "$REPORT_FILE"
  
  echo "" >> "$REPORT_FILE"
  echo "### Cancelled Appointments" >> "$REPORT_FILE"
  echo "" >> "$REPORT_FILE"
  grep -i "Cancelled.*appointment\|Cancelling appointment" "$TEXT_FILE" | head -15 >> "$REPORT_FILE"
  echo "..." >> "$REPORT_FILE"
  
  # Extract office assignment information
  echo "" >> "$REPORT_FILE"
  echo "## Office Assignment" >> "$REPORT_FILE"
  echo "" >> "$REPORT_FILE"
  grep -i "assign.*office\|office assignment" "$TEXT_FILE" | head -20 >> "$REPORT_FILE"
  echo "..." >> "$REPORT_FILE"
  
  # Extract validation issues
  echo "" >> "$REPORT_FILE"
  echo "## Validation Issues" >> "$REPORT_FILE"
  echo "" >> "$REPORT_FILE"
  grep -i "validation\|invalid\|malformed" "$TEXT_FILE" | head -20 >> "$REPORT_FILE" || echo "No validation issues found" >> "$REPORT_FILE"
  
  # Generate list of duplicate appointment IDs with context
  echo "" >> "$REPORT_FILE"
  echo "## Analysis of Duplicate Appointments" >> "$REPORT_FILE"
  echo "" >> "$REPORT_FILE"
  DUPLICATE_APPTS=$(grep -i "duplicate\|already exists" "$TEXT_FILE" | grep -o -E "[a-f0-9]{24}" | sort | uniq)
  for appt_id in $DUPLICATE_APPTS; do
    echo "### Appointment ID: $appt_id" >> "$REPORT_FILE"
    echo "" >> "$REPORT_FILE"
    grep "$appt_id" "$TEXT_FILE" | head -20 >> "$REPORT_FILE"
    echo "" >> "$REPORT_FILE"
  done
  
  # Generate list of missing appointment IDs with context
  echo "" >> "$REPORT_FILE"
  echo "## Analysis of Missing Appointments" >> "$REPORT_FILE"
  echo "" >> "$REPORT_FILE"
  MISSING_APPTS=$(grep -i "missing\|not found" "$TEXT_FILE" | grep -o -E "[a-f0-9]{24}" | sort | uniq)
  for appt_id in $MISSING_APPTS; do
    echo "### Appointment ID: $appt_id" >> "$REPORT_FILE"
    echo "" >> "$REPORT_FILE"
    grep "$appt_id" "$TEXT_FILE" | head -20 >> "$REPORT_FILE"
    echo "" >> "$REPORT_FILE"
  done
  
  # Check if the issue might be related to IntakeQ API limits or errors
  echo "" >> "$REPORT_FILE"
  echo "## IntakeQ API Issues" >> "$REPORT_FILE"
  echo "" >> "$REPORT_FILE"
  grep -i "api\|rate limit\|timeout\|network" "$TEXT_FILE" | grep -i "error\|failed\|exception" >> "$REPORT_FILE" || echo "No API issues found" >> "$REPORT_FILE"
  
  # Check for database/sheet issues
  echo "" >> "$REPORT_FILE"
  echo "## Database/Sheet Issues" >> "$REPORT_FILE"
  echo "" >> "$REPORT_FILE"
  grep -i "sheet\|database\|row\|cell" "$TEXT_FILE" | grep -i "error\|failed\|exception" >> "$REPORT_FILE" || echo "No database issues found" >> "$REPORT_FILE"
  
  # Extract errors with context
  echo "" >> "$REPORT_FILE"
  echo "## Errors with Context" >> "$REPORT_FILE"
  echo "" >> "$REPORT_FILE"
  grep -i -B 3 -A 3 "error\|exception\|failed" "$TEXT_FILE" | head -50 >> "$REPORT_FILE"
  
  # Create appointments summary table file
  APPOINTMENTS_FILE="$OUTPUT_DIR/appointments-summary.csv"
  echo "Appointment ID,Created,Updated,Cancelled,Errors" > "$APPOINTMENTS_FILE"
  
  for appt_id in $APPOINTMENT_IDS; do
    CREATED_COUNT=$(grep "$appt_id" "$TEXT_FILE" | grep -c -i "Created\|Adding")
    UPDATED_COUNT=$(grep "$appt_id" "$TEXT_FILE" | grep -c -i "Updated\|Updating")
    CANCELLED_COUNT=$(grep "$appt_id" "$TEXT_FILE" | grep -c -i "Cancelled\|Cancelling\|Canceled")
    ERROR_COUNT=$(grep "$appt_id" "$TEXT_FILE" | grep -c -i "error\|failed\|exception")
    echo "$appt_id,$CREATED_COUNT,$UPDATED_COUNT,$CANCELLED_COUNT,$ERROR_COUNT" >> "$APPOINTMENTS_FILE"
  done
  
  echo "Analysis complete. Results saved to:"
  echo "- Report: $REPORT_FILE"
  echo "- Appointments summary: $APPOINTMENTS_FILE"
else
  echo "Failed to convert RTF file to text."
fi