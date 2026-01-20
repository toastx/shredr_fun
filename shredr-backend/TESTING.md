# API Testing Guide

## Quick Start

### 1. Set up environment
```bash
cp .env.example .env
# Edit .env with your AWS credentials
```

### 2. Run the server
```bash
cargo shuttle run
# or
cargo run
```

### 3. Test the endpoints

## Testing Upload Blob

### Using curl
```bash
# Upload a file
curl -X POST http://localhost:8000/api/blob/upload \
  -F "file=@test.txt" \
  -v

# Expected response:
# {
#   "key": "550e8400-e29b-41d4-a716-446655440000-test.txt",
#   "url": "s3://shredr-blobs/550e8400-e29b-41d4-a716-446655440000-test.txt"
# }
```

### Using JavaScript (fetch)
```javascript
const formData = new FormData();
formData.append('file', fileInput.files[0]);

fetch('http://localhost:8000/api/blob/upload', {
  method: 'POST',
  body: formData
})
  .then(res => res.json())
  .then(data => console.log('Uploaded:', data))
  .catch(err => console.error('Error:', err));
```

### Using Python (requests)
```python
import requests

files = {'file': open('test.txt', 'rb')}
response = requests.post('http://localhost:8000/api/blob/upload', files=files)
print(response.json())
```

## Testing Delete Blob

### Using curl
```bash
# Delete a blob (replace KEY with the key from upload response)
curl -X DELETE http://localhost:8000/api/blob/KEY \
  -v

# Expected response:
# {
#   "message": "Blob deleted successfully"
# }
```

### Using JavaScript (fetch)
```javascript
const key = '550e8400-e29b-41d4-a716-446655440000-test.txt';

fetch(`http://localhost:8000/api/blob/${key}`, {
  method: 'DELETE'
})
  .then(res => res.json())
  .then(data => console.log('Deleted:', data))
  .catch(err => console.error('Error:', err));
```

## Testing WebSocket

### Using the test client
1. Open `test-client.html` in your browser
2. Click "Connect"
3. Watch for messages

### Using JavaScript
```javascript
const ws = new WebSocket('ws://localhost:8000/ws');

ws.onopen = () => {
  console.log('Connected to WebSocket');
};

ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  console.log('Received:', message);
  
  if (message.type === 'transaction') {
    console.log('Transaction data:', message.data);
  } else if (message.type === 'status') {
    console.log('Clients connected:', message.clients_count);
  }
};

ws.onerror = (error) => {
  console.error('WebSocket error:', error);
};

ws.onclose = () => {
  console.log('Disconnected');
};
```

### Using wscat (command line)
```bash
# Install wscat
npm install -g wscat

# Connect to WebSocket
wscat -c ws://localhost:8000/ws
```

## Testing Helius Webhook

### Using curl (simulate Helius webhook)
```bash
curl -X POST http://localhost:8000/webhook/helius \
  -H "Content-Type: application/json" \
  -d '{
    "signature": "5J8...",
    "slot": 123456789,
    "timestamp": 1234567890,
    "type": "TRANSFER",
    "from": "Sender...",
    "to": "Receiver...",
    "amount": 1000000
  }'

# This will broadcast to all connected WebSocket clients
```

### Using JavaScript (fetch)
```javascript
const webhookData = {
  signature: "5J8...",
  slot: 123456789,
  timestamp: Date.now(),
  type: "TRANSFER",
  from: "Sender...",
  to: "Receiver...",
  amount: 1000000
};

fetch('http://localhost:8000/webhook/helius', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json'
  },
  body: JSON.stringify(webhookData)
})
  .then(res => res.json())
  .then(data => console.log('Webhook response:', data))
  .catch(err => console.error('Error:', err));
```

## Testing Health Check

```bash
curl http://localhost:8000/health
# Expected: OK
```

## Complete Test Flow

1. **Start the server**
   ```bash
   cargo run
   ```

2. **Open WebSocket client** (in another terminal/browser)
   - Open `test-client.html` in browser
   - Or use: `wscat -c ws://localhost:8000/ws`

3. **Upload a blob**
   ```bash
   echo "Hello Shredr!" > test.txt
   curl -X POST http://localhost:8000/api/blob/upload -F "file=@test.txt"
   ```

4. **Simulate a Helius webhook**
   ```bash
   curl -X POST http://localhost:8000/webhook/helius \
     -H "Content-Type: application/json" \
     -d '{"transaction": "test", "amount": 100}'
   ```

5. **Check WebSocket client** - should see the transaction message

6. **Delete the blob**
   ```bash
   curl -X DELETE http://localhost:8000/api/blob/YOUR_KEY_HERE
   ```

## Troubleshooting

### WebSocket won't connect
- Check if server is running
- Verify the URL (ws:// not http://)
- Check CORS settings
- Look at browser console for errors

### Upload fails
- Verify AWS credentials in .env
- Check S3 bucket exists and is accessible
- Ensure file size is within limits
- Check server logs for errors

### Webhook not broadcasting
- Ensure WebSocket clients are connected first
- Check server logs for broadcast errors
- Verify JSON payload is valid

### AWS S3 errors
- Verify AWS credentials are correct
- Check IAM permissions for S3 operations
- Ensure bucket name is correct
- Check AWS region matches

## Monitoring

### View logs
```bash
RUST_LOG=debug cargo run
```

### Check connected WebSocket clients
The status messages include `clients_count` field

### Monitor S3 bucket
```bash
aws s3 ls s3://shredr-blobs/
```

## Production Checklist

- [ ] Set proper AWS credentials
- [ ] Configure S3 bucket with appropriate permissions
- [ ] Set up CORS for your frontend domain
- [ ] Configure Helius webhook URL
- [ ] Set up proper logging
- [ ] Add rate limiting
- [ ] Implement authentication
- [ ] Set up monitoring and alerts
- [ ] Configure SSL/TLS for WebSocket (wss://)
- [ ] Set up proper error handling and retries
