use aws_sdk_s3::{primitives::ByteStream, Client};
use bytes::Bytes;
use std::sync::Arc;

#[derive(Clone)]
pub struct DbHandler {
    s3_client: Arc<Client>,
    bucket_name: String,
}

impl DbHandler {
    pub fn new(s3_client: Client, bucket_name: String) -> Self {
        Self {
            s3_client: Arc::new(s3_client),
            bucket_name,
        }
    }

    /// Upload a blob to S3
    pub async fn upload_blob(&self, key: &str, data: Bytes) -> Result<String, String> {
        let byte_stream = ByteStream::from(data);

        self.s3_client
            .put_object()
            .bucket(&self.bucket_name)
            .key(key)
            .body(byte_stream)
            .send()
            .await
            .map_err(|e| format!("Failed to upload blob: {}", e))?;

        Ok(format!("s3://{}/{}", self.bucket_name, key))
    }

    /// Delete a blob from S3
    pub async fn delete_blob(&self, key: &str) -> Result<(), String> {
        self.s3_client
            .delete_object()
            .bucket(&self.bucket_name)
            .key(key)
            .send()
            .await
            .map_err(|e| format!("Failed to delete blob: {}", e))?;

        Ok(())
    }
}
