---
description: "The ideas behind shredr, from the privacy model down to the on-chain lifecycle."
icon: lightbulb
---

# Concepts

[How it works](../getting-started/how-it-works.md) gave you the tour. This section explains *why* each piece is built the way it is.

Read them in order for a full picture, or jump to whichever question you have.

<table data-view="cards">
<thead><tr><th>Page</th><th>Answers</th></tr></thead>
<tbody>
<tr><td><a href="privacy-model.md">The privacy model</a></td><td>What is hidden, from whom, and how the link between sender and receiver is broken.</td></tr>
<tr><td><a href="key-derivation.md">Key derivation</a></td><td>How one wallet signature becomes every key in the system — and why that is safe.</td></tr>
<tr><td><a href="burners-and-stealth-pdas.md">Burners and stealth PDAs</a></td><td>Why there are two accounts per payment instead of one, and which address to share.</td></tr>
<tr><td><a href="shred-lifecycle.md">The shred lifecycle</a></td><td>The four on-chain steps in detail, with the state transitions and failure modes.</td></tr>
<tr><td><a href="ephemeral-rollups.md">Ephemeral rollups</a></td><td>What MagicBlock does, why the transfer happens there, and what delegation means.</td></tr>
<tr><td><a href="relayer.md">The Kora relayer</a></td><td>Why a third party pays your fees, and why that is a privacy requirement rather than a convenience.</td></tr>
<tr><td><a href="state-sync-and-recovery.md">State sync and recovery</a></td><td>How your state survives a cleared browser, and how the server stores it without reading it.</td></tr>
</tbody>
</table>

## The one-paragraph version

shredr derives an endless supply of one-time addresses from a single wallet signature, so senders never see your real wallet. It moves the money between program-owned accounts **inside a TEE-secured rollup**, so the hop from burner to your consolidation account leaves no public trace. A relayer pays every fee, so no funding transaction ever links your wallet to a burner. And because every key is deterministic, nothing needs to be backed up — the wallet is the backup.
