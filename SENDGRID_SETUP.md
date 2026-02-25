# SendGrid Email Template Setup Guide

## Overview
This guide connects your six SendGrid dynamic templates with The Ultimate Journey platform.

## Template List
1. **sponsored_denied_v1** - Decline sponsorship requests
2. **sponsored_approved_v1** - Approve sponsorship partnerships
3. **birthday_send_v1** - Birthday greetings and special offers
4. **internal_signup_notification_v1** - Admin alerts for new signups
5. **boarding_pass_paid_v1** - Premium tier access credentials
6. **boarding_pass_free_v1** - Free tier onboarding

---

## Step 1: Get SendGrid Template IDs

1. Go to [SendGrid Dynamic Templates](https://mc.sendgrid.com/dynamic-templates)
2. For each template, click on it and copy the Template ID (format: `d-xxxxxx`)
3. Record these IDs:

```
sponsored_denied_v1:     d-________________
sponsored_approved_v1:   d-________________
birthday_send_v1:        d-________________
internal_signup_notification_v1: d-________________
boarding_pass_paid_v1:   d-________________
boarding_pass_free_v1:   d-________________
```

---

## Step 2: Create SendGrid API Key

1. Go to **Settings** > **API Keys** in SendGrid
2. Click **Create API Key**
3. Name it: `Ultimate-Journey-Integration`
4. Permissions: **Full Access** (or at minimum: Mail Send)
5. Copy the API key (you'll only see this once!)

---

## Step 3: Configure Environment Variables

### Option A: Netlify Environment Variables
1. Go to your Netlify site dashboard
2. Navigate to **Site Settings** > **Environment Variables**
3. Add these variables:

```
SENDGRID_API_KEY = <your_api_key>
SENDGRID_FROM_EMAIL = noreply@thispagedoesnotexist12345.com
ADMIN_EMAIL = <your_email>

TEMPLATE_SPONSORED_DENIED = d-xxxxxx
TEMPLATE_SPONSORED_APPROVED = d-xxxxxx
TEMPLATE_BIRTHDAY = d-xxxxxx
TEMPLATE_SIGNUP_NOTIFICATION = d-xxxxxx
TEMPLATE_BOARDING_PAID = d-xxxxxx
TEMPLATE_BOARDING_FREE = d-xxxxxx
```

### Option B: Local .env File (for testing)
```bash
# Create .env file in your project root
SENDGRID_API_KEY=your_api_key_here
SENDGRID_FROM_EMAIL=noreply@thispagedoesnotexist12345.com
ADMIN_EMAIL=your.email@example.com
```

⚠️ **Important**: Add `.env` to your `.gitignore` file!

---

## Step 4: Template Dynamic Data Requirements

Each template expects specific dynamic data fields:

### 1. `internal_signup_notification_v1`
```json
{
  "user_name": "String",
  "user_email": "String",
  "signup_date": "ISO DateTime",
  "signup_source": "String",
  "user_ip": "String",
  "first_path_chosen": "String (Signal/Systems/Support)"
}
```

### 2. `boarding_pass_free_v1`
```json
{
  "user_name": "String",
  "access_level": "Free Tier",
  "features": ["Array of strings"],
  "activation_date": "ISO DateTime",
  "next_flight_date": "2026-03-21",
  "puzzle_hint": "String",
  "newsletter_url": "URL",
  "dashboard_url": "URL"
}
```

### 3. `boarding_pass_paid_v1`
```json
{
  "user_name": "String",
  "access_level": "Premium Tier",
  "payment_amount": "String",
  "transaction_id": "String",
  "features": ["Array of strings"],
  "activation_date": "ISO DateTime",
  "next_flight_date": "2026-03-21",
  "premium_dashboard_url": "URL",
  "special_unlock": "String"
}
```

### 4. `birthday_send_v1`
```json
{
  "user_name": "String",
  "birthday_year": "Number",
  "special_offer": "String",
  "gift_message": "String",
  "cta_url": "URL"
}
```

### 5. `sponsored_approved_v1`
```json
{
  "sponsor_name": "String",
  "sponsor_company": "String",
  "approval_date": "ISO DateTime",
  "sponsorship_tier": "String",
  "next_steps": ["Array of strings"],
  "contact_email": "String",
  "portal_url": "URL"
}
```

### 6. `sponsored_denied_v1`
```json
{
  "sponsor_name": "String",
  "denial_reason": "String",
  "denial_date": "ISO DateTime",
  "alternative_options": ["Array of strings"],
  "feedback_message": "String"
}
```

---

## Step 5: Update SendGrid Templates

For each template in SendGrid, ensure the dynamic fields match the data structure above.

### Example Template Code (Boarding Pass Free)
```handlebars
<h1>🚀 Welcome Aboard, {{user_name}}!</h1>

<p>Your boarding pass for <strong>{{access_level}}</strong> is ready.</p>

<h2>Your Access Includes:</h2>
<ul>
  {{#each features}}
  <li>{{this}}</li>
  {{/each}}
</ul>

<p><strong>Next Flight Date:</strong> {{next_flight_date}}</p>
<p><em>Hint:</em> {{puzzle_hint}}</p>

<a href="{{dashboard_url}}" style="background: #00D9FF; color: #0A0A0A; padding: 12px 24px; text-decoration: none; border-radius: 8px;">Access Your Dashboard</a>
```

---

## Step 6: Test Email Sending

### Using SendGrid Test API
```bash
curl --request POST \
  --url https://api.sendgrid.com/v3/mail/send \
  --header 'Authorization: Bearer YOUR_API_KEY' \
  --header 'Content-Type: application/json' \
  --data '{
    "personalizations": [{
      "to": [{"email": "your.email@example.com"}],
      "dynamic_template_data": {
        "user_name": "Test User",
        "access_level": "Free Tier",
        "activation_date": "2026-02-25T10:43:00Z"
      }
    }],
    "from": {"email": "noreply@thispagedoesnotexist12345.com"},
    "template_id": "d-YOUR_TEMPLATE_ID"
  }'
```

---

## Step 7: Implement Backend (Serverless Functions)

Since you can't call SendGrid directly from the browser (API key exposure), create serverless functions:

### Netlify Functions Setup

1. Create `netlify/functions/send-email.js`:

```javascript
const sgMail = require('@sendgrid/mail');

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { templateType, toEmail, dynamicData } = JSON.parse(event.body);
    
    const templateMap = {
      'signup': process.env.TEMPLATE_SIGNUP_NOTIFICATION,
      'free_pass': process.env.TEMPLATE_BOARDING_FREE,
      'paid_pass': process.env.TEMPLATE_BOARDING_PAID,
      'birthday': process.env.TEMPLATE_BIRTHDAY,
      'sponsor_approved': process.env.TEMPLATE_SPONSORED_APPROVED,
      'sponsor_denied': process.env.TEMPLATE_SPONSORED_DENIED
    };

    const msg = {
      to: toEmail,
      from: process.env.SENDGRID_FROM_EMAIL,
      templateId: templateMap[templateType],
      dynamicTemplateData: dynamicData
    };

    await sgMail.send(msg);

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true })
    };
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message })
    };
  }
};
```

2. Install dependencies:
```bash
npm install @sendgrid/mail
```

3. Update `sendgrid-integration.js` to call your serverless function:

```javascript
async function sendEmail(templateType, toEmail, dynamicData) {
  const response = await fetch('/.netlify/functions/send-email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ templateType, toEmail, dynamicData })
  });
  return response.json();
}
```

---

## Step 8: Integrate with Your Platform

### Add to `index.html`

Add before the closing `</body>` tag:

```html
<script src="sendgrid-integration.js"></script>
```

### Trigger Emails from User Actions

Example signup form:

```html
<form id="signup-form">
  <input type="text" name="name" placeholder="Your Name" required>
  <input type="email" name="email" placeholder="Your Email" required>
  <button type="submit">Join The Journey</button>
</form>

<script>
document.getElementById('signup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const formData = new FormData(e.target);
  
  const userData = {
    name: formData.get('name'),
    email: formData.get('email'),
    source: 'Website',
    isPaid: false
  };
  
  // Store user email for puzzle tracking
  localStorage.setItem('user-email', userData.email);
  
  // Trigger signup emails
  window.dispatchEvent(new CustomEvent('user-signup', { detail: userData }));
  
  alert('Welcome aboard! Check your email for your boarding pass.');
});
</script>
```

---

## Step 9: Schedule Birthday Emails

Use GitHub Actions or a cron job service:

### GitHub Actions (`.github/workflows/birthday-check.yml`)

```yaml
name: Daily Birthday Check

on:
  schedule:
    - cron: '0 12 * * *'  # Run daily at noon UTC
  workflow_dispatch:

jobs:
  check-birthdays:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - name: Run birthday check
        run: |
          curl -X POST https://www.thispagedoesnotexist12345.com/.netlify/functions/birthday-check
```

---

## Step 10: Monitor Email Delivery

1. Go to **SendGrid Dashboard** > **Activity**
2. View delivery status, opens, clicks
3. Set up Event Webhooks for tracking:
   - Go to **Settings** > **Mail Settings** > **Event Webhook**
   - Add webhook URL: `https://www.thispagedoesnotexist12345.com/.netlify/functions/email-webhook`
   - Select events to track: Delivered, Opened, Clicked, Bounced

---

## Troubleshooting

### Emails Not Sending
- ✅ Verify API key has Mail Send permissions
- ✅ Check from email is verified in SendGrid
- ✅ Confirm template IDs are correct
- ✅ Check Netlify function logs

### Template Errors
- ✅ Validate JSON structure matches template requirements
- ✅ Test templates with sample data in SendGrid UI
- ✅ Check for missing required fields

### Domain Authentication
- Set up domain authentication in SendGrid for better deliverability
- Add DNS records for thispagedoesnotexist12345.com

---

## Next Steps

1. ✅ Configure all template IDs
2. ✅ Create serverless function for email sending
3. ✅ Add signup form to your platform
4. ✅ Test each email template
5. ✅ Set up birthday automation
6. ✅ Configure sponsorship workflow
7. ✅ Monitor delivery metrics

---

**Need Help?** Review SendGrid documentation: https://docs.sendgrid.com/
