#!/bin/bash

# Enhanced Render Log Streaming Utility for Catalyst Scheduler
# Focuses on webhook processing and appointment synchronization issues

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Configuration
LOGS_FOLDER="./Render Logs"
DATE_FORMAT=$(date +"%Y%m%d")
LOG_DURATION=3600  # Stream logs for 1 hour by default (in seconds)
TEMP_FOLDER="/tmp/catalyst-logs"
TIME_PERIOD="24h"  # Default time period for logs (24 hours)
TEXT_FILTER=""     # Default text filter (none)

# Load environment variables
source "../.env" 2>/dev/null

# Function to check if required variables are set
check_env_vars() {
  if [ -z "$RENDER_SERVICE_ID" ]; then
    echo -e "${RED}Error: RENDER_SERVICE_ID environment variable is not set${NC}"
    echo "Please set it in your .env file"
    exit 1
  fi
}

# Function to create date folder
create_log_folder() {
  local date_str=$1
  mkdir -p "$LOGS_FOLDER/$date_str"
  mkdir -p "$TEMP_FOLDER"
  echo -e "${GREEN}Created log folder: $LOGS_FOLDER/$date_str${NC}"
}

# Enhanced function to stream logs with filtering options
stream_logs() {
  local date_str=$1
  local duration=$2
  local filter=$3
  local time_period=${4:-$TIME_PERIOD}
  local text_filter=${5:-$TEXT_FILTER}
  local output_file="$LOGS_FOLDER/$date_str/Render_Log_$date_str.md"
  local temp_log_file="$TEMP_FOLDER/render_log_$date_str.log"
  
  echo "# Render Logs - $date_str" > "$output_file"
  echo "" >> "$output_file"
  echo "## Service: Catalyst Scheduler" >> "$output_file"
  echo "## Source: Streamed logs" >> "$output_file"
  echo "## Content Filter: ${filter:-All logs}" >> "$output_file"
  echo "## Time Period: ${time_period:-24h}" >> "$output_file"
  if [ -n "$text_filter" ]; then
    echo "## Text Search: $text_filter" >> "$output_file"
  fi
  echo "" >> "$output_file"
  
  echo -e "${BLUE}Streaming logs for $duration seconds...${NC}"
  echo -e "${YELLOW}Press Ctrl+C to stop streaming early${NC}"
  
  local cmd_text="render logs -r $RENDER_SERVICE_ID --start $time_period --limit 10000 --direction backward"
  if [ -n "$text_filter" ]; then
    cmd_text="$cmd_text --text \"$text_filter\""
  fi
  echo "Streaming command: $cmd_text" >> "$output_file"
  echo "" >> "$output_file"
  
  # Check if render CLI is installed
  if ! command -v render &> /dev/null; then
    echo -e "${RED}Error: render CLI is not installed${NC}"
    echo "Please install it first:"
    echo "  npm install -g @render/cli"
    echo "  render login"
    exit 1
  fi
  
  echo -e "${BLUE}Starting log streaming for $duration seconds...${NC}"
  
  # Run with or without timeout depending on platform
  echo -e "${CYAN}First phase: Collecting all logs...${NC}"
  
  # Use a relative time format instead of exact timestamp (24h = 24 hours ago)
  start_time="$time_period"
  
  # Prepare the command with appropriate parameters - increase limit to 10000 for high volume logs
  log_command="render logs -r \"$RENDER_SERVICE_ID\" --start \"$start_time\" --limit 10000 --direction backward"
  
  # Add text filter if specified
  if [ -n "$text_filter" ]; then
    log_command="$log_command --text \"$text_filter\""
  fi
  
  echo -e "${CYAN}Running command: $log_command${NC}"
  
  # Create a small function to show progress animation
  show_progress() {
    local pid=$1
    local delay=0.5
    local spinstr='|/-\'
    while ps -p $pid > /dev/null; do
      local temp=${spinstr#?}
      printf " [%c] Fetching logs from Render... " "$spinstr"
      local spinstr=$temp${spinstr%"$temp"}
      sleep $delay
      printf "\r"
    done
    printf "                                   \r"
  }
  
  # Execute the log fetch command with progress indication
  echo -e "${YELLOW}This may take a few minutes for large logs. Please be patient...${NC}"
  
  if command -v timeout &> /dev/null; then
    # Linux or systems with timeout command
    timeout $duration bash -c "$log_command" > "$temp_log_file" &
    pid=$!
    show_progress $pid
    wait $pid
  else
    # MacOS (which doesn't have timeout by default)
    # Use perl to implement a timeout
    perl -e "alarm $duration; exec @ARGV" "bash" "-c" "$log_command" > "$temp_log_file" &
    pid=$!
    show_progress $pid
    wait $pid
  fi
  
  # Check if we actually got any logs
  log_size=$(wc -l < "$temp_log_file")
  if [ $log_size -eq 0 ]; then
    echo -e "${RED}No logs were retrieved from Render. Please check your connection and Render API key.${NC}"
    echo -e "${YELLOW}Trying again with interactive mode...${NC}"
    echo -e "${CYAN}Please manually copy the logs from the Render dashboard and paste them into the temp_log_file:${NC}"
    echo -e "${CYAN}$temp_log_file${NC}"
    # Try with a different output format
    render logs -r "$RENDER_SERVICE_ID" --start "$start_time" --limit 10000 --direction backward -o text | tee "$temp_log_file"
  else
    echo -e "${GREEN}Successfully retrieved $log_size lines of logs from Render!${NC}"
  fi
  
  echo -e "${CYAN}Log collection complete. Processing logs...${NC}"
  
  # Apply filters based on the filter option
  if [ "$filter" == "webhook" ]; then
    echo -e "${CYAN}Filtering webhook-related logs only...${NC}"
    grep -i "webhook\|process.*appointment\|intakeq" "$temp_log_file" > "$temp_log_file.filtered"
    filtered_count=$(wc -l < "$temp_log_file.filtered")
    echo -e "${GREEN}Found $filtered_count webhook-related log entries${NC}"
  elif [ "$filter" == "appointment" ]; then
    echo -e "${CYAN}Filtering appointment-related logs only...${NC}"
    grep -i "appointment\|scheduler\|assign.*office\|processing.*event" "$temp_log_file" > "$temp_log_file.filtered"
    filtered_count=$(wc -l < "$temp_log_file.filtered")
    echo -e "${GREEN}Found $filtered_count appointment-related log entries${NC}"
  elif [ "$filter" == "error" ]; then
    echo -e "${CYAN}Filtering error-related logs only...${NC}"
    grep -i "error\|exception\|failed\|warning\|critical" "$temp_log_file" > "$temp_log_file.filtered"
    filtered_count=$(wc -l < "$temp_log_file.filtered")
    echo -e "${GREEN}Found $filtered_count error-related log entries${NC}"
  else
    # No filtering
    cp "$temp_log_file" "$temp_log_file.filtered"
    filtered_count=$(wc -l < "$temp_log_file.filtered")
    echo -e "${GREEN}Using all $filtered_count log entries${NC}"
  fi
  
  # Add line numbers and copy to output file
  echo -e "${CYAN}Adding line numbers and saving to output file...${NC}"
  cat -n "$temp_log_file.filtered" >> "$output_file"
  echo -e "${GREEN}Logs successfully saved to $output_file${NC}"
  
  # Process the logs
  process_logs "$output_file" "$date_str" "$filter"
  
  echo -e "${GREEN}Logs saved to $output_file${NC}"
  echo -e "${YELLOW}Temporary log files stored in $TEMP_FOLDER${NC}"
}

# Enhanced function to process logs with more detailed analysis
process_logs() {
  local log_file=$1
  local date_str=$2
  local filter=$3
  
  echo -e "${CYAN}Processing logs for reports...${NC}"
  
  # Create webhook report
  create_webhook_report "$log_file" "$date_str"
  
  # Create discrepancy report
  create_discrepancy_report "$log_file" "$date_str"
  
  # Create appointment sync analysis report
  create_appointment_sync_report "$log_file" "$date_str"
}

# Enhanced function to create a more detailed webhook log report - optimized for large logs
create_webhook_report() {
  local source_log="$1"
  local date_folder="$2"
  local output_file="$LOGS_FOLDER/$date_folder/Webhook_Log_IntakeQ_$date_folder.md"
  local temp_webhook_file="$TEMP_FOLDER/webhook_entries_$date_folder.txt"
  
  echo -e "${CYAN}Creating webhook processing report...${NC}"
  
  echo "# IntakeQ Webhook Processing Log - $date_folder" > "$output_file"
  echo "" >> "$output_file"
  echo "## Service: Catalyst Scheduler" >> "$output_file"
  echo "" >> "$output_file"
  
  # First extract all webhook-related lines to a temporary file to speed up processing
  echo -e "${CYAN}Extracting webhook entries from logs (this may take a while for large logs)...${NC}"
  grep -i "process.*appointment\|webhook.*appointment\|Received.*webhook.*for appointment\|Processing.*event.*appointment\|handleAppointment" "$source_log" > "$temp_webhook_file"
  
  # Count webhook entries
  local webhook_count=$(wc -l < "$temp_webhook_file")
  echo "Found $webhook_count webhook processing entries." >> "$output_file"
  echo "" >> "$output_file"
  
  # For very large logs, limit detailed analysis to the most recent entries
  if [ "$webhook_count" -gt 500 ]; then
    echo "Showing details for the most recent 500 webhook entries:" >> "$output_file"
    tail -n 500 "$temp_webhook_file" > "$TEMP_FOLDER/recent_webhooks.txt"
    mv "$TEMP_FOLDER/recent_webhooks.txt" "$temp_webhook_file"
  else
    echo "Showing details for all $webhook_count webhook entries:" >> "$output_file"
  fi
  echo "" >> "$output_file"
  
  # Add table header
  echo "| Timestamp | Event Type | Appointment ID | Client ID | Status | Notes |" >> "$output_file"
  echo "|-----------|------------|----------------|-----------|--------|-------|" >> "$output_file"
  
  # Extract webhook processing entries with enhanced pattern matching
  cat "$temp_webhook_file" | while read -r line; do
    # Extract information from the log line
    timestamp=$(echo "$line" | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}' | head -1)
    if [ -z "$timestamp" ]; then
      timestamp=$(echo "$line" | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}' | head -1)
    fi
    
    # Extract event type (Created, Updated, etc.)
    event_type=""
    if [[ "$line" =~ (Created|Updated|Rescheduled|Cancelled|Canceled|Deleted|Form\ Submitted|Intake\ Submitted) ]]; then
      event_type="${BASH_REMATCH[1]}"
    fi
    
    # Extract appointment ID with more flexible pattern matching
    appointment_id=""
    if [[ "$line" =~ appointment[[:space:]]+([a-f0-9]{24}) ]]; then
      appointment_id="${BASH_REMATCH[1]}"
    elif [[ "$line" =~ appointment[[:space:]]+id:?[[:space:]]*([a-f0-9]{24}) ]]; then
      appointment_id="${BASH_REMATCH[1]}"
    elif [[ "$line" =~ \'([a-f0-9]{24})\' ]]; then
      appointment_id="${BASH_REMATCH[1]}"
    elif [[ "$line" =~ \"([a-f0-9]{24})\" ]]; then
      appointment_id="${BASH_REMATCH[1]}"
    fi
    
    # Extract client ID
    client_id=""
    if [[ "$line" =~ client[[:space:]]+([0-9]+) ]]; then
      client_id="${BASH_REMATCH[1]}"
    elif [[ "$line" =~ ClientId:?[[:space:]]*([0-9]+) ]]; then
      client_id="${BASH_REMATCH[1]}"
    fi
    
    # Determine status with more detailed analysis
    status="processing"
    notes=""
    
    if [[ "$line" =~ completed ]]; then
      status="completed"
    elif [[ "$line" =~ failed ]]; then
      status="failed"
      
      # Extract reason for failure if available
      if [[ "$line" =~ error:?[[:space:]]*([^:,]+) ]]; then
        notes="Error: ${BASH_REMATCH[1]}"
      fi
    elif [[ "$line" =~ already\ processed ]]; then
      status="skipped"
      notes="Already processed"
    elif [[ "$line" =~ unable\ to\ find ]]; then
      status="warning"
      notes="Not found in database"
    fi
    
    # Only output if we have an appointment ID
    if [ -n "$appointment_id" ]; then
      echo "| $timestamp | $event_type | $appointment_id | $client_id | $status | $notes |" >> "$output_file"
    fi
  done
  
  # Clean up temporary file
  rm "$temp_webhook_file"
  
  echo -e "${GREEN}Webhook report saved to $output_file${NC}"
}

# Enhanced function to create a more comprehensive discrepancy report - optimized for large logs
create_discrepancy_report() {
  local source_log="$1"
  local date_folder="$2"
  local output_file="$LOGS_FOLDER/$date_folder/Appointment_Discrepancies_$date_folder.md"
  
  echo -e "${CYAN}Creating appointment discrepancy report...${NC}"
  
  echo "# Appointment Processing Discrepancies - $date_folder" > "$output_file"
  echo "" >> "$output_file"
  echo "## Service: Catalyst Scheduler" >> "$output_file"
  echo "" >> "$output_file"
  
  # For large log files, limit number of matches
  local max_matches=100
  
  # Extract failed webhook processing with improved context
  echo "### Failed Webhook Processing" >> "$output_file"
  echo "" >> "$output_file"
  grep -i -B 2 -A 2 "failed\|error\|exception" "$source_log" | grep -i "appointment\|webhook" | head -n $max_matches >> "$output_file" || echo "No failed webhook processing found" >> "$output_file"
  
  # Extract validation issues with more context
  echo "" >> "$output_file"
  echo "### Appointment Validation Issues" >> "$output_file"
  echo "" >> "$output_file"
  grep -i -B 2 -A 2 "validation\|invalid\|missing\|malformed" "$source_log" | grep -i "appointment\|webhook\|payload" | head -n $max_matches >> "$output_file" || echo "No validation issues found" >> "$output_file"
  
  # Extract duplicate processing with context
  echo "" >> "$output_file"
  echo "### Duplicate Appointments" >> "$output_file"
  echo "" >> "$output_file"
  grep -i -B 2 -A 2 "duplicate\|already processed\|already exists" "$source_log" | grep -i "appointment\|webhook" | head -n $max_matches >> "$output_file" || echo "No duplicate appointments found" >> "$output_file"
  
  # Extract appointment conflicts with context
  echo "" >> "$output_file"
  echo "### Appointment Conflicts" >> "$output_file"
  echo "" >> "$output_file"
  grep -i -B 2 -A 2 "conflict\|overlapping\|collision" "$source_log" | grep -i "appointment\|scheduling" | head -n $max_matches >> "$output_file" || echo "No appointment conflicts found" >> "$output_file"
  
  # Extract locking issues with context
  echo "" >> "$output_file"
  echo "### Locking Issues" >> "$output_file"
  echo "" >> "$output_file"
  grep -i -B 2 -A 2 "lock\|acquire\|release" "$source_log" | grep -i "appointment\|scheduler\|singleton" | head -n $max_matches >> "$output_file" || echo "No locking issues found" >> "$output_file"
  
  # Add new section for date validation issues
  echo "" >> "$output_file"
  echo "### Date Validation Issues" >> "$output_file"
  echo "" >> "$output_file"
  grep -i -B 2 -A 2 "date.*invalid\|invalid.*date\|missing.*date\|validating dates" "$source_log" | head -n $max_matches >> "$output_file" || echo "No date validation issues found" >> "$output_file"
  
  # Add new section for office assignment issues
  echo "" >> "$output_file"
  echo "### Office Assignment Issues" >> "$output_file"
  echo "" >> "$output_file"
  grep -i -B 2 -A 2 "office.*assignment\|assign.*office\|no.*office.*available\|TBD" "$source_log" | head -n $max_matches >> "$output_file" || echo "No office assignment issues found" >> "$output_file"
  
  echo -e "${GREEN}Discrepancy report saved to $output_file${NC}"
}

# New function to create appointment sync specific report - optimized for large log files
create_appointment_sync_report() {
  local source_log="$1"
  local date_folder="$2"
  local output_file="$LOGS_FOLDER/$date_folder/Appointment_Sync_Analysis_$date_folder.md"
  
  echo -e "${CYAN}Creating appointment sync analysis report...${NC}"
  
  echo "# Appointment Synchronization Analysis - $date_folder" > "$output_file"
  echo "" >> "$output_file"
  echo "## Service: Catalyst Scheduler" >> "$output_file"
  echo "" >> "$output_file"
  
  # Process logs in smaller chunks for large files
  echo -e "${CYAN}Extracting appointment IDs (this may take a while for large logs)...${NC}"
  
  # Create a temporary file with all appointment IDs
  local temp_appt_file="$TEMP_FOLDER/appointment_ids_$date_folder.txt"
  grep -i "appointment" "$source_log" | grep -oE "[a-f0-9]{24}" | sort | uniq > "$temp_appt_file"
  
  # Count the number of appointments
  local appt_count=$(wc -l < "$temp_appt_file")
  
  # List all unique appointment IDs processed
  echo "### Appointments Processed" >> "$output_file"
  echo "" >> "$output_file"
  echo "Found $appt_count unique appointment IDs processed." >> "$output_file"
  
  # For large logs, limit the detailed analysis to the most recent 100 appointments
  if [ "$appt_count" -gt 100 ]; then
    echo "Showing details for the most recent 100 appointments:" >> "$output_file"
    tail -n 100 "$temp_appt_file" > "$TEMP_FOLDER/recent_appts.txt"
    mv "$TEMP_FOLDER/recent_appts.txt" "$temp_appt_file"
  else
    echo "Showing details for all $appt_count appointments:" >> "$output_file"
  fi
  echo "" >> "$output_file"
  
  # Process each appointment ID more efficiently
  while read -r appointment_id; do
    # Extract relevant logs for this appointment ID to a temporary file
    grep -i "$appointment_id" "$source_log" > "$TEMP_FOLDER/appt_${appointment_id}.log"
    local appt_log="$TEMP_FOLDER/appt_${appointment_id}.log"
    
    # Get processing status for each appointment
    status="Unknown"
    if grep -q "completed" "$appt_log"; then
      status="Completed"
    elif grep -q "failed" "$appt_log"; then
      status="Failed"
    elif grep -q "skipped\|already processed" "$appt_log"; then
      status="Skipped"
    fi
    
    # Get event type if available
    event_type="Unknown"
    if grep -q "Created" "$appt_log"; then
      event_type="Created"
    elif grep -q "Updated" "$appt_log"; then
      event_type="Updated"
    elif grep -q "Cancelled\|Canceled" "$appt_log"; then
      event_type="Cancelled"
    elif grep -q "Deleted" "$appt_log"; then
      event_type="Deleted"
    fi
    
    echo "- Appointment ID: $appointment_id (Event: $event_type, Status: $status)" >> "$output_file"
    
    # Clean up temporary file
    rm "$appt_log"
  done < "$temp_appt_file"
  
  echo -e "${CYAN}Creating summary sections...${NC}"
  
  # Extract recurring appointment info (limit output to avoid overwhelming)
  echo "" >> "$output_file"
  echo "### Recurring Appointments" >> "$output_file"
  echo "" >> "$output_file"
  grep -i "recurring\|recurrence\|series" "$source_log" | head -n 50 >> "$output_file" || echo "No recurring appointment information found" >> "$output_file"
  
  # Extract office assignment decision logs (limit output)
  echo "" >> "$output_file"
  echo "### Office Assignment Decisions" >> "$output_file"
  echo "" >> "$output_file"
  grep -i "office\|assignment\|assigned\|TBD" "$source_log" | grep -i "appointment" | head -n 50 >> "$output_file" || echo "No office assignment information found" >> "$output_file"
  
  # Extract webhook processing times (limit output)
  echo "" >> "$output_file"
  echo "### Webhook Processing Performance" >> "$output_file"
  echo "" >> "$output_file"
  grep -i "processing time\|took\|elapsed\|duration" "$source_log" | head -n 50 >> "$output_file" || echo "No performance timing information found" >> "$output_file"
  
  # Extract idempotency information (limit output)
  echo "" >> "$output_file"
  echo "### Idempotency Keys" >> "$output_file"
  echo "" >> "$output_file"
  grep -i "idempotency\|duplicate\|already processed\|webhook.*processed" "$source_log" | grep -i "appointment" | head -n 50 >> "$output_file" || echo "No idempotency information found" >> "$output_file"
  
  echo -e "${GREEN}Appointment sync analysis report saved to $output_file${NC}"
  
  # Clean up temporary file
  rm "$temp_appt_file"
}

# Function to install and verify Render CLI
install_render_cli() {
  if ! command -v render &> /dev/null; then
    echo -e "${YELLOW}Render CLI not found. Installing...${NC}"
    npm install -g @render/cli
    
    echo -e "${BLUE}Please login to Render:${NC}"
    render login
  else
    echo -e "${GREEN}Render CLI already installed${NC}"
    
    # Verify that we can actually connect to Render
    echo -e "${CYAN}Verifying Render CLI authentication...${NC}"
    render whoami &> /dev/null
    
    if [ $? -ne 0 ]; then
      echo -e "${RED}Render CLI authentication appears to be invalid or expired.${NC}"
      echo -e "${YELLOW}Please log in again:${NC}"
      render login
    else
      echo -e "${GREEN}Render CLI authentication verified!${NC}"
    fi
  fi
  
  # Make sure we have the correct service ID
  if [ -z "$RENDER_SERVICE_ID" ]; then
    echo -e "${RED}RENDER_SERVICE_ID is not set in .env file${NC}"
    echo -e "${YELLOW}Let's try to find it...${NC}"
    
    render list services
    echo ""
    read -p "Enter the service ID for Catalyst Scheduler (srv-xxxxx): " service_id
    
    RENDER_SERVICE_ID="$service_id"
    echo -e "${GREEN}Using service ID: $RENDER_SERVICE_ID${NC}"
  else
    echo -e "${GREEN}Using service ID: $RENDER_SERVICE_ID${NC}"
  fi
}

# Main execution
echo -e "${BLUE}===== Enhanced Render Log Streaming Utility =====${NC}"
echo -e "${BLUE}===== Catalyst Scheduler Appointment Sync Diagnostics =====${NC}"
echo ""

# Check environment variables
check_env_vars

# Install Render CLI if needed
install_render_cli

# Menu for log collection
echo -e "${BLUE}===== Log Collection Options =====${NC}"
echo ""
echo "1. Stream logs from the last 24 hours"
echo "2. Stream webhook-only logs (last 24h)"
echo "3. Stream appointment-only logs (last 24h)"
echo "4. Stream error-only logs (last 24h)"
echo "5. Stream logs from the last week (7d)"
echo "6. Stream all logs from a custom time period"
echo "7. Change streaming duration (current: ${LOG_DURATION}s)"
echo "8. Advanced search with text filters"
echo "q. Quit"
echo ""
read -p "Select an option: " option

case $option in
  1)
    today=$(date +"%Y%m%d")
    create_log_folder "$today"
    stream_logs "$today" "$LOG_DURATION" "" "24h"
    ;;
  2)
    today=$(date +"%Y%m%d")
    create_log_folder "$today"
    stream_logs "$today" "$LOG_DURATION" "webhook" "24h"
    ;;
  3)
    today=$(date +"%Y%m%d")
    create_log_folder "$today"
    stream_logs "$today" "$LOG_DURATION" "appointment" "24h"
    ;;
  4)
    today=$(date +"%Y%m%d")
    create_log_folder "$today"
    stream_logs "$today" "$LOG_DURATION" "error" "24h"
    ;;
  5)
    # Week logs
    today=$(date +"%Y%m%d")
    create_log_folder "$today"
    echo -e "${CYAN}Collecting logs from the last 7 days...${NC}"
    
    echo -e "${BLUE}Select log filter:${NC}"
    echo "1. All logs"
    echo "2. Webhook logs only"
    echo "3. Appointment logs only"
    echo "4. Error logs only"
    read -p "Select filter: " filter_option
    
    case $filter_option in
      1) stream_logs "$today" "$LOG_DURATION" "" "7d" ;;
      2) stream_logs "$today" "$LOG_DURATION" "webhook" "7d" ;;
      3) stream_logs "$today" "$LOG_DURATION" "appointment" "7d" ;;
      4) stream_logs "$today" "$LOG_DURATION" "error" "7d" ;;
      *) stream_logs "$today" "$LOG_DURATION" "" "7d" ;;
    esac
    ;;
  6)
    # Custom time period
    today=$(date +"%Y%m%d")
    create_log_folder "$today"
    
    echo -e "${BLUE}Select time period:${NC}"
    echo "1. Last 24 hours (24h)"
    echo "2. Last 3 days (3d)"
    echo "3. Last week (7d)" 
    echo "4. Last month (30d)"
    echo "5. Custom (e.g., 12h, 2d, 6h)"
    read -p "Select time period: " time_option
    
    case $time_option in
      1) time_period="24h" ;;
      2) time_period="3d" ;;
      3) time_period="7d" ;;
      4) time_period="30d" ;;
      5) 
        read -p "Enter custom time period (e.g., 12h, 2d): " custom_time
        time_period="$custom_time"
        ;;
      *) time_period="24h" ;;
    esac
    
    echo -e "${BLUE}Select log filter:${NC}"
    echo "1. All logs"
    echo "2. Webhook logs only"
    echo "3. Appointment logs only"
    echo "4. Error logs only"
    read -p "Select filter: " filter_option
    
    case $filter_option in
      1) stream_logs "$today" "$LOG_DURATION" "" "$time_period" ;;
      2) stream_logs "$today" "$LOG_DURATION" "webhook" "$time_period" ;;
      3) stream_logs "$today" "$LOG_DURATION" "appointment" "$time_period" ;;
      4) stream_logs "$today" "$LOG_DURATION" "error" "$time_period" ;;
      *) stream_logs "$today" "$LOG_DURATION" "" "$time_period" ;;
    esac
    ;;
  7)
    # Change streaming duration
    read -p "Enter streaming duration in seconds (e.g., 3600 for 1 hour): " new_duration
    LOG_DURATION=$new_duration
    echo -e "${GREEN}Streaming duration set to ${LOG_DURATION}s${NC}"
    
    echo -e "${BLUE}Do you want to collect logs now?${NC}"
    read -p "Collect logs now? (y/n): " collect_now
    
    if [[ $collect_now =~ ^[Yy]$ ]]; then
      today=$(date +"%Y%m%d")
      create_log_folder "$today"
      
      echo -e "${BLUE}Select time period:${NC}"
      echo "1. Last 24 hours (24h)"
      echo "2. Last 3 days (3d)"
      echo "3. Last week (7d)" 
      echo "4. Last month (30d)"
      read -p "Select time period: " time_option
      
      case $time_option in
        1) time_period="24h" ;;
        2) time_period="3d" ;;
        3) time_period="7d" ;;
        4) time_period="30d" ;;
        *) time_period="24h" ;;
      esac
      
      echo -e "${BLUE}Select log filter:${NC}"
      echo "1. All logs"
      echo "2. Webhook logs only"
      echo "3. Appointment logs only"
      echo "4. Error logs only"
      read -p "Select filter: " filter_option
      
      case $filter_option in
        1) stream_logs "$today" "$LOG_DURATION" "" "$time_period" ;;
        2) stream_logs "$today" "$LOG_DURATION" "webhook" "$time_period" ;;
        3) stream_logs "$today" "$LOG_DURATION" "appointment" "$time_period" ;;
        4) stream_logs "$today" "$LOG_DURATION" "error" "$time_period" ;;
        *) stream_logs "$today" "$LOG_DURATION" "" "$time_period" ;;
      esac
    fi
    ;;
  8)
    # Advanced search with text filters
    today=$(date +"%Y%m%d")
    create_log_folder "$today"
    
    echo -e "${BLUE}Enter text to search for in logs:${NC}"
    echo "Examples:"
    echo "  - appointment"
    echo "  - webhook"
    echo "  - \"error processing\""
    echo "  - \"appointment not found\""
    read -p "Search text: " search_text
    
    echo -e "${BLUE}Select time period:${NC}"
    echo "1. Last 24 hours (24h)"
    echo "2. Last 3 days (3d)"
    echo "3. Last week (7d)" 
    echo "4. Last month (30d)"
    read -p "Select time period: " time_option
    
    case $time_option in
      1) time_period="24h" ;;
      2) time_period="3d" ;;
      3) time_period="7d" ;;
      4) time_period="30d" ;;
      *) time_period="24h" ;;
    esac
    
    # Process filter type to handle both CLI filters and text filtering
    read -p "Apply additional content filtering? (webhook, appointment, error) [y/n]: " apply_filter
    if [[ $apply_filter =~ ^[Yy]$ ]]; then
      echo -e "${BLUE}Select additional filter:${NC}"
      echo "1. None"
      echo "2. Webhook logs only"
      echo "3. Appointment logs only"
      echo "4. Error logs only"
      read -p "Select filter: " filter_option
      
      case $filter_option in
        1) stream_logs "$today" "$LOG_DURATION" "" "$time_period" "$search_text" ;;
        2) stream_logs "$today" "$LOG_DURATION" "webhook" "$time_period" "$search_text" ;;
        3) stream_logs "$today" "$LOG_DURATION" "appointment" "$time_period" "$search_text" ;;
        4) stream_logs "$today" "$LOG_DURATION" "error" "$time_period" "$search_text" ;;
        *) stream_logs "$today" "$LOG_DURATION" "" "$time_period" "$search_text" ;;
      esac
    else
      stream_logs "$today" "$LOG_DURATION" "" "$time_period" "$search_text"
    fi
    ;;
  q|Q)
    echo "Exiting..."
    exit 0
    ;;
  *)
    echo -e "${RED}Invalid option. Exiting...${NC}"
    exit 1
    ;;
esac

echo -e "${GREEN}Log processing complete!${NC}"
echo -e "${YELLOW}Reports have been generated in the $LOGS_FOLDER directory${NC}"
echo -e "${CYAN}These reports should help diagnose appointment synchronization issues${NC}"