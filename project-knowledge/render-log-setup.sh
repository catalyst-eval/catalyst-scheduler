#!/bin/bash

# Script to help set up Render API access and collect logs
# This script guides you through setting up Render API access and collecting logs

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
ENV_FILE="../.env"
LOGS_FOLDER="./Render Logs"
DATE_FORMAT=$(date +"%Y%m%d")

# Function to check if jq is installed
check_jq() {
  if ! command -v jq &> /dev/null; then
    echo -e "${RED}Error: jq is not installed and is required for JSON processing${NC}"
    echo "You can install it with:"
    echo "  brew install jq  # on macOS with Homebrew"
    echo "  apt-get install jq  # on Ubuntu/Debian"
    exit 1
  fi
}

# Function to check if required variables are set
check_env_vars() {
  source "$ENV_FILE" 2>/dev/null
  
  if [ -z "$RENDER_API_KEY" ]; then
    echo -e "${YELLOW}Warning: RENDER_API_KEY is not set in $ENV_FILE${NC}"
    return 1
  fi
  
  if [ -z "$RENDER_SERVICE_ID" ]; then
    echo -e "${YELLOW}Warning: RENDER_SERVICE_ID is not set in $ENV_FILE${NC}"
    return 1
  fi
  
  return 0
}

# Function to guide user through getting an API key
setup_api_key() {
  echo -e "${BLUE}==== Setting up Render API Key ====${NC}"
  echo ""
  echo "To get your Render API key:"
  echo "1. Log in to your Render dashboard at https://dashboard.render.com"
  echo "2. Click on your user icon in the top right corner"
  echo "3. Select 'Account Settings'"
  echo "4. Scroll down to the 'API Keys' section"
  echo "5. Click 'New API Key', give it a name like 'Log Collection'"
  echo "6. Copy the generated API key"
  echo ""
  
  read -p "Have you generated and copied your API key? (y/n) " -n 1 -r
  echo ""
  
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Please generate an API key and run this script again."
    exit 1
  fi
  
  read -p "Enter your Render API key: " api_key
  echo ""
  
  # Update the .env file with the API key
  if grep -q "RENDER_API_KEY=" "$ENV_FILE"; then
    sed -i '' "s|RENDER_API_KEY=.*|RENDER_API_KEY=\"$api_key\"|" "$ENV_FILE"
  else
    echo "RENDER_API_KEY=\"$api_key\"" >> "$ENV_FILE"
  fi
  
  echo -e "${GREEN}API key saved to $ENV_FILE${NC}"
  export RENDER_API_KEY="$api_key"
}

