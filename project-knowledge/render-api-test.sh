#!/bin/bash

# Load environment variables
source "../.env"

echo "Testing Render API access..."
echo "Service ID: $RENDER_SERVICE_ID"
echo "API Key length: ${#RENDER_API_KEY} characters"

# First, test service info endpoint
echo -e "\nTesting service info endpoint:"
service_info=$(curl -s -H "Authorization: Bearer $RENDER_API_KEY" "https://api.render.com/v1/services/$RENDER_SERVICE_ID")
echo "$service_info"

# Check for common error patterns
if [[ "$service_info" == *"Not Found"* ]]; then
  echo -e "\nERROR: Service ID not found. Please check the service ID."
elif [[ "$service_info" == *"Unauthorized"* ]]; then
  echo -e "\nERROR: Unauthorized. Please check your API key."
else
  echo -e "\nService info request completed. Check the response above for details."
fi

# Test logs endpoint (with a very small limit)
echo -e "\nTesting logs endpoint:"
logs=$(curl -s -H "Authorization: Bearer $RENDER_API_KEY" "https://api.render.com/v1/services/$RENDER_SERVICE_ID/logs?limit=2")
echo "$logs"

# Check logs response
if [[ "$logs" == *"Not Found"* ]]; then
  echo -e "\nERROR: Logs endpoint not found. Please check the service ID."
elif [[ "$logs" == *"Unauthorized"* ]]; then
  echo -e "\nERROR: Unauthorized for logs. Please check your API key."
else
  echo -e "\nLogs request completed. Check the response above for details."
fi

echo -e "\nAPI test completed."