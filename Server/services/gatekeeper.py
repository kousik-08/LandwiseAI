"""
Gatekeeper Service — Parcel Status State Machine & Checklist Gating
====================================================================
Enforces the Landwise 10-phase gated workflow:
- Parcel status lifecycle transitions
- 5-phase checklist sequential unlocking
- Opinion tab gating (requires all checklist phases complete)
- Digital sign gating (requires all opinion sections accepted)
"""

from common.database import SessionLocal
from common.landwise_models import (
    Parcel, ChecklistItem, LegalOpinion, OpinionSection, RiskFlag, AuditLog
)


# ── Phase ordering for checklist gating ──
PHASE_ORDER = ['documents', 'ownership', 'encumbrances', 'compliance', 'final_review']

# ── Valid parcel status transitions ──
VALID_TRANSITIONS = {
    'pending':    ['in_review'],
    'in_review':  ['flagged', 'verified'],
    'flagged':    ['in_review'],       # escalation resolved → back to review
    'verified':   ['completed'],
    'completed':  [],                  # terminal state — no backward transitions
}


class GatekeeperService:
    """Enforces workflow rules for the Landwise Legal Advisor."""

    # ═══════════════════════════════════════
    #  PARCEL STATUS TRANSITIONS
    # ═══════════════════════════════════════

    @staticmethod
    def validate_status_transition(current_status: str, new_status: str) -> bool:
        """Check if a parcel status transition is valid."""
        allowed = VALID_TRANSITIONS.get(current_status, [])
        return new_status in allowed

    @staticmethod
    def get_allowed_transitions(current_status: str) -> list:
        """Return the list of valid next statuses."""
        return VALID_TRANSITIONS.get(current_status, [])

    @staticmethod
    def auto_update_parcel_status(parcel_id: str, db) -> str:
        """
        Automatically compute and set the correct parcel status
        based on the current state of risk_flags and checklist_items.
        Returns the new status string.
        """
        parcel = db.query(Parcel).filter(Parcel.id == parcel_id).first()
        if not parcel:
            return 'pending'

        # If opinion is signed → completed
        opinion = db.query(LegalOpinion).filter_by(parcel_id=parcel_id).first()
        if opinion and opinion.is_locked:
            if parcel.status != 'completed':
                parcel.status = 'completed'
                db.commit()
            return 'completed'

        # If any risk is escalated and not resolved → flagged
        escalated = db.query(RiskFlag).filter(
            RiskFlag.parcel_id == parcel_id,
            RiskFlag.action == 'escalated',
            RiskFlag.resolved_at.is_(None)
        ).count()
        if escalated > 0:
            if parcel.status != 'flagged':
                parcel.status = 'flagged'
                db.commit()
            return 'flagged'

        # If all checklist phases complete → verified
        if GatekeeperService.is_all_checklist_complete(parcel_id, db):
            if parcel.status not in ('verified', 'completed'):
                parcel.status = 'verified'
                db.commit()
            return 'verified'

        # Default: in_review (if has documents)
        if parcel.status == 'pending':
            doc_count = parcel.documents.count() if hasattr(parcel.documents, 'count') else 0
            if doc_count > 0:
                parcel.status = 'in_review'
                db.commit()
                return 'in_review'

        return parcel.status

    # ═══════════════════════════════════════
    #  CHECKLIST GATING
    # ═══════════════════════════════════════

    @staticmethod
    def is_phase_unlocked(parcel_id: str, target_phase: str, db) -> bool:
        """
        Check if a checklist phase is accessible.
        Phase N is unlocked only if all mandatory items in Phases 1..(N-1)
        have verdict IN ('clear', 'na').
        """
        if target_phase not in PHASE_ORDER:
            return False

        target_idx = PHASE_ORDER.index(target_phase)

        # Phase 1 (documents) is always unlocked
        if target_idx == 0:
            return True

        # Check every prior phase
        for prior_phase in PHASE_ORDER[:target_idx]:
            items = db.query(ChecklistItem).filter(
                ChecklistItem.parcel_id == parcel_id,
                ChecklistItem.phase == prior_phase,
                ChecklistItem.is_mandatory == True
            ).all()

            for item in items:
                if item.verdict not in ('clear', 'na'):
                    return False  # Blocking: unresolved mandatory item

        return True

    @staticmethod
    def is_all_checklist_complete(parcel_id: str, db) -> bool:
        """Check if ALL 5 phases are fully resolved (clear or na)."""
        mandatory_items = db.query(ChecklistItem).filter(
            ChecklistItem.parcel_id == parcel_id,
            ChecklistItem.is_mandatory == True
        ).all()

        if not mandatory_items:
            return False  # No checklist = not complete

        return all(item.verdict in ('clear', 'na') for item in mandatory_items)

    @staticmethod
    def get_checklist_progress(parcel_id: str, db) -> dict:
        """
        Return a phase-by-phase progress summary.
        Used by the frontend right panel.
        """
        result = {}
        for phase in PHASE_ORDER:
            items = db.query(ChecklistItem).filter(
                ChecklistItem.parcel_id == parcel_id,
                ChecklistItem.phase == phase
            ).all()

            total = len(items)
            done = sum(1 for i in items if i.verdict in ('clear', 'na'))
            pending = sum(1 for i in items if i.verdict == 'pending')
            blocked = sum(1 for i in items if i.verdict in ('caution', 'fail'))

            phase_idx = PHASE_ORDER.index(phase)
            unlocked = GatekeeperService.is_phase_unlocked(parcel_id, phase, db)

            result[phase] = {
                'phase_number': phase_idx + 1,
                'total': total,
                'done': done,
                'pending': pending,
                'blocked': blocked,
                'is_complete': (done == total and total > 0),
                'is_unlocked': unlocked,
            }

        return result

    # ═══════════════════════════════════════
    #  OPINION GATING
    # ═══════════════════════════════════════

    @staticmethod
    def is_opinion_unlocked(db, parcel_id: str) -> tuple[bool, str]:
        """
        Opinion drafting is unlocked if:
        1. Phase 1 (Documents) of the manual checklist is complete OR
        2. A background AI analysis has been initiated (last_analysis_request_id is set)
        
        This allows parallel workflow between AI synthesis and manual verification.
        Final signing still requires 100% completion.
        """
        parcel = db.query(Parcel).filter(Parcel.id == parcel_id).first()
        if not parcel:
            return False, "Parcel not found"
            
        if parcel.last_analysis_request_id:
            return True, "Unlocked via AI Analysis" # AI analysis is present, allow drafting
            
        if GatekeeperService.is_phase_unlocked(parcel_id, 'ownership', db):
            return True, "Unlocked via checklist progress"
            
        return False, "Complete Phase 1 (Documents) and Phase 2 (Ownership) to unlock Opinion tab."

    @staticmethod
    def is_opinion_locked(opinion: LegalOpinion) -> bool:
        """Check if an opinion is signed and locked."""
        return opinion.is_locked if opinion else False

    @staticmethod
    def can_sign_opinion(parcel_id: str, db) -> bool:
        """
        Signing requires:
        1. Opinion exists and is NOT already locked
        2. All 5 sections are accepted
        3. A verdict is set
        """
        opinion = db.query(LegalOpinion).filter_by(parcel_id=parcel_id).first()
        if not opinion or opinion.is_locked:
            return False
        if not opinion.verdict:
            return False

        sections = db.query(OpinionSection).filter_by(opinion_id=opinion.id).all()
        return len(sections) == 5 and all(s.is_accepted for s in sections)

    # ═══════════════════════════════════════
    #  COMPLETION SCORE
    # ═══════════════════════════════════════

    @staticmethod
    def compute_completion_score(parcel_id: str, db) -> int:
        """
        Compute and persist the parcel completion_score (0-100).
        Based on checklist progress across all 5 phases.
        """
        all_items = db.query(ChecklistItem).filter(
            ChecklistItem.parcel_id == parcel_id
        ).all()

        if not all_items:
            return 0

        done = sum(1 for i in all_items if i.verdict in ('clear', 'na'))
        score = int((done / len(all_items)) * 100)

        parcel = db.query(Parcel).filter(Parcel.id == parcel_id).first()
        if parcel:
            parcel.completion_score = score
            db.commit()

        return score
