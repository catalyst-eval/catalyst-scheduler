#!/bin/bash
# fetch-full-day-logs.sh

# Configuration
SERVICE_ID="srv-cv0r4ibqf0us73a1kkb0"
DATE=${1:-$(date +"%Y-%m-%d")}  # Use provided date or today
OUTPUT_DIR="logs"

# Create output directory if it doesn't exist
mkdir -p "$OUTPUT_DIR"

# Final output files
JSON_OUTPUT="$OUTPUT_DIR/catalyst-logs-$DATE-complete.json"
TEXT_OUTPUT="$OUTPUT_DIR/catalyst-logs-$DATE-complete.txt"

# Clear output files if they exist
> "$JSON_OUTPUT"
> "$TEXT_OUTPUT"

echo "Fetching logs for $DATE in 2-hour chunks..."

# Define time chunks (12 chunks of 2 hours each)
for hour in {0..22..2}; do
    # Format hours with leading zeros
    start_hour=$(printf "%02d" $hour)
    end_hour=$(printf "%02d" $(($hour + 2)))
    
    # If it's the last chunk, make sure it goes to midnight
    if [ $hour -eq 22 ]; then
        end_hour="00"
        # Adjust date for the end time if it's the last chunk
        END_DATE=$(date -v+1d -j -f "%Y-%m-%d" "$DATE" +"%Y-%m-%d")
    else
        END_DATE=$DATE
    fi
    
    START_TIME="${DATE}T${start_hour}:00:00Z"
    END_TIME="${END_DATE}T${end_hour}:00:00Z"
    
    CHUNK_FILE="$OUTPUT_DIR/chunk-${DATE}-${start_hour}-${end_hour}.json"
    
    echo "Fetching logs from $START_TIME to $END_TIME..."
    render logs --resources "$SERVICE_ID" --start "$START_TIME" --end "$END_TIME" --output json --confirm > "$CHUNK_FILE"
    
    # Check if the chunk has content and is valid JSON
    if [ -s "$CHUNK_FILE" ] && jq empty "$CHUNK_FILE" 2>/dev/null; then
        # For the first chunk, copy the entire content
        if [ ! -s "$JSON_OUTPUT" ]; then
            cat "$CHUNK_FILE" > "$JSON_OUTPUT"
        else
            # For subsequent chunks, extract the logs array and append
            LOGS_ARRAY=$(jq 'if type == "object" then .logs else . end' "$CHUNK_FILE")
            
            # Check if we have a logs array in the output file
            if jq -e '.logs' "$JSON_OUTPUT" >/dev/null 2>&1; then
                # Append to logs array
                jq --argjson new "$LOGS_ARRAY" '.logs += $new' "$JSON_OUTPUT" > "$JSON_OUTPUT.tmp"
                mv "$JSON_OUTPUT.tmp" "$JSON_OUTPUT"
            else
                # Handle case where output is just an array
                jq -s '.[0] + .[1]' "$JSON_OUTPUT" "$CHUNK_FILE" > "$JSON_OUTPUT.tmp"
                mv "$JSON_OUTPUT.tmp" "$JSON_OUTPUT"
            fi
        fi
        
        # Create readable text entries
        jq -r '.[] | "\(.timestamp) \(.message)"' "$CHUNK_FILE" >> "$TEXT_OUTPUT"
    else
        echo "Warning: Chunk file is empty or invalid JSON. Skipping..."
    fi
    
    echo "Completed chunk ${start_hour}-${end_hour}"
    sleep 1  # Small delay to avoid rate limiting
done

# Clean up chunk files
rm "$OUTPUT_DIR/chunk-$DATE-"*.json

# Print summary
TOTAL_LINES=$(wc -l < "$TEXT_OUTPUT")
echo "Completed! Downloaded $TOTAL_LINES log entries to:"
echo "- JSON: $JSON_OUTPUT"
echo "- Text: $TEXT_OUTPUT"