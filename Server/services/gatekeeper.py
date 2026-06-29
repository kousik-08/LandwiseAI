"""
Gatekeeper Service — Parcel Status State Machine & Checklist Gating
====================================================================
Enforces the Landwise 10-phase gated workflow:
- Parcel status lifecycle transitions
- 5-phase checklist sequential unlocking
- Opinion tab gating (requires all checklist phases complete)
- Digital sign gating (requires all opinion sections accepted)
"""

from collections import defaultdict
from common.database import SessionLocal
from common.landwise_models import (
    Parcel, ChecklistItem, LegalOpinion, OpinionSection, RiskFlag, AuditLog,
    LandwiseDocument, AnalysisResult,
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
            blocked = sum(1 for i in items if i.verdict in ('issue', 'escalated'))

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

        Reflects ACTUAL backend progress across the five workflow phases
        the dashboard surfaces — each phase contributes up to 20 points,
        with partial credit where it makes sense:

          1. Document Ingestion       — EC + at least one Sale Deed uploaded.
          2. Data Extraction & NER    — fraction of docs with extraction_status=completed.
          3. Chain Verification       — analysis run + validation_results stored.
          4. Risk Analysis            — parcel.risk_score_data populated.
          5. Opinion Draft            — fraction of opinion sections accepted.

        Falls back gracefully when any signal is missing (0 for that phase).
        """
        parcel = db.query(Parcel).filter(Parcel.id == parcel_id).first()
        if not parcel:
            return 0

        score = 0

        # ── Phase 1: Document Ingestion (max 20) ─────────────────────────
        docs = (
            db.query(LandwiseDocument)
            .filter(
                LandwiseDocument.parcel_id == parcel_id,
                LandwiseDocument.deleted_at.is_(None),
            )
            .all()
        )
        has_ec = any(
            (d.document_type or "").upper() in ("ENCUMBRANCE_CERTIFICATE", "EC")
            for d in docs
        )
        has_deed = any(
            (d.document_type or "").upper() == "SALE_DEED" for d in docs
        )
        if has_ec and has_deed:
            score += 20
        elif has_ec or has_deed:
            score += 10

        # ── Phase 2: Data Extraction & NER (max 20) ──────────────────────
        if docs:
            extracted = sum(
                1
                for d in docs
                if (d.extraction_status or "").lower() == "completed"
            )
            score += int(20 * (extracted / len(docs)))

        # ── Phase 3: Chain Verification (max 20) ─────────────────────────
        has_analysis = bool(parcel.last_analysis_request_id)
        has_validation_rows = False
        if has_analysis:
            has_validation_rows = (
                db.query(AnalysisResult.id)
                .filter(
                    AnalysisResult.parcel_id == parcel_id,
                    AnalysisResult.result_type.in_(
                        ("validation_results", "validation_result", "ec_validation")
                    ),
                )
                .first()
                is not None
            )
        if has_analysis and has_validation_rows:
            score += 20
        elif has_analysis:
            score += 10  # analysis ran but no validation rows yet

        # ── Phase 4: Risk Analysis (max 20) ──────────────────────────────
        if parcel.risk_score_data:
            score += 20

        # ── Phase 5: Opinion Draft (max 20) ──────────────────────────────
        opinion = (
            db.query(LegalOpinion)
            .filter(LegalOpinion.parcel_id == parcel_id)
            .first()
        )
        if opinion:
            sections = (
                db.query(OpinionSection)
                .filter(OpinionSection.opinion_id == opinion.id)
                .all()
            )
            if sections:
                accepted = sum(1 for s in sections if s.is_accepted)
                score += int(20 * (accepted / len(sections)))
            else:
                # Draft exists but no sections seeded yet → small partial credit
                score += 4

        score = max(0, min(100, score))

        if parcel.completion_score != score:
            parcel.completion_score = score
            try:
                db.commit()
            except Exception:
                db.rollback()

        return score

    @staticmethod
    def compute_completion_scores_batch(parcels: list, db) -> dict:
        """
        Bulk-scoring counterpart to compute_completion_score.

        For a list-of-parcels endpoint, doing one-at-a-time scoring meant
        ~5 separate SELECTs per parcel (docs, analysis-results existence,
        opinion lookup, opinion-sections fetch). On a typical sidebar with
        10 parcels that was 50+ round-trips just for the completion bars —
        and the sidebar is the very first thing the user waits for.

        This bulk pass collapses that to FOUR queries total regardless of
        the parcel count. Same scoring logic as compute_completion_score
        (kept in sync byte-for-byte) — only the data-loading shape changes.

        Returns {parcel_id: score}. Persists changed scores in one commit.
        """
        if not parcels:
            return {}
        parcel_ids = [p.id for p in parcels]

        # 1) docs per parcel
        docs_by_parcel: dict[str, list] = defaultdict(list)
        for d in (
            db.query(LandwiseDocument)
              .filter(LandwiseDocument.parcel_id.in_(parcel_ids),
                      LandwiseDocument.deleted_at.is_(None))
              .all()
        ):
            docs_by_parcel[d.parcel_id].append(d)

        # 2) has-validation-result lookup (one row per parcel max)
        analysis_hits = {
            pid
            for (pid,) in db.query(AnalysisResult.parcel_id)
                            .filter(
                                AnalysisResult.parcel_id.in_(parcel_ids),
                                AnalysisResult.result_type.in_(
                                    ("validation_results", "validation_result", "ec_validation")
                                ),
                            )
                            .distinct()
                            .all()
        }

        # 3) opinions per parcel + 4) sections per opinion
        opinions = (
            db.query(LegalOpinion)
              .filter(LegalOpinion.parcel_id.in_(parcel_ids))
              .all()
        )
        opinion_by_parcel = {o.parcel_id: o for o in opinions}
        opinion_ids = [o.id for o in opinions]
        sections_by_opinion: dict[str, list] = defaultdict(list)
        if opinion_ids:
            for s in (
                db.query(OpinionSection)
                  .filter(OpinionSection.opinion_id.in_(opinion_ids))
                  .all()
            ):
                sections_by_opinion[s.opinion_id].append(s)

        results: dict[str, int] = {}
        dirty = False
        for p in parcels:
            score = 0
            docs = docs_by_parcel.get(p.id, [])

            # Phase 1
            has_ec = any((d.document_type or "").upper() in ("ENCUMBRANCE_CERTIFICATE", "EC") for d in docs)
            has_deed = any((d.document_type or "").upper() == "SALE_DEED" for d in docs)
            if has_ec and has_deed:
                score += 20
            elif has_ec or has_deed:
                score += 10

            # Phase 2
            if docs:
                extracted = sum(1 for d in docs if (d.extraction_status or "").lower() == "completed")
                score += int(20 * (extracted / len(docs)))

            # Phase 3
            has_analysis = bool(p.last_analysis_request_id)
            has_validation = p.id in analysis_hits
            if has_analysis and has_validation:
                score += 20
            elif has_analysis:
                score += 10

            # Phase 4
            if p.risk_score_data:
                score += 20

            # Phase 5
            op = opinion_by_parcel.get(p.id)
            if op:
                secs = sections_by_opinion.get(op.id, [])
                if secs:
                    accepted = sum(1 for s in secs if s.is_accepted)
                    score += int(20 * (accepted / len(secs)))
                else:
                    score += 4

            score = max(0, min(100, score))
            results[p.id] = score
            if p.completion_score != score:
                p.completion_score = score
                dirty = True

        if dirty:
            try:
                db.commit()
            except Exception:
                db.rollback()

        return results
