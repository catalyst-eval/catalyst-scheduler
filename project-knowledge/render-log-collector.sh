#!/bin/bash

# Script to extract and store Render logs for debugging purposes
# Place this script in the project-knowledge directory

# Configuration
LOGS_FOLDER="./Render Logs"
DATE_FORMAT=$(date +"%Y%m%d")
RENDER_API_KEY="${RENDER_API_KEY}"
SERVICE_ID="${RENDER_SERVICE_ID}"  # Your Render service ID

# Create logs folder if it doesn't exist
mkdir -p "$LOGS_FOLDER"
mkdir -p "$LOGS_FOLDER/$DATE_FORMAT"

# Function to check if required variables are set
check_env_vars() {
  if [ -z "$RENDER_API_KEY" ]; then
    echo "Error: RENDER_API_KEY environment variable is not set"
    echo "Please set it with: export RENDER_API_KEY=your_api_key"
    exit 1
  fi
  
  if [ -z "$SERVICE_ID" ]; then
    echo "Error: SERVICE_ID environment variable is not set"
    echo "Please set it with: export SERVICE_ID=your_service_id"
    exit 1
  fi
}

# Function to fetch logs from Render
fetch_render_logs() {
  local hours=$1
  local log_file="$LOGS_FOLDER/$DATE_FORMAT/Render_Log_$DATE_FORMAT.md"
  
  echo "# Render Logs - $(date '+%Y-%m-%d %H:%M:%S')" > "$log_file"
  echo "" >> "$log_file"
  echo "## Service: Catalyst Scheduler" >> "$log_file"
  echo "## Time Range: Last $hours hours" >> "$log_file"
  echo "" >> "$log_file"
  
  echo "Fetching logs for the last $hours hours..."
  
  # Calculate timestamp for the start time (current time - hours)
  local start_time=$(date -u -v-${hours}H +"%Y-%m-%dT%H:%M:%SZ")
  
  # Fetch logs using Render API
  curl -s -H "Authorization: Bearer $RENDER_API_KEY" \
    "https://api.render.com/v1/services/$SERVICE_ID/logs?startTime=$start_time" | \
    jq -r '.[] | "\(.timestamp) [\(.level)]:\n\(.message)\n"' >> "$log_file" || {
      echo "Error fetching logs from Render API"
      exit 1
    }
  
  echo "Logs saved to $log_file"
}

# Function to create a webhook log report
create_webhook_log_report() {
  local log_file="$LOGS_FOLDER/$DATE_FORMAT/Webhook_Log_IntakeQ_$DATE_FORMAT.md"
  
  echo "# IntakeQ Webhook Processing Log - $(date '+%Y-%m-%d %H:%M:%S')" > "$log_file"
  echo "" >> "$log_file"
  echo "## Service: Catalyst Scheduler" >> "$log_file"
  echo "" >> "$log_file"
  echo "| Timestamp | Event Type | Appointment ID | Status | Retry Count | Completion Time |" >> "$log_file"
  echo "|-----------|------------|----------------|--------|-------------|-----------------|" >> "$log_file"
  
  # Extract webhook log entries from the Render logs
  grep -A 2 "Processing.*event for appointment" "$LOGS_FOLDER/$DATE_FORMAT/Render_Log_$DATE_FORMAT.md" | \
    grep -v "\-\-" | \
    awk 'BEGIN {OFS="|"; count=0; ts=""; event=""; appt=""; status="processing"; retry=0; complete=""}
      /Processing/ {
        if (count > 0) print ts, event, appt, status, retry, complete;
        ts=$1; 
        match($0, /Processing ([^ ]+) event/, arr); event=arr[1];
        match($0, /appointment ([^ ]+)/, arr); appt=arr[1];
        status="processing"; retry=0; complete="";
        count++;
      }
      /completed/ {status="completed"; complete=$1}
      /failed/ {status="failed"; match($0, /retries: ([0-9]+)/, arr); retry=arr[1]}
      END {print ts, event, appt, status, retry, complete}' >> "$log_file"
  
  echo "Webhook log report saved to $log_file"
}

# Function to create an appointment discrepancy report
create_discrepancy_report() {
  local log_file="$LOGS_FOLDER/$DATE_FORMAT/Appointment_Discrepancies_$DATE_FORMAT.md"
  
  echo "# Appointment Processing Discrepancies - $(date '+%Y-%m-%d %H:%M:%S')" > "$log_file"
  echo "" >> "$log_file"
  echo "## Service: Catalyst Scheduler" >> "$log_file"
  echo "" >> "$log_file"
  
  # Extract information about missing or failed appointments
  echo "### Failed Webhook Processing" >> "$log_file"
  echo "" >> "$log_file"
  grep -B 1 -A 1 "failed" "$LOGS_FOLDER/$DATE_FORMAT/Render_Log_$DATE_FORMAT.md" | \
    grep -v "\-\-" >> "$log_file"
  
  echo "" >> "$log_file"
  echo "### Appointment Validation Issues" >> "$log_file"
  echo "" >> "$log_file"
  grep -B 1 -A 1 "validation\|invalid\|missing" "$LOGS_FOLDER/$DATE_FORMAT/Render_Log_$DATE_FORMAT.md" | \
    grep -v "\-\-" >> "$log_file"
  
  # Extract information about duplicate appointments
  echo "" >> "$log_file"
  echo "### Duplicate Appointments" >> "$log_file"
  echo "" >> "$log_file"
  grep -B 1 -A 1 "duplicate\|already processed" "$LOGS_FOLDER/$DATE_FORMAT/Render_Log_$DATE_FORMAT.md" | \
    grep -v "\-\-" >> "$log_file"
  
  echo "Discrepancy report saved to $log_file"
}

# Main execution
check_env_vars

# Menu for selecting action
echo "===== Render Log Collector ====="
echo "1. Collect logs from the last 24 hours"
echo "2. Collect logs from the last 48 hours"
echo "3. Collect logs from the last 7 days"
echo "4. Generate webhook log report (after collecting logs)"
echo "5. Generate appointment discrepancy report (after collecting logs)"
echo "q. Quit"
echo ""
read -p "Select an option: " option

case $option in
  1)
    fetch_render_logs 24
    ;;
  2)
    fetch_render_logs 48
    ;;
  3)
    fetch_render_logs 168  # 7 days = 168 hours
    ;;
  4)
    if [ ! -f "$LOGS_FOLDER/$DATE_FORMAT/Render_Log_$DATE_FORMAT.md" ]; then
      echo "Error: Render logs not found. Please collect logs first."
      exit 1
    fi
    create_webhook_log_report
    ;;
  5)
    if [ ! -f "$LOGS_FOLDER/$DATE_FORMAT/Render_Log_$DATE_FORMAT.md" ]; then
      echo "Error: Render logs not found. Please collect logs first."
      exit 1
    fi
    create_discrepancy_report
    ;;
  q|Q)
    echo "Exiting..."
    exit 0
    ;;
  *)
    echo "Invalid option. Exiting..."
    exit 1
    ;;
esac

echo "Done!"