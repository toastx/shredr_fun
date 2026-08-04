# Table of contents

* [shredr.fun](README.md)

## Getting started

* [Overview](getting-started/README.md)
* [How it works](getting-started/how-it-works.md)
* [Quickstart](getting-started/quickstart.md)
* [Local development](getting-started/local-development.md)
* [Glossary](getting-started/glossary.md)

## Concepts

* [Introduction](concepts/README.md)
* [The privacy model](concepts/privacy-model.md)
* [Key derivation](concepts/key-derivation.md)
* [Burners and stealth PDAs](concepts/burners-and-stealth-pdas.md)
* [The shred lifecycle](concepts/shred-lifecycle.md)
* [Ephemeral rollups](concepts/ephemeral-rollups.md)
* [The Kora relayer](concepts/relayer.md)
* [State sync and recovery](concepts/state-sync-and-recovery.md)

## Frontend

* [Overview](frontend/README.md)
* [ShredrClient](frontend/shredr-client.md)
* [NonceService](frontend/nonce-service.md)
* [BurnerService](frontend/burner-service.md)
* [ShredrProgram](frontend/shredr-program.md)
* [KoraRelayer](frontend/kora-relayer.md)
* [StorageService](frontend/storage-service.md)
* [ApiClient and WebSocketClient](frontend/api-and-websocket.md)
* [UI components and pages](frontend/ui.md)
* [Constants and configuration](frontend/configuration.md)

## On-chain program

* [Overview](program/README.md)
* [Accounts and state](program/accounts-and-state.md)
* [PDA derivation](program/pdas.md)
* [Instructions](program/instructions/README.md)
  * [InitializeAndDelegate](program/instructions/initialize-and-delegate.md)
  * [PrivateTransfer](program/instructions/private-transfer.md)
  * [CommitStealth](program/instructions/commit-stealth.md)
  * [CommitAndUndelegateStealth](program/instructions/commit-and-undelegate.md)
  * [Withdraw](program/instructions/withdraw.md)
  * [UndelegationCallback](program/instructions/undelegation-callback.md)
* [Errors](program/errors.md)
* [Building and testing](program/building-and-testing.md)

## Backend

* [Overview](backend/README.md)
* [API reference](backend/api-reference.md)
* [Database](backend/database.md)
* [Helius webhooks](backend/webhooks.md)
* [Configuration and deployment](backend/configuration.md)

## Reference

* [Security model](reference/security-model.md)
* [Troubleshooting](reference/troubleshooting.md)
* [FAQ](reference/faq.md)
