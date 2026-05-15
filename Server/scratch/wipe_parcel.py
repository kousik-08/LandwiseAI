
import sys
import os
import shutil

# Add project root to sys.path
sys.path.append(os.getcwd())

from common.database import SessionLocal
from common.landwise_models import (
    LandwiseDocument, ExtractionJob, DocumentAnnotation, 
    Owner, OwnershipTransfer, Encumbrance, RiskFlag, 
    ConsistencyCheck, ChecklistItem, LegalOpinion, AnalysisResult
)

def wipe_parcel_data(parcel_id: str):
    db = SessionLocal()
    try:
        print(f"[*] Wiping all forensic data for parcel: {parcel_id}")
        
        # 1. Delete dependent records
        # Checklist
        db.query(ChecklistItem).filter_by(parcel_id=parcel_id).delete()
        # Risk Flags
        db.query(RiskFlag).filter_by(parcel_id=parcel_id).delete()
        # Consistency
        db.query(ConsistencyCheck).filter_by(parcel_id=parcel_id).delete()
        # Owners
        db.query(Owner).filter_by(parcel_id=parcel_id).delete()
        # Transfers
        db.query(OwnershipTransfer).filter_by(parcel_id=parcel_id).delete()
        # Encumbrances
        db.query(Encumbrance).filter_by(parcel_id=parcel_id).delete()
        # Opinions
        db.query(LegalOpinion).filter_by(parcel_id=parcel_id).delete()
        # Analysis Results
        db.query(AnalysisResult).filter_by(parcel_id=parcel_id).delete()
        
        # 2. Documents and Jobs
        docs = db.query(LandwiseDocument).filter_by(parcel_id=parcel_id).all()
        for doc in docs:
            db.query(ExtractionJob).filter_by(document_id=doc.id).delete()
            db.query(DocumentAnnotation).filter_by(document_id=doc.id).delete()
            db.delete(doc)

        print(f"[+] Deleted {len(docs)} document records and associated metadata.")
        
        # 3. Physical File Cleanup
        doc_dir = os.path.join("outputs", "documents", parcel_id)
        if os.path.exists(doc_dir):
            shutil.rmtree(doc_dir)
            print(f"[+] Removed physical document storage: {doc_dir}")
            
        # 4. Analysis output cleanup
        # We don't have the request_id easily here, but we can wipe the validate/analyze folders if we wanted.
        # But for now, DB wipe is the priority.
        
        db.commit()
        print("[***] WIPE COMPLETE. Parcel is now clean.")

    except Exception as e:
        db.rollback()
        print(f"[!] Wipe failed: {e}")
    finally:
        db.close()

if __name__ == "__main__":
    TARGET_PARCEL = "9a50f1d9-caaa-4852-85d4-20c59f33e995"
    wipe_parcel_data(TARGET_PARCEL)
