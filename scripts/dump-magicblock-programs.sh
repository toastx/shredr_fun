#!/usr/bin/env bash
#
# Vendor the MagicBlock ELFs that `shredr-program/benches/compute_units.rs` loads
# into Mollusk, so `InitializeAndDelegate` can be benched through its CPIs instead
# of skipped.
#
# The .so files are committed. The bench runs with `must_pass(true)`, so fetching
# them at bench time would turn a flaky RPC into a failed bench. Run this by hand
# when the deployed programs move.
#
# Program IDs mirror `ephemeral_rollups_pinocchio::consts::DELEGATION_PROGRAM_ID`
# and `::acl::consts::PERMISSION_PROGRAM_ID`.

set -euo pipefail

CLUSTER="${CLUSTER:-devnet}"
OUT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/shredr-program/fixtures"

DELEGATION_PROGRAM_ID="DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh"
PERMISSION_PROGRAM_ID="ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1"

mkdir -p "$OUT_DIR"

dump() {
    local program_id="$1" out_name="$2"
    echo "dumping $out_name ($program_id) from $CLUSTER"
    solana program dump "$program_id" "$OUT_DIR/$out_name" -u "$CLUSTER"
}

dump "$DELEGATION_PROGRAM_ID" delegation_program.so
dump "$PERMISSION_PROGRAM_ID" permission_program.so

echo
echo "wrote:"
ls -la "$OUT_DIR"
