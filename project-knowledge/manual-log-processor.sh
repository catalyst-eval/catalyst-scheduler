#!/bin/bash

# Script to process logs that are manually downloaded from Render
# This is useful when API access isn't working properly

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
LOGS_FOLDER="./Render Logs"
LOG_FILENAME="manual_render_log.txt"

# Function to process a manually saved log file
process_log_file() {
  local log_file="$1"
  local date_folder="$2"
  
  # Create output folder
  mkdir -p "$LOGS_FOLDER/$date_folder"
  
  # Create markdown formatted log file
  local output_file="$LOGS_FOLDER/$date_folder/Render_Log_$date_folder.md"
  
  echo "# Render Logs - $date_folder" > "$output_file"
  echo "" >> "$output_file"
  echo "## Service: Catalyst Scheduler" >> "$output_file"
  echo "## Source: Manually downloaded logs" >> "$output_file"
  echo "" >> "$output_file"
  
  # Copy log content
  cat "$log_file" >> "$output_file"
  
  echo -e "${GREEN}Logs processed and saved to $output_file${NC}"
  
  # Process logs to extract webhook information
  create_webhook_report "$output_file" "$date_folder"
  
  # Create discrepancy report
  create_discrepancy_report "$output_file" "$date_folder"
}

# Function to create a webhook log report
create_webhook_report() {
  local source_log="$1"
  local date_folder="$2"
  local output_file="$LOGS_FOLDER/$date_folder/Webhook_Log_IntakeQ_$date_folder.md"
  
  echo "# IntakeQ Webhook Processing Log - $date_folder" > "$output_file"
  echo "" >> "$output_file"
  echo "## Service: Catalyst Scheduler" >> "$output_file"
  echo "" >> "$output_file"
  echo "| Timestamp | Event Type | Appointment ID | Status |" >> "$output_file"
  echo "|-----------|------------|----------------|--------|" >> "$output_file"
  
  # Extract webhook processing entries
  grep -i "process.*appointment\|webhook.*appointment" "$source_log" | while read -r line; do
    # Extract information from the log line
    timestamp=$(echo "$line" | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}' | head -1)
    
    # Extract event type (Created, Updated, etc.)
    event_type=""
    if [[ "$line" =~ (Created|Updated|Rescheduled|Cancelled|Canceled|Deleted) ]]; then
      event_type="${BASH_REMATCH[1]}"
    fi
    
    # Extract appointment ID
    appointment_id=""
    if [[ "$line" =~ appointment[[:space:]]+([a-z0-9]+) ]]; then
      appointment_id="${BASH_REMATCH[1]}"
    fi
    
    # Determine status
    status="processing"
    if [[ "$line" =~ completed ]]; then
      status="completed"
    elif [[ "$line" =~ failed ]]; then
      status="failed"
    fi
    
    # Only output if we have an appointment ID
    if [ -n "$appointment_id" ]; then
      echo "| $timestamp | $event_type | $appointment_id | $status |" >> "$output_file"
    fi
  done
  
  echo -e "${GREEN}Webhook report saved to $output_file${NC}"
}

# Function to create a discrepancy report
create_discrepancy_report() {
  local source_log="$1"
  local date_folder="$2"
  local output_file="$LOGS_FOLDER/$date_folder/Appointment_Discrepancies_$date_folder.md"
  
  echo "# Appointment Processing Discrepancies - $date_folder" > "$output_file"
  echo "" >> "$output_file"
  echo "## Service: Catalyst Scheduler" >> "$output_file"
  echo "" >> "$output_file"
  
  # Extract failed webhook processing
  echo "### Failed Webhook Processing" >> "$output_file"
  echo "" >> "$output_file"
  grep -i "failed\|error\|exception" "$source_log" | grep -i "appointment\|webhook" >> "$output_file" || echo "No failed webhook processing found" >> "$output_file"
  
  # Extract validation issues
  echo "" >> "$output_file"
  echo "### Appointment Validation Issues" >> "$output_file"
  echo "" >> "$output_file"
  grep -i "validation\|invalid\|missing" "$source_log" | grep -i "appointment\|webhook" >> "$output_file" || echo "No validation issues found" >> "$output_file"
  
  # Extract duplicate processing
  echo "" >> "$output_file"
  echo "### Duplicate Appointments" >> "$output_file"
  echo "" >> "$output_file"
  grep -i "duplicate\|already processed" "$source_log" | grep -i "appointment\|webhook" >> "$output_file" || echo "No duplicate appointments found" >> "$output_file"
  
  echo -e "${GREEN}Discrepancy report saved to $output_file${NC}"
}

# Main execution
echo -e "${BLUE}===== Manual Render Log Processor =====${NC}"
echo ""
echo "This script processes logs that you've manually downloaded from the Render dashboard."
echo "To download logs from Render:"
echo "1. Log in to your Render dashboard"
echo "2. Go to your Catalyst Scheduler service"
echo "3. Click on the 'Logs' tab"
echo "4. Use the date filter to select the desired date range"
echo "5. Click 'Download' to save the logs"
echo "6. Save the file as 'manual_render_log.txt' in this directory"
echo ""

# Check if log file exists
if [ ! -f "$LOG_FILENAME" ]; then
  echo -e "${YELLOW}Warning: Log file '$LOG_FILENAME' not found in the current directory${NC}"
  echo "Please download logs from Render and save them as '$LOG_FILENAME' in this directory."
  echo ""
  
  read -p "Do you want to specify a different log file? (y/n) " -n 1 -r
  echo ""
  
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    read -p "Enter the path to the log file: " user_log_file
    LOG_FILENAME="$user_log_file"
    
    if [ ! -f "$LOG_FILENAME" ]; then
      echo -e "${RED}Error: File '$LOG_FILENAME' not found${NC}"
      exit 1
    fi
  else
    echo "Exiting..."
    exit 0
  fi
fi

# Ask for the date of the logs
read -p "Enter the date for these logs (YYYYMMDD): " date_folder

# Process the log file
process_log_file "$LOG_FILENAME" "$date_folder"

echo -e "${GREEN}Log processing complete!${NC}"