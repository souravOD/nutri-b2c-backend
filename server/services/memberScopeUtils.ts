import { AppError } from "../middleware/errorHandler.js";

export interface MemberRow {
  id: string;
  householdId: string | null;
}

export interface MemberScope {
  actorMemberId: string;
  targetMemberId: string;
  householdId: string;
}

export function resolveTargetMemberFromRows(
  actor: MemberRow | null | undefined,
  target: MemberRow | null | undefined,
  requestedMemberId?: string | null
): MemberScope {
  if (!actor) {
    throw new AppError(404, "Not Found", "Actor member not found");
  }

  if (!actor.householdId) {
    throw new AppError(422, "Unprocessable Entity", "Actor household is missing");
  }

  if (!requestedMemberId || requestedMemberId === actor.id) {
    return {
      actorMemberId: actor.id,
      targetMemberId: actor.id,
      householdId: actor.householdId,
    };
  }

  if (!target) {
    throw new AppError(404, "Not Found", "Requested member not found");
  }

  if (!target.householdId || target.householdId !== actor.householdId) {
    throw new AppError(403, "Forbidden", "Requested member is outside your household");
  }

  return {
    actorMemberId: actor.id,
    targetMemberId: target.id,
    householdId: actor.householdId,
  };
}

