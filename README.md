# BotCipher Backend

## Deploying to Render — Step by Step

### 1. Push to GitHub
- Create a new repo on github.com
- Upload all these files to the repo

### 2. Create a Render account
- Go to render.com and sign up for free

### 3. Create a new Web Service
- Click **New** → **Web Service**
- Connect your GitHub account
- Select the repo you just created

### 4. Configure the service
- **Name:** botcipher-backend
- **Environment:** Node
- **Build Command:** npm install
- **Start Command:** npm start
- **Plan:** Free

### 5. Add Environment Variables
Click **Environment** and add these one by one:

| Key | Value |
|-----|-------|
| SUPABASE_URL | Your Supabase project URL |
| SUPABASE_SERVICE_ROLE_KEY | Your Supabase service role key |
| RETELL_API_KEY_1 | Your first Retell API key |
| RETELL_AGENT_ID_1 | Your first Retell agent ID |
| RETELL_API_KEY_2 | Second Retell key (optional) |
| RETELL_AGENT_ID_2 | Second Retell agent ID (optional) |
| RETELL_API_KEY_3 | Third Retell key (optional) |
| RETELL_AGENT_ID_3 | Third Retell agent ID (optional) |
| TWILIO_ACCOUNT_SID | Your Twilio account SID |
| TWILIO_AUTH_TOKEN | Your Twilio auth token |
| TWILIO_PHONE_NUMBER | Your Twilio phone number |

### 6. Deploy
- Click **Create Web Service**
- Render will build and deploy automatically
- You will get a URL like: https://botcipher-backend.onrender.com

### 7. Test with fake data
Once deployed hit this endpoint with a POST request:

```
POST https://your-render-url.onrender.com/test/lead
Content-Type: application/json

{
  "client_id": "your-supabase-client-id",
  "name": "John Smith",
  "phone": "+1234567890",
  "email": "john@example.com",
  "offer_seen": "Free roofing inspection"
}
```

You can use Postman, Insomnia, or any API tool to send this request.

### 8. Set Retell webhook URL
In your Retell dashboard set the webhook URL to:
```
https://your-render-url.onrender.com/webhook/retell
```

### 9. Set Meta/n8n webhook URL
Point your Meta lead form or n8n webhook to:
```
https://your-render-url.onrender.com/webhook/meta
```

## Health Check
```
GET https://your-render-url.onrender.com/health
```
Should return: `{ "status": "ok" }`
