from common.database import SessionLocal
from common.landwise_models import (
    Parcel, LandwiseDocument, ChecklistItem, LegalOpinion, 
    OpinionSection, RiskFlag, AuditLog, AnalysisResult,
    Encumbrance, ConsistencyCheck, ConsistencyMismatch,
    ExtractionJob, ExtractedField, DocumentAnnotation,
    Owner, OwnershipTransfer
)

def cleanup_parcel(survey_no):
    db = SessionLocal()
    try:
        parcel = db.query(Parcel).filter_by(survey_number=survey_no).first()
        if not parcel:
            print(f"Parcel {survey_no} not found.")
            return

        p_id = parcel.id
        print(f"Cleaning up data for Parcel Survey {survey_no} (ID: {p_id})")

        # 1. Ownership & Transfers
        db.query(OwnershipTransfer).filter_by(parcel_id=p_id).delete()
        # Owners might be shared across parcels? Let's check model.
        # Typically owners are linked via OwnershipTransfer.
        # If Owner has no parcel_id, I won't delete them unless I'm sure.
        # But let's check common.landwise_models.

        # 2. Risk Flags
        db.query(RiskFlag).filter_by(parcel_id=p_id).delete()

        # 3. Encumbrances
        db.query(Encumbrance).filter_by(parcel_id=p_id).delete()

        # 4. Consistency Checks
        checks = db.query(ConsistencyCheck).filter_by(parcel_id=p_id).all()
        for c in checks:
            db.query(ConsistencyMismatch).filter_by(check_id=c.id).delete()
            db.delete(c)

        # 5. Checklist
        db.query(ChecklistItem).filter_by(parcel_id=p_id).delete()

        # 6. Opinion
        opinion = db.query(LegalOpinion).filter_by(parcel_id=p_id).first()
        if opinion:
            db.query(OpinionSection).filter_by(opinion_id=opinion.id).delete()
            db.delete(opinion)

        # 7. Analysis Results
        db.query(AnalysisResult).filter_by(parcel_id=p_id).delete()

        # 8. Documents & Related
        docs = db.query(LandwiseDocument).filter_by(parcel_id=p_id).all()
        for d in docs:
            db.query(ExtractionJob).filter_by(document_id=d.id).delete()
            db.query(ExtractedField).filter_by(document_id=d.id).delete()
            db.query(DocumentAnnotation).filter_by(document_id=d.id).delete()
            db.delete(d)

        # 9. Audit Logs
        db.query(AuditLog).filter_by(parcel_id=p_id).delete()

        # 10. The Parcel
        db.delete(parcel)

        db.commit()
        print(f"Successfully deleted all data for survey {survey_no}")

    except Exception as e:
        print(f"Error during cleanup: {e}")
        db.rollback()
    finally:
        db.close()

if __name__ == "__main__":
    cleanup_parcel("46")
