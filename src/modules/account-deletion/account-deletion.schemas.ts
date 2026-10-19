import { schema, required, date } from '../../database/schema';

// A minimal durable tombstone also catches late writes from pre-deletion requests.
// No name/email/phone/password/token is retained here; firebaseUid is temporary,
// and its one-way fingerprint blocks stale, already-verified identity reuse.
export const accountDeletionSchemas = {
  accountDeletions: schema({
    workspaceId: required, userId: required, requestedAt: date,
    status: {type: String, enum: ['pending', 'processing', 'completed'], default: 'pending'},
    firebaseUid: String, firebaseUidHash: String, completedAt: Date, nextAttemptAt: date,
    claimId: String, leaseUntil: Date, attempts: {type: Number, default: 0},
  }),
};
accountDeletionSchemas.accountDeletions.index({workspaceId: 1}, {unique: true});
accountDeletionSchemas.accountDeletions.index({nextAttemptAt: 1, leaseUntil: 1});
accountDeletionSchemas.accountDeletions.index({firebaseUid: 1}, {sparse: true});
accountDeletionSchemas.accountDeletions.index({firebaseUidHash: 1}, {sparse: true});
