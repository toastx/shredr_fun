// Services
export { BurnerService, burnerService } from './BurnerService';
export { NonceService, nonceService } from './NonceService';
export { StorageService } from './StorageService';
export { ShredrClient, shredrClient } from './ShredrClient';
export { ApiClient, apiClient } from './ApiClient';
export { WebSocketClient, webSocketClient } from './WebSocketClient';
export { KoraRelayer, koraRelayer } from './KoraRelayer';
export {
    KytService,
    kytService,
    KytRefusedError,
    KytUnavailableError,
    KYT_VERDICT,
    ATTESTATION_BYTES,
    toInstruction as createKytAttestationInstruction,
} from './KytService';
export type { KytAttestation } from './KytService';

// On-chain program client
export {
    SHREDR_PROGRAM_ID,
    SEEDS,
    STEALTH_ACCOUNT_LEN,
    StealthInstruction,
    MAGIC_BLOCK_PROGRAM_ID,
    MAGIC_PROGRAM_ID,
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
    getShredrErrorMessage,
    isShredrProgramError,
} from './ShredrProgram';
export type { StealthAccountData } from './ShredrProgram';

export type { SigningMode, ShredrState, PendingUtxo, UtxoStatus, ShredResult, PendingAction, ReceiptView } from './ShredrClient';

// Audit keys — per-invoice viewing keys and transferable receipts
export {
    AuditService,
    auditService,
    decodeDisclosure,
    decodeViewingKey,
    encodeDisclosure,
    encodeViewingKey,
    verifyDisclosure,
} from './AuditService';
export type { Attestation, SignedAttestation, Disclosure, ViewingKey, VerificationResult } from './AuditService';
export { readAnchor, readAnchorFromLedger, resolveAnchor } from './anchor';
export { utxoService } from './UtxoService';
export type { UtxoNote, UtxoRole, UtxoState } from './types';

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
