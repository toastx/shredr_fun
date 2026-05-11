// Services
export { BurnerService, burnerService } from './BurnerService';
export { NonceService, nonceService } from './NonceService';
export { StorageService } from './StorageService';
export { ShredrClient, shredrClient } from './ShredrClient';
export { ApiClient, apiClient } from './ApiClient';
export { WebSocketClient, webSocketClient } from './WebSocketClient';
export { KoraRelayer, koraRelayer } from './KoraRelayer';

// On-chain program client
export {
    SHREDR_PROGRAM_ID,
    SEEDS,
    MAGIC_BLOCK_PROGRAM_ID,
    MAGIC_CONTEXT,
    PERMISSION_PROGRAM_ID,
    deriveStealthPDA,
    deriveDelegationPDAs,
    createInitializeAndDelegateInstruction,
    createPrivateTransferInstruction,
    createCommitStealthInstruction,
    createCommitAndUndelegateStealthInstruction,
    createStealthWithdrawInstruction,
    parseStealthAccount,
} from './ShredrProgram';
export type { StealthAccountData } from './ShredrProgram';

export type { SigningMode, ShredrState, PendingUtxo, UtxoStatus } from './ShredrClient';

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
    // Transaction approval
    PendingTransaction,
    // API types
    NonceBlob,
    CreateBlobRequest,
    DecryptBlobsResult,
    ConsumeResult,
    NonceBlobAPI,
    // WebSocket types
    WebSocketMessage,
    WebSocketTransactionMessage,
    WebSocketStatusMessage
} from './types';

// Constants and utils
export * from './constants';
export * from './utils';
