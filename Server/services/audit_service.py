"""
Audit Service — Append-Only Event Logging
==========================================
Wraps all state-changing operations with an immutable audit trail.
No UPDATE or DELETE permitted on audit_logs — append only.
"""

from common.database import SessionLocal
from common.landwise_models import AuditLog, gen_uuid


class AuditService:
    """Records every action in the system for compliance & traceability."""

    @staticmethod
    def log(
        db,
        *,
        action: str,
        entity_type: str,
        entity_id: str,
        parcel_id: str = None,
        project_id: str = None,
        actor_id: str = None,
        actor_ip: str = None,
        change_delta: dict = None,
        metadata: dict = None,
    ):
        """
        Write a single append-only audit log entry.
        
        Args:
            action: e.g. 'document.uploaded', 'risk.escalated', 'opinion.signed'
            entity_type: e.g. 'document', 'risk_flag', 'checklist_item', 'opinion'
            entity_id: UUID of the entity that was acted upon
            parcel_id: Parcel context (optional for project-level events)
            project_id: Project context
            actor_id: User who performed the action (None = system)
            actor_ip: IP address of the request
            change_delta: {before: {...}, after: {...}} field-level diff
            metadata: Additional context (filename, API source, etc.)
        """
        entry = AuditLog(
            id=gen_uuid(),
            parcel_id=parcel_id,
            project_id=project_id,
            entity_type=entity_type,
            entity_id=entity_id,
            action=action,
            actor_id=actor_id,
            actor_ip=actor_ip,
            change_delta=change_delta,
            metadata_json=metadata,
        )
        db.add(entry)
        # Caller is responsible for db.commit() — allows batching

    @staticmethod
    def log_status_change(
        db,
        *,
        entity_type: str,
        entity_id: str,
        old_status: str,
        new_status: str,
        parcel_id: str = None,
        project_id: str = None,
        actor_id: str = None,
    ):
        """Convenience: log a status field change with before/after delta."""
        AuditService.log(
            db,
            action=f"{entity_type}.status_changed",
            entity_type=entity_type,
            entity_id=entity_id,
            parcel_id=parcel_id,
            project_id=project_id,
            actor_id=actor_id,
            change_delta={
                "before": {"status": old_status},
                "after": {"status": new_status},
            },
        )

    @staticmethod
    def log_checklist_verdict(
        db,
        *,
        item_id: str,
        item_code: str,
        old_verdict: str,
        new_verdict: str,
        parcel_id: str,
        actor_id: str = None,
        notes: str = None,
    ):
        """Convenience: log a checklist item verdict change."""
        AuditService.log(
            db,
            action="checklist.verdict_set",
            entity_type="checklist_item",
            entity_id=item_id,
            parcel_id=parcel_id,
            actor_id=actor_id,
            change_delta={
                "before": {"verdict": old_verdict},
                "after": {"verdict": new_verdict},
            },
            metadata={
                "item_code": item_code,
                "notes": notes,
            },
        )

    @staticmethod
    def log_opinion_signed(
        db,
        *,
        opinion_id: str,
        parcel_id: str,
        verdict: str,
        actor_id: str,
        signature_hash: str,
    ):
        """Convenience: log the irreversible opinion sign event."""
        AuditService.log(
            db,
            action="opinion.signed",
            entity_type="legal_opinion",
            entity_id=opinion_id,
            parcel_id=parcel_id,
            actor_id=actor_id,
            change_delta={
                "before": {"is_locked": False},
                "after": {"is_locked": True, "verdict": verdict},
            },
            metadata={
                "signature_hash": signature_hash,
            },
        )
