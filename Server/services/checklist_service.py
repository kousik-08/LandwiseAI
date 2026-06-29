"""
Checklist Service — Default Checklist Seeding & Management
==========================================================
Creates the standard 24-item checklist (5 phases) when a parcel is registered.
Auto-populates verdicts from AI extraction results where possible.
"""

from common.landwise_models import ChecklistItem, gen_uuid


# ── Default Checklist Template ──
# Each tuple: (phase, item_code, item_label, is_mandatory)
DEFAULT_CHECKLIST = [
    # Phase 1: Documents (7 items)
    ("documents", "CHK-DOC-01", "All required document types uploaded (EC, Patta, Sale Deeds)", True),
    ("documents", "CHK-DOC-02", "EC covers minimum 30-year period", True),
    ("documents", "CHK-DOC-03", "All documents are legible (OCR confidence ≥ 70%)", True),
    ("documents", "CHK-DOC-04", "Document source verified (original/certified copy)", True),
    ("documents", "CHK-DOC-05", "Year coverage continuous (no gaps in EC)", True),
    ("documents", "CHK-DOC-06", "Sale Deed registration numbers verified against EC entries", False),
    ("documents", "CHK-DOC-07", "Power of Attorney present (if NRI owner detected)", True),

    # Phase 2: Ownership (5 items)
    ("ownership", "CHK-OWN-01", "Current owner matches Patta holder name", True),
    ("ownership", "CHK-OWN-02", "Ownership chain unbroken for 30 years", True),
    ("ownership", "CHK-OWN-03", "No ownership gap exceeding 5 years", True),
    ("ownership", "CHK-OWN-04", "HUF/Company ownership documentation adequate", False),
    ("ownership", "CHK-OWN-05", "NRI compliance verified (FEMA/RBI regulations)", True),
    ("ownership", "CHK-OWN-06", "Death Certificate of title-holder verified (inheritance)", True),
    ("ownership", "CHK-OWN-07", "Legal Heir Certificate — seller is a listed heir (inheritance)", True),
    ("ownership", "CHK-OWN-08", "Patta mutated to legal heir(s) before sale (inheritance)", False),

    # Phase 3: Encumbrances (5 items)
    ("encumbrances", "CHK-ENC-01", "All mortgages identified from EC entries", True),
    ("encumbrances", "CHK-ENC-02", "Active mortgages have NOC obtained from lender", True),
    ("encumbrances", "CHK-ENC-03", "All liens and attachments confirmed discharged", True),
    ("encumbrances", "CHK-ENC-04", "No court orders blocking property transfer", True),
    ("encumbrances", "CHK-ENC-05", "Easement rights documented and acceptable", False),

    # Phase 4: Compliance (4 items)
    ("compliance", "CHK-CMP-01", "No forest or wetland classification on survey number", True),
    ("compliance", "CHK-CMP-02", "Not in Coastal Regulation Zone (CRZ)", True),
    ("compliance", "CHK-CMP-03", "Land use conversion approved (if applicable)", False),
    ("compliance", "CHK-CMP-04", "Revenue records match survey plan/FMB sketch", True),

    # Phase 5: Final Review (3 items)
    ("final_review", "CHK-FIN-01", "All risk flags actioned (accepted / dismissed / resolved)", True),
    ("final_review", "CHK-FIN-02", "Site Manager queries (deprecated — role merged into Legal Advisor)", True),
    ("final_review", "CHK-FIN-03", "Consistency check passed or discrepancies noted with justification", True),
]


