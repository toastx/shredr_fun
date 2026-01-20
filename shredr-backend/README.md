# Shredr Backend

A Rust backend service for blob storage with WebSocket support and Helius webhook integration for Solana transaction monitoring.

## Features

- **Blob Storage**: Upload, retrieve, and delete blobs using PostgreSQL
- **HTTP API**: RESTful endpoints for blob operations
- **WebSocket**: Real-time bidirectional communication with clients (UTF-8 bytes)
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
       ├─────────► HTTP GET /api/blob/:key (Get Blob)
       │
       ├─────────► HTTP DELETE /api/blob/:key (Delete Blob)
       │
       ├─────────► HTTP GET /api/blobs (List Blobs)
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
│  │ Handler  │      │  PostgreSQL  │  │
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

Upload a file as a blob to PostgreSQL.

**Request:**
- Content-Type: `multipart/form-data`
- Body: Form field `file` containing the file to upload

**Response:**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "key": "uuid-filename.ext",
  "message": "Blob uploaded successfully"
}
```

**Example (curl):**
```bash
curl -X POST http://localhost:8000/api/blob/upload \
  -F "file=@/path/to/file.txt"
```

### 2. Get Blob
**GET** `/api/blob/:key`

Retrieve a blob from PostgreSQL.

**Parameters:**
- `key`: The blob key returned from upload

**Response:**
- Returns the raw blob data with appropriate Content-Type header

**Example (curl):**
```bash
curl -X GET http://localhost:8000/api/blob/uuid-filename.ext \
  --output downloaded-file.ext
```

### 3. Delete Blob
**DELETE** `/api/blob/:key`

Delete a blob from PostgreSQL.

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

### 4. List Blobs
**GET** `/api/blobs?limit=50&offset=0`

List all blobs with metadata (paginated).

**Query Parameters:**
- `limit`: Maximum number of results (default: 50)
- `offset`: Number of results to skip (default: 0)

**Response:**
```json
[
  {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "key": "uuid-filename.ext",
    "content_type": "text/plain",
    "size": 1024,
    "created_at": "2024-01-01T00:00:00Z",
    "updated_at": "2024-01-01T00:00:00Z"
  }
]
```

**Example (curl):**
```bash
curl -X GET "http://localhost:8000/api/blobs?limit=10&offset=0"
```

### 5. WebSocket Connection
**GET** `/ws` (WebSocket upgrade)

Establish a WebSocket connection for real-time updates. Messages are sent as UTF-8 encoded bytes.

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

### 6. Helius Webhook
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

### 7. Health Check
**GET** `/health`

Check if the server is running.

**Response:**
```
OK
```

## Setup

### Prerequisites

- Rust 1.70+
- PostgreSQL 14+
- Shuttle CLI (for deployment) or Docker

### Installation

1. Clone the repository:
```bash
git clone <repo-url>
cd shredr-backend
```

2. Set up PostgreSQL:

**Option A: Using Docker**
```bash
docker run --name shredr-postgres \
  -e POSTGRES_PASSWORD=password \
  -e POSTGRES_DB=shredr_db \
  -p 5432:5432 \
  -d postgres:14
```

**Option B: Local PostgreSQL**
```bash
createdb shredr_db
```

3. Configure Shuttle Secrets:
```bash
cp Secrets.toml.example Secrets.toml
```

Edit `Secrets.toml`:
```toml
DATABASE_URL = "postgres://username:password@localhost:5432/shredr_db"
```

4. Build and run:

**With Shuttle (recommended):**
```bash
cargo shuttle run
```

**Without Shuttle (local development):**
```bash
cargo run
```

The database schema will be automatically created on first run.

## Development

### Project Structure

```
src/
├── main.rs          # Application entry point and router setup
├── db.rs            # Database handler for PostgreSQL operations
├── routes.rs        # HTTP endpoint handlers
├── websocket.rs     # WebSocket connection handling (UTF-8 bytes)
└── webhook.rs       # Helius webhook handler
```

### Database Schema

```sql
CREATE TABLE blobs (
    id UUID PRIMARY KEY,
    key VARCHAR(255) UNIQUE NOT NULL,
    data BYTEA NOT NULL,  -- Encrypted JSON blob
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**Note:** All blobs are encrypted JSON from the frontend. No content-type tracking needed.

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
| `DATABASE_URL` | PostgreSQL connection string | Required |
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
- `404 Not Found`: Blob not found
- `500 Internal Server Error`: Server-side error (e.g., database failure)

Error responses include a JSON body:
```json
{
  "error": "Error description"
}
```

## Database Operations

### Upload Blob
- Stores encrypted blob data as BYTEA in PostgreSQL
- Automatically handles duplicates (upsert)
- All blobs are encrypted JSON from frontend
- Tracks timestamps only

### Get Blob
- Retrieves raw encrypted blob data
- Returns as application/octet-stream

### Delete Blob
- Removes blob from database
- Returns error if blob not found

### List Blobs
- Returns metadata only (not blob data)
- Supports pagination
- Includes file size and timestamps

## Performance Considerations

- **Connection Pooling**: Uses SQLx connection pool for efficient database access
- **Async I/O**: Non-blocking operations throughout
- **Binary Storage**: Efficient BYTEA storage in PostgreSQL
- **Indexed Queries**: Key and timestamp indexes for fast lookups

## License

MIT

## Contributing

Contributions are welcome! Please open an issue or submit a pull request.
