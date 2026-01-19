// Services
export { ShadowWireClient, TokenUtils } from './ShadowWireClient';
export { BurnerService, burnerService } from './BurnerService';
export { NonceService, nonceService } from './NonceService';
export { StorageService } from './StorageService';

// Legacy alias for backward compatibility
export { BurnerService as EncryptionService, burnerService as encryptionService } from './BurnerService';

// Types
export { DecryptionError } from './types';
export type { 
    // Storage types
    NonceState,
    // Nonce types
    GeneratedNonce,
    EncryptedNoncePayload,
    DerivedKeys,
    // Burner types
    BurnerKeyPair, 
    // API types
    NonceBlob,
    CreateBlobRequest,
    DecryptBlobsResult,
    ConsumeResult,
    NonceBlobAPI
} from './types';

// Constants and utils
export * from './constants';
export * from './utils';
