#!/bin/bash
# fetch-full-week-logs.sh

# Configuration
SERVICE_ID="srv-cv0r4ibqf0us73a1kkb0"
END_DATE=${1:-$(date +"%Y-%m-%d")}  # Use provided date or today
START_DATE=$(date -v-7d -j -f "%Y-%m-%d" "$END_DATE" +"%Y-%m-%d")
OUTPUT_DIR="logs"

# Create output directory if it doesn't exist
mkdir -p "$OUTPUT_DIR"

# Final output files
JSON_OUTPUT="$OUTPUT_DIR/catalyst-logs-$START_DATE-to-$END_DATE-complete.json"
TEXT_OUTPUT="$OUTPUT_DIR/catalyst-logs-$START_DATE-to-$END_DATE-complete.txt"

# Clear output files if they exist
> "$JSON_OUTPUT"
> "$TEXT_OUTPUT"

echo "Fetching logs from $START_DATE to $END_DATE (full week) in daily chunks..."

# Process each day
current_date="$START_DATE"
while [[ "$current_date" < "$END_DATE" ]] || [[ "$current_date" == "$END_DATE" ]]; do
    echo "Processing day: $current_date"
    
    # Process this day in 6-hour chunks
    for hour in {0..18..6}; do
        # Format hours with leading zeros
        start_hour=$(printf "%02d" $hour)
        end_hour=$(printf "%02d" $(($hour + 6)))
        
        # If it's the last chunk, make sure it goes to midnight
        if [ $hour -eq 18 ]; then
            end_hour="00"
            # Adjust date for the end time if it's the last chunk
            NEXT_DATE=$(date -v+1d -j -f "%Y-%m-%d" "$current_date" +"%Y-%m-%d")
        else
            NEXT_DATE=$current_date
        fi
        
        START_TIME="${current_date}T${start_hour}:00:00Z"
        END_TIME="${NEXT_DATE}T${end_hour}:00:00Z"
        
        CHUNK_FILE="$OUTPUT_DIR/chunk-${current_date}-${start_hour}-${end_hour}.json"
        
        echo "  Fetching logs from $START_TIME to $END_TIME..."
        render logs --resources "$SERVICE_ID" --start "$START_TIME" --end "$END_TIME" --output json --confirm > "$CHUNK_FILE"
        
        # Check if the chunk has content and is valid JSON
        if [ -s "$CHUNK_FILE" ] && jq empty "$CHUNK_FILE" 2>/dev/null; then
            # Process and append the chunk data
            if [ ! -s "$JSON_OUTPUT" ]; then
                cat "$CHUNK_FILE" > "$JSON_OUTPUT"
            else
                # Merge the JSON
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
            
            # Append readable text entries
            jq -r '.[] | "\(.timestamp) \(.message)"' "$CHUNK_FILE" >> "$TEXT_OUTPUT"
        else
            echo "  Warning: Chunk for $START_TIME to $END_TIME is empty or invalid JSON. Skipping..."
        fi
        
        echo "  Completed chunk ${start_hour}-${end_hour}"
        sleep 1  # Small delay to avoid rate limiting
    done
    
    # Move to next day
    current_date=$(date -v+1d -j -f "%Y-%m-%d" "$current_date" +"%Y-%m-%d")
done

# Clean up chunk files
rm "$OUTPUT_DIR/chunk-"*.json

# Print summary
TOTAL_LINES=$(wc -l < "$TEXT_OUTPUT")
echo "Completed! Downloaded $TOTAL_LINES log entries to:"
echo "- JSON: $JSON_OUTPUT"
echo "- Text: $TEXT_OUTPUT"