class ChecklistService:
    """Manages checklist lifecycle for parcels."""

    @staticmethod
    def create_default_checklist(parcel_id: str, db) -> list:
        """
        Seed a new parcel with the standard 24-item checklist.
        Returns the list of created ChecklistItem objects.
        Called automatically when a parcel is registered via POST /parcels.
        """
        items = []
        for phase, code, label, mandatory in DEFAULT_CHECKLIST:
            item = ChecklistItem(
                id=gen_uuid(),
                parcel_id=parcel_id,
                phase=phase,
                item_code=code,
                item_label=label,
                is_mandatory=mandatory,
                verdict='pending',
            )
            db.add(item)
            items.append(item)
        # Caller commits
        return items

    @staticmethod
    def sync_checklist(parcel_id: str, db) -> int:
        """
        Ensure the parcel has every item in DEFAULT_CHECKLIST. Seeds from scratch
        for new parcels AND backfills any items added to the template after the
        parcel was first seeded (e.g. the succession checks). Returns #added.
        """
        existing = {
            code for (code,) in db.query(ChecklistItem.item_code)
            .filter(ChecklistItem.parcel_id == parcel_id).all()
        }
        added = 0
        for phase, code, label, mandatory in DEFAULT_CHECKLIST:
            if code in existing:
                continue
            db.add(ChecklistItem(
                id=gen_uuid(), parcel_id=parcel_id, phase=phase,
                item_code=code, item_label=label, is_mandatory=mandatory,
                verdict='pending',
            ))
            added += 1
        if added:
            db.commit()
        return added

    @staticmethod
    def get_checklist_by_phase(parcel_id: str, db) -> dict:
        """
        Return checklist items grouped by phase.
        Format: { 'documents': [...], 'ownership': [...], ... }
        """
        items = db.query(ChecklistItem).filter(
            ChecklistItem.parcel_id == parcel_id
        ).order_by(ChecklistItem.item_code).all()

        grouped = {}
        for item in items:
            if item.phase not in grouped:
                grouped[item.phase] = []
            grouped[item.phase].append({
                'id': item.id,
                'item_code': item.item_code,
                'item_label': item.item_label,
                'phase': item.phase,
                'is_mandatory': item.is_mandatory,
                'verdict': item.verdict,
                'lawyer_notes': item.lawyer_notes,
                'verified_by': item.verified_by,
                'verified_at': str(item.verified_at) if item.verified_at else None,
            })

        return grouped

    @staticmethod
    def auto_populate_from_extraction(parcel_id: str, db):
        """
        Auto-SUGGEST checklist verdicts from the completed AI analysis (the EC
        extraction artifact). This wires the otherwise-manual checklist to the
        real signals the system already computes — Tamil-Nadu registry logic:

          • CHK-DOC-01  required types present (EC + Sale Deed [+ Patta])
          • CHK-DOC-02  EC covers >= 30 years (computed span of EC dates)
          • CHK-DOC-05  EC year-coverage continuous (no gap > 3 yrs)
          • CHK-OWN-02  chain spans 30 yrs with no gap > 5 yrs
          • CHK-OWN-03  no ownership gap > 5 yrs
          • CHK-ENC-01  mortgages identified from EC nature keywords
          • CHK-ENC-04  no court order / attachment in EC

        Safety / honesty rules (this is a legal product — AI suggests, human
        decides):
          • Only items still 'pending' AND not human-verified are touched —
            a human verdict is never overwritten.
          • Only set 'clear' on a real positive signal; a negative finding
            becomes 'issue' (the UI's red verdict; keeps the phase gate CLOSED).
          • Items that genuinely need external data / a doc we don't extract
            stay 'pending' with an honest reason note — never auto-cleared.
          • Every auto value is tagged '[AI-suggested]' in lawyer_notes.
        Idempotent: safe to call repeatedly (e.g. on every checklist fetch).
        """
        # Delegated to the provider/adapter framework in services/checklist_engine.
        # Every checklist item has a provider that either decides now (Tier A),
        # or returns an honest 'pending: requires X'. Tier-B (external data) and
        # Tier-C (document extraction) providers activate automatically once their
        # source is connected / document uploaded — no fabricated passes ever.
        from services.checklist_engine import run as _run_engine
        _run_engine(parcel_id, db)

    @staticmethod
    def get_phase_summary(parcel_id: str, db) -> list:
        """
        Return a compact phase summary for the right panel progress display.
        [{ phase: 'documents', total: 7, done: 5, is_unlocked: true }, ...]
        """
        from services.gatekeeper import PHASE_ORDER, GatekeeperService

        summary = []
        for phase in PHASE_ORDER:
            items = db.query(ChecklistItem).filter(
                ChecklistItem.parcel_id == parcel_id,
                ChecklistItem.phase == phase
            ).all()

            total = len(items)
            done = sum(1 for i in items if i.verdict in ('clear', 'na'))
            unlocked = GatekeeperService.is_phase_unlocked(parcel_id, phase, db)

            summary.append({
                'phase': phase,
                'phase_number': PHASE_ORDER.index(phase) + 1,
                'total': total,
                'done': done,
                'is_complete': (done == total and total > 0),
                'is_unlocked': unlocked,
            })

        return summary
