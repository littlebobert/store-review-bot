# App Store Review Bot

Azure Functions app that fetches new App Store reviews daily and posts them to Slack.

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure local.settings.json

Edit `local.settings.json` with your credentials:

```json
{
  "Values": {
    "APP_STORE_KEY_ID": "ABC123DEFG",
    "APP_STORE_ISSUER_ID": "12345678-1234-1234-1234-123456789012",
    "APP_STORE_PRIVATE_KEY": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----",
    "APP_ID": "jp.tech.kotoba.app",
    "GOOGLE_PLAY_PACKAGE_NAME": "com.example.app",
    "GOOGLE_SERVICE_ACCOUNT_JSON": "{\"type\":\"service_account\",\"project_id\":\"...\"}",
    "GOOGLE_PLAY_DEVELOPER_ID": "7127907010285966296",
    "GOOGLE_PLAY_CONSOLE_APP_ID": "4975367138904798133",
    "SLACK_WEBHOOK_URL": "https://hooks.slack.com/services/...",
    "AZURE_STORAGE_ACCOUNT": "yourstorageaccount",
    "AZURE_STORAGE_KEY": "your_storage_key"
  }
}
```

**Getting your private key into the config:**

Open your `.p8` file and copy the contents. Replace newlines with `\n`:

```bash
# Quick way to format your .p8 file:
cat AuthKey_XXXXXX.p8 | tr '\n' '~' | sed 's/~/\\n/g'
```

### 3. Run locally

```bash
npm start
```

### 4. Test endpoints

- **Test Slack:** http://localhost:7071/api/testSlack
- **Test App Store API:** http://localhost:7071/api/testAppStore
- **Preview reviews:** http://localhost:7071/api/previewReviews
- **Trigger review post:** http://localhost:7071/api/triggerReviewCheck
- **Test Google Play API:** http://localhost:7071/api/testGooglePlay
- **Preview Google Play reviews:** http://localhost:7071/api/previewGoogleReviews
- **Trigger Google Play review post:** http://localhost:7071/api/triggerGoogleReviewCheck
- **Reset latest Google Play review:** http://localhost:7071/api/resetLatestGoogle
- **Reset all Google Play reviews:** http://localhost:7071/api/resetAllGoogle
- **Mark all Google Play posted (except latest):** http://localhost:7071/api/markAllGooglePosted

## Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/testSlack` | GET/POST | Send test message to Slack |
| `/api/testAppStore` | GET | Verify App Store Connect API credentials |
| `/api/previewReviews` | GET | Fetch and preview reviews (doesn't post) |
| `/api/triggerReviewCheck` | GET/POST | Fetch and post new reviews to Slack |
| `/api/testGooglePlay` | GET | Verify Google Play Developer API credentials |
| `/api/previewGoogleReviews` | GET | Fetch and preview Google Play reviews (doesn't post) |
| `/api/triggerGoogleReviewCheck` | GET/POST | Fetch and post new Google Play reviews to Slack |
| `/api/resetLatestGoogle` | GET/POST | Reset latest Google Play review to be posted again |
| `/api/resetAllGoogle` | GET/POST | Reset all Google Play reviews to be posted again |
| `/api/markAllGooglePosted` | GET/POST | Mark all Google Play reviews as posted (except most recent) |

## Scheduled Run

The `dailyReviewCheck` timer runs at **9:00 AM JST** (midnight UTC) daily.

To change the schedule, edit the cron expression in `functions.js`:

```javascript
app.timer('dailyReviewCheck', {
    schedule: '0 0 0 * * *',  // Every day at midnight UTC
    ...
});
```

## Deploy to Azure

```bash
# Login to Azure
az login

# Create Function App (if not exists)
az functionapp create \
  --resource-group your-resource-group \
  --consumption-plan-location japaneast \
  --runtime node \
  --runtime-version 20 \
  --functions-version 4 \
  --name store-review-bot \
  --storage-account yourstorageaccount

# Deploy
func azure functionapp publish store-review-bot

# Set environment variables in Azure Portal:
# - APP_STORE_KEY_ID
# - APP_STORE_ISSUER_ID
# - APP_STORE_PRIVATE_KEY
# - APP_ID
# - GOOGLE_PLAY_PACKAGE_NAME
# - GOOGLE_SERVICE_ACCOUNT_JSON
# - GOOGLE_PLAY_DEVELOPER_ID (optional, for deep links to individual Play reviews)
# - GOOGLE_PLAY_CONSOLE_APP_ID (optional, for deep links to individual Play reviews)
# - SLACK_WEBHOOK_URL
# - AZURE_STORAGE_ACCOUNT
# - AZURE_STORAGE_KEY
```

## How it works

1. **JWT Authentication**: Generates a signed JWT token using your App Store Connect API key
2. **Fetch Reviews**: Calls the App Store Connect API to get recent customer reviews
3. **Track Posted Reviews**: Uses Azure Table Storage to remember which reviews have been posted
4. **Post to Slack**: Formats and posts new reviews with star ratings, review text, and metadata
