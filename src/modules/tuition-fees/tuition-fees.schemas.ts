import { required, schema, scope } from '../../database/schema';

export const tuitionFeesSchemas = {
  tuitionFees: schema({...scope, studentId: required,
    amount: {type: Number, required: true, min: 1, max: 1_000_000_000_000}, dueDate: required,
    status: {type: String, enum: ['unpaid', 'paid'], required: true},
    version: {type: Number, required: true, min: 1}, paidAt: Date}),
};
tuitionFeesSchemas.tuitionFees.index({workspaceId: 1, studentId: 1}, {unique: true});
tuitionFeesSchemas.tuitionFees.index({workspaceId: 1, status: 1, dueDate: 1});