# Function to guide user through getting service ID
setup_service_id() {
  echo -e "${BLUE}==== Getting Render Service ID ====${NC}"
  echo ""
  
  # Check if we have an API key to use
  if [ -z "$RENDER_API_KEY" ]; then
    echo -e "${RED}Error: RENDER_API_KEY is not set. Please set up the API key first.${NC}"
    exit 1
  fi
  
  echo "Fetching your services from Render..."
  services_json=$(curl -s -H "Authorization: Bearer $RENDER_API_KEY" https://api.render.com/v1/services)
  
  # Check if the API call was successful
  if [[ $services_json == *"error"* ]]; then
    echo -e "${RED}Error fetching services from Render:${NC}"
    echo "$services_json" | jq -r '.error'
    exit 1
  fi
  
  # Extract service information
  echo "Available services:"
  echo "$services_json" | jq -r '.[] | "\(.id): \(.name) (\(.type)) - \(.serviceDetails.url)"'
  echo ""
  
  # Look for catalyst-scheduler
  catalyst_id=$(echo "$services_json" | jq -r '.[] | select(.name | contains("catalyst") or contains("Catalyst") or contains("scheduler") or contains("Scheduler")) | .id')
  
  if [ -n "$catalyst_id" ]; then
    echo -e "${GREEN}Found potential Catalyst Scheduler service with ID: $catalyst_id${NC}"
    read -p "Is this the correct service? (y/n) " -n 1 -r
    echo ""
    
    if [[ $REPLY =~ ^[Yy]$ ]]; then
      service_id="$catalyst_id"
    else
      read -p "Enter the service ID from the list above: " service_id
    fi
  else
    read -p "Enter the service ID for your Catalyst Scheduler from the list above: " service_id
  fi
  
  # Update the .env file with the service ID
  if grep -q "RENDER_SERVICE_ID=" "$ENV_FILE"; then
    sed -i '' "s|RENDER_SERVICE_ID=.*|RENDER_SERVICE_ID=\"$service_id\"|" "$ENV_FILE"
  else
    echo "RENDER_SERVICE_ID=\"$service_id\"" >> "$ENV_FILE"
  fi
  
  echo -e "${GREEN}Service ID saved to $ENV_FILE${NC}"
  export RENDER_SERVICE_ID="$service_id"
}

# Function to fetch logs from Render
fetch_render_logs() {
  local start_date=$1
  local end_date=$2
  local log_folder="$LOGS_FOLDER/$(date -j -f "%Y-%m-%d" "$start_date" +"%Y%m%d")"
  
  # Create logs folder
  mkdir -p "$log_folder"
  
  local log_file="$log_folder/Render_Log_$(date -j -f "%Y-%m-%d" "$start_date" +"%Y%m%d").md"
  
  echo "# Render Logs - $start_date" > "$log_file"
  echo "" >> "$log_file"
  echo "## Service: Catalyst Scheduler" >> "$log_file"
  echo "## Time Range: $start_date to $end_date" >> "$log_file"
  echo "" >> "$log_file"
  
  echo -e "${BLUE}Fetching logs from $start_date to $end_date...${NC}"
  
  # Convert dates to ISO 8601 format for the API
  local start_time=$(date -j -f "%Y-%m-%d" "$start_date" +"%Y-%m-%dT00:00:00Z")
  local end_time=$(date -j -f "%Y-%m-%d" "$end_date" +"%Y-%m-%dT23:59:59Z")
  
  # Fetch logs using Render API - this might need to be paginated for large log volumes
  curl -s -H "Authorization: Bearer $RENDER_API_KEY" \
    "https://api.render.com/v1/services/$RENDER_SERVICE_ID/logs?startTime=$start_time&endTime=$end_time" | \
    jq -r '.[] | "\(.timestamp) [\(.level)]:\n\(.message)\n"' >> "$log_file" || {
      echo -e "${RED}Error fetching logs from Render API${NC}"
      exit 1
    }
  
  echo -e "${GREEN}Logs saved to $log_file${NC}"
  
  # Create the webhook log report
  create_webhook_report "$log_file" "$log_folder"
  
  # Create the discrepancy report
  create_discrepancy_report "$log_file" "$log_folder"
}

# Function to create a webhook log report
create_webhook_report() {
  local source_log="$1"
  local target_folder="$2"
  local log_date=$(basename "$target_folder")
  local log_file="$target_folder/Webhook_Log_IntakeQ_$log_date.md"
  
  echo "# IntakeQ Webhook Processing Log - $log_date" > "$log_file"
  echo "" >> "$log_file"
  echo "## Service: Catalyst Scheduler" >> "$log_file"
  echo "" >> "$log_file"
  echo "| Timestamp | Event Type | Appointment ID | Status | Retry Count | Completion Time |" >> "$log_file"
  echo "|-----------|------------|----------------|--------|-------------|-----------------|" >> "$log_file"
  
  # Extract webhook log entries from the Render logs
  grep -A 2 "Processing.*event for appointment" "$source_log" | \
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
  
  echo -e "${GREEN}Webhook log report saved to $log_file${NC}"
}

# Function to create a discrepancy report
create_discrepancy_report() {
  local source_log="$1"
  local target_folder="$2"
  local log_date=$(basename "$target_folder")
  local log_file="$target_folder/Appointment_Discrepancies_$log_date.md"
  
  echo "# Appointment Processing Discrepancies - $log_date" > "$log_file"
  echo "" >> "$log_file"
  echo "## Service: Catalyst Scheduler" >> "$log_file"
  echo "" >> "$log_file"
  
  # Extract information about missing or failed appointments
  echo "### Failed Webhook Processing" >> "$log_file"
  echo "" >> "$log_file"
  grep -B 1 -A 1 "failed" "$source_log" | \
    grep -v "\-\-" >> "$log_file" || echo "No failed webhook processing found" >> "$log_file"
  
  echo "" >> "$log_file"
  echo "### Appointment Validation Issues" >> "$log_file"
  echo "" >> "$log_file"
  grep -B 1 -A 1 "validation\|invalid\|missing" "$source_log" | \
    grep -v "\-\-" >> "$log_file" || echo "No validation issues found" >> "$log_file"
  
  # Extract information about duplicate appointments
  echo "" >> "$log_file"
  echo "### Duplicate Appointments" >> "$log_file"
  echo "" >> "$log_file"
  grep -B 1 -A 1 "duplicate\|already processed" "$source_log" | \
    grep -v "\-\-" >> "$log_file" || echo "No duplicate appointments found" >> "$log_file"
  
  echo -e "${GREEN}Discrepancy report saved to $log_file${NC}"
}

# Function to collect logs for a date range
collect_logs_range() {
  local start_date=$1
  local end_date=$2
  
  # Create logs folder if it doesn't exist
  mkdir -p "$LOGS_FOLDER"
  
  # Loop through each day in the range
  current_date="$start_date"
  while [[ "$current_date" < "$end_date" || "$current_date" == "$end_date" ]]; do
    next_date=$(date -j -v+1d -f "%Y-%m-%d" "$current_date" +"%Y-%m-%d")
    fetch_render_logs "$current_date" "$next_date"
    current_date="$next_date"
  done
}

# Main execution
check_jq

echo -e "${BLUE}===== Render Log Setup and Collection =====${NC}"
echo ""

# Check and setup environment variables
if ! check_env_vars; then
  echo -e "${YELLOW}Setting up required configuration...${NC}"
  
  # Setup API key if needed
  if [ -z "$RENDER_API_KEY" ]; then
    setup_api_key
  fi
  
  # Setup service ID if needed
  if [ -z "$RENDER_SERVICE_ID" ]; then
    setup_service_id
  fi
fi

# Source the updated environment variables
source "$ENV_FILE"

# Menu for log collection
echo -e "${BLUE}===== Log Collection =====${NC}"
echo ""
echo "1. Collect logs for today"
echo "2. Collect logs from a specific date"
echo "3. Collect logs from April 7, 2025 to today (full range since scheduler singleton)"
echo "4. Collect logs for a custom date range"
echo "q. Quit"
echo ""
read -p "Select an option: " option

case $option in
  1)
    today=$(date +"%Y-%m-%d")
    fetch_render_logs "$today" "$today"
    ;;
  2)
    read -p "Enter date (YYYY-MM-DD): " specific_date
    fetch_render_logs "$specific_date" "$specific_date"
    ;;
  3)
    start_date="2025-04-07"
    end_date=$(date +"%Y-%m-%d")
    collect_logs_range "$start_date" "$end_date"
    ;;
  4)
    read -p "Enter start date (YYYY-MM-DD): " start_date
    read -p "Enter end date (YYYY-MM-DD): " end_date
    collect_logs_range "$start_date" "$end_date"
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

echo -e "${GREEN}Done!${NC}"