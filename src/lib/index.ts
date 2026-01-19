// Services
export { ShadowWireClient, TokenUtils } from './ShadowWireClient';
export { EncryptionService, encryptionService } from './EncryptionService';
export { NonceService, nonceService } from './NonceService';
export { StorageService } from './StorageService';

// Types
export { DecryptionError } from './types';
export type { 
    // Storage types
    NonceState,
    // Nonce types
    GeneratedNonce,
    EncryptedNoncePayload,
    DerivedKeys,
    // Encryption types
    EncryptedNonce, 
    DecryptedNonce, 
    BurnerKeyPair, 
    EncryptionKeyMaterial, 
    RecoveryResult, 
    ConsumeNonceResult, 
    LocalNonceData, 
    NonceDestructionProof 
} from './types';

// Constants and utils
export * from './constants';
export * from './utils';
