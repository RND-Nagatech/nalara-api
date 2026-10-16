import type { Family, Student } from '../../database/entities';

// Positive allowlists keep teacher notes and access/version metadata private.
export function parentStudent(student: Student) {
  return {
    _id: student._id,
    name: student.name,
    grade: student.grade,
    status: student.status,
    familyId: student.familyId,
    createdAt: student.createdAt,
    updatedAt: student.updatedAt,
  };
}

export function parentFamily(family: Family) {
  return {
    id: family._id,
    name: family.name,
    parentName: family.parentName,
    parentPhone: family.parentPhone,
  };
}
