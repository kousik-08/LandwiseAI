"""
Seed Script — System User, Default Project, and Data Migration
===============================================================
1. Creates a system admin user for audit trail
2. Creates a "Legacy Import" project for migrated data
3. Migrates validation_requests → parcels
4. Seeds default checklist for each migrated parcel
"""
import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from common.database import SessionLocal, engine
from common.models import ValidationRequest, ECRecord, RiskScore
from common.landwise_models import (
    User, Project, Parcel, LandwiseDocument, ExtractedField,
    ChecklistItem, gen_uuid
)
from services.checklist_service import ChecklistService


def seed_system_user(db):
    """Create the system admin user if it doesn't exist."""
    existing = db.query(User).filter(User.email == "system@landwise.ai").first()
    if existing:
        print(f"  System user already exists: {existing.id}")
        return existing

    user = User(
        id=gen_uuid(),
        full_name="System Administrator",
        email="system@landwise.ai",
        system_role="super_admin",
        is_active=True,
    )
    db.add(user)
    db.flush()
    print(f"  Created system user: {user.id}")
    return user


def seed_default_lawyer(db):
    """Create a default legal advisor user."""
    existing = db.query(User).filter(User.email == "lawyer@landwise.ai").first()
    if existing:
        print(f"  Default lawyer already exists: {existing.id}")
        return existing

    user = User(
        id=gen_uuid(),
        full_name="Default Legal Advisor",
        email="lawyer@landwise.ai",
        system_role="legal_advisor",
        is_active=True,
    )
    db.add(user)
    db.flush()
    print(f"  Created default lawyer: {user.id}")
    return user


def seed_default_project(db, system_user):
    """Create the Legacy Import project if it doesn't exist."""
    existing = db.query(Project).filter(Project.name == "Legacy Import").first()
    if existing:
        print(f"  Legacy project already exists: {existing.id}")
        return existing

    project = Project(
        id=gen_uuid(),
        name="Legacy Import",
        description="Pre-Landwise validation data migrated to the new schema",
        state="Tamil Nadu",
        district="Unknown",
        status="active",
        created_by=system_user.id,
    )
    db.add(project)
    db.flush()
    print(f"  Created legacy project: {project.id}")
    return project


def migrate_validation_requests(db, project, system_user, lawyer):
    """Migrate each validation_request to a Parcel with extracted fields."""
    requests = db.query(ValidationRequest).all()
    if not requests:
        print("  No validation requests to migrate.")
        return

    migrated = 0
    skipped = 0

    for req in requests:
        # Skip if already migrated
        existing_parcel = db.query(Parcel).filter(
            Parcel.legacy_request_id == req.id
        ).first()
        if existing_parcel:
            skipped += 1
            continue

        # Get EC records for survey number info
        ec_records = db.query(ECRecord).filter(
            ECRecord.request_id == req.id
        ).all()

        # Extract unique survey numbers
        survey_numbers = set()
        for ec in ec_records:
            sn = getattr(ec, 'survey_number', None) or "Unknown"
            survey_numbers.add(sn)

        if not survey_numbers:
            survey_numbers = {"Unknown"}

        # Create one parcel per unique survey number
        for sn in survey_numbers:
            parcel = Parcel(
                id=gen_uuid(),
                project_id=project.id,
                survey_number=str(sn),
                district="Unknown",
                taluk="Unknown",
                village="Unknown",
                status="in_review" if req.status == "completed" else "pending",
                assigned_lawyer_id=lawyer.id,
                created_by=system_user.id,
                legacy_request_id=req.id,
            )
            db.add(parcel)
            db.flush()

            # Map risk score
            risk = db.query(RiskScore).filter(
                RiskScore.request_id == req.id
            ).first()
            if risk and hasattr(risk, 'score') and risk.score:
                try:
                    parcel.risk_score = int(float(risk.score))
                except (ValueError, TypeError):
                    parcel.risk_score = 0

            # Create a document entry for the EC PDF
            ec_path = getattr(req, 'ec_pdf_path', '') or ''
            if ec_path:
                doc = LandwiseDocument(
                    id=gen_uuid(),
                    parcel_id=parcel.id,
                    document_type='EC',
                    source='uploaded',
                    original_filename=os.path.basename(ec_path) or "ec.pdf",
                    storage_key=ec_path,
                    extraction_status='completed',
                    uploaded_by=system_user.id,
                )
                db.add(doc)
                db.flush()

                # Map EC records to extracted fields
                for ec in ec_records:
                    ec_sn = getattr(ec, 'survey_number', None) or "Unknown"
                    if ec_sn != sn:
                        continue

                    field_map = {
                        'document_number': getattr(ec, 'document_number', None),
                        'executant': getattr(ec, 'executant', None),
                        'claimant': getattr(ec, 'claimant', None),
                        'survey_number': getattr(ec, 'survey_number', None),
                        'area': getattr(ec, 'area', None),
                        'nature': getattr(ec, 'nature', None),
                        'date': getattr(ec, 'date', None),
                    }

                    for key, val in field_map.items():
                        if val:
                            field = ExtractedField(
                                id=gen_uuid(),
                                document_id=doc.id,
                                field_key=key,
                                raw_value=str(val),
                                confidence=85.0,
                            )
                            db.add(field)

            # Create default checklist for this parcel
            ChecklistService.create_default_checklist(parcel.id, db)
            migrated += 1

    print(f"  Migrated {migrated} parcels, skipped {skipped} (already migrated)")


def main():
    print("=" * 60)
    print("LandwiseAI 3.0 — Database Seed & Migration")
    print("=" * 60)

    db = SessionLocal()
    try:
        print("\n1. Seeding users...")
        system_user = seed_system_user(db)
        lawyer = seed_default_lawyer(db)

        print("\n2. Creating default project...")
        project = seed_default_project(db, system_user)

        print("\n3. Migrating validation requests...")
        migrate_validation_requests(db, project, system_user, lawyer)

        db.commit()
        print("\n" + "=" * 60)
        print("MIGRATION COMPLETE")

        # Summary
        parcel_count = db.query(Parcel).count()
        user_count = db.query(User).count()
        checklist_count = db.query(ChecklistItem).count()
        print(f"  Users: {user_count}")
        print(f"  Parcels: {parcel_count}")
        print(f"  Checklist Items: {checklist_count}")
        print("=" * 60)

    except Exception as e:
        db.rollback()
        print(f"\nERROR: {e}")
        import traceback
        traceback.print_exc()
    finally:
        db.close()


if __name__ == "__main__":
    main()
