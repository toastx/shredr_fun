# Shredr Backend

A Rust backend service for blob storage with WebSocket support and Helius webhook integration for Solana transaction monitoring.

## Features

- **Blob Storage**: Upload and delete blobs using AWS S3
- **HTTP API**: RESTful endpoints for blob operations
- **WebSocket**: Real-time bidirectional communication with clients
- **Helius Webhook**: Receive and broadcast Solana transaction notifications
- **CORS Enabled**: Cross-origin requests supported

## Architecture

```
┌─────────────┐
│   Client    │
└──────┬──────┘
       │
       ├─────────► HTTP POST /api/blob/upload (Upload Blob)
       │
       ├─────────► HTTP DELETE /api/blob/:key (Delete Blob)
       │
       └─────────► WebSocket /ws (Real-time updates)
                         ▲
                         │
┌────────────────────────┴──────────────┐
│         Shredr Backend                │
│                                       │
│  ┌──────────┐      ┌──────────────┐  │
│  │ Routes   │─────►│  DB Handler  │  │
│  └──────────┘      └──────┬───────┘  │
│                           │           │
│  ┌──────────┐            ▼           │
│  │ Webhook  │      ┌──────────────┐  │
│  │ Handler  │      │   AWS S3     │  │
│  └────┬─────┘      └──────────────┘  │
│       │                               │
│       └──────► WebSocket Broadcast    │
│                                       │
└───────────────────────────────────────┘
                ▲
                │
         ┌──────┴──────┐
         │   Helius    │
         │   Webhook   │
         └─────────────┘
```

## API Endpoints

### 1. Upload Blob
**POST** `/api/blob/upload`

Upload a file as a blob to S3.

**Request:**
- Content-Type: `multipart/form-data`
- Body: Form field `file` containing the file to upload

**Response:**
```json
{
  "key": "uuid-filename.ext",
  "url": "s3://bucket-name/uuid-filename.ext"
}
```

**Example (curl):**
```bash
curl -X POST http://localhost:8000/api/blob/upload \
  -F "file=@/path/to/file.txt"
```

### 2. Delete Blob
**DELETE** `/api/blob/:key`

Delete a blob from S3.

**Parameters:**
- `key`: The blob key returned from upload

**Response:**
```json
{
  "message": "Blob deleted successfully"
}
```

**Example (curl):**
```bash
curl -X DELETE http://localhost:8000/api/blob/uuid-filename.ext
```

### 3. WebSocket Connection
**GET** `/ws` (WebSocket upgrade)

Establish a WebSocket connection for real-time updates.

**Messages Received:**
```json
{
  "type": "transaction",
  "data": { ... },
  "timestamp": "2024-01-01T00:00:00Z"
}
```

or

```json
{
  "type": "status",
  "clients_count": 5,
  "timestamp": "2024-01-01T00:00:00Z"
}
```

**Example (JavaScript):**
```javascript
const ws = new WebSocket('ws://localhost:8000/ws');

ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  console.log('Received:', message);
};

ws.onopen = () => {
  console.log('Connected to WebSocket');
};
```

### 4. Helius Webhook
**POST** `/webhook/helius`

Receive Solana transaction notifications from Helius.

**Request:**
```json
{
  // Helius webhook payload
  // Will be broadcast to all WebSocket clients
}
```

**Response:**
```json
{
  "message": "Webhook received and broadcast"
}
```

### 5. Health Check
**GET** `/health`

Check if the server is running.

**Response:**
```
OK
```

## Setup

### Prerequisites

- Rust 1.70+
- AWS Account with S3 access
- AWS credentials configured

### Installation

1. Clone the repository:
```bash
git clone <repo-url>
cd shredr-backend
```

2. Copy the example environment file:
```bash
cp .env.example .env
```

3. Configure your `.env` file with AWS credentials:
```env
AWS_ACCESS_KEY_ID=your_access_key
AWS_SECRET_ACCESS_KEY=your_secret_key
AWS_REGION=us-east-1
S3_BUCKET_NAME=your-bucket-name
```

4. Build and run:
```bash
cargo build --release
cargo run
```

Or with Shuttle:
```bash
cargo shuttle run
```

## Development

### Project Structure

```
src/
├── main.rs          # Application entry point and router setup
├── db.rs            # Database handler for S3 operations
├── routes.rs        # HTTP endpoint handlers
├── websocket.rs     # WebSocket connection handling
└── webhook.rs       # Helius webhook handler
```

### Running Tests

```bash
cargo test
```

### Code Formatting

```bash
cargo fmt
```

### Linting

```bash
cargo clippy
```

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `AWS_ACCESS_KEY_ID` | AWS access key | Required |
| `AWS_SECRET_ACCESS_KEY` | AWS secret key | Required |
| `AWS_REGION` | AWS region | `us-east-1` |
| `S3_BUCKET_NAME` | S3 bucket name | `shredr-blobs` |
| `RUST_LOG` | Logging level | `shredr_backend=debug` |

## Helius Webhook Setup

1. Go to your Helius dashboard
2. Create a new webhook
3. Set the webhook URL to: `https://your-domain.com/webhook/helius`
4. Configure the transaction types you want to monitor
5. Save the webhook

When transactions matching your criteria occur on Solana, Helius will POST to your webhook endpoint, and the data will be automatically broadcast to all connected WebSocket clients.

## WebSocket Message Types

### Transaction Message
Sent when a Solana transaction is received from Helius:
```json
{
  "type": "transaction",
  "data": {
    // Helius transaction data
  },
  "timestamp": "2024-01-01T00:00:00Z"
}
```

### Status Message
Periodic status updates:
```json
{
  "type": "status",
  "clients_count": 3,
  "timestamp": "2024-01-01T00:00:00Z"
}
```

## Error Handling

All endpoints return appropriate HTTP status codes:

- `200 OK`: Success
- `400 Bad Request`: Invalid request (e.g., no file provided)
- `500 Internal Server Error`: Server-side error (e.g., S3 failure)

Error responses include a JSON body:
```json
{
  "error": "Error description"
}
```

## License

MIT

## Contributing

Contributions are welcome! Please open an issue or submit a pull request.